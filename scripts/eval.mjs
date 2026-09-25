/**
 * Score the 60-question evaluation set against a running deployment.
 *
 *   npm run dev                       # in another shell
 *   npm run eval
 *   SMOKE_BASE=https://sc-ontology-app.vercel.app npm run eval
 *   npm run eval -- --only REFUSAL    # one category
 *   npm run eval -- --dry-run         # score nothing, just show the plan
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DRIVES HTTP RATHER THAN CALLING THE RESOLVER DIRECTLY
 *
 * The thing under test is the whole governed path, not the prompt: resolve the
 * question against the registry, validate the model's choice against
 * INFORMATION_SCHEMA, assume the persona's Snowflake role, let the row access
 * policy apply, execute. Importing the resolver would measure the easy half and
 * report it as the whole, and would not notice a persona that cannot assume its
 * role -- which is a real failure a judge is entitled to ask about.
 *
 * So each question is asked the way a browser asks it: sign in as the demo
 * account that maps to the question's persona, POST /api/ask, score the reply.
 *
 * ---------------------------------------------------------------------------
 * SEQUENTIAL ON PURPOSE
 *
 * Each turn is a Cortex model call plus a per-role Snowflake query. Running them
 * concurrently would open one connection pool per persona simultaneously and
 * measure contention rather than accuracy, and the latency figures recorded
 * alongside each result would stop meaning anything. Sixty questions at ~6s is
 * a few minutes; that is the correct trade.
 *
 * ---------------------------------------------------------------------------
 * A TRANSPORT FAILURE IS NOT A WRONG ANSWER
 *
 * A timeout, a 500 or a non-JSON body is recorded as ERRORED, counted separately
 * from FAILED, and excluded from neither. Folding infrastructure trouble into the
 * accuracy figure would let a flaky network look like a model regression, and
 * silently dropping it would let a run that mostly did not happen report 100%.
 */
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { connect, query } from "./sf.mjs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const value = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN = flag("dry-run")
const ONLY = value("only")
const LIMIT = Number(value("limit") ?? 0)

// ---------------------------------------------------------------------------
// Demo accounts, parsed rather than hard-coded.
//
// DEMO_USERS is `username:password:SC_ROLE` triples, so it already carries the
// persona mapping this script needs. Deriving it here means adding a persona to
// the deployment adds it to the evaluation with no second place to update.
// ---------------------------------------------------------------------------
function demoUsers() {
  const raw = process.env.DEMO_USERS ?? fs.readFileSync(".env.local", "utf8").match(/^DEMO_USERS=(.*)$/m)?.[1]
  if (!raw) throw new Error("No DEMO_USERS in the environment or .env.local")
  const byRole = new Map()
  for (const entry of raw.split(";")) {
    const [username, password, role] = entry.trim().split(":")
    if (username && password && role) byRole.set(role, { username, password })
  }
  return byRole
}

const USERS = demoUsers()
const cookies = new Map()

/**
 * Persona used for questions that name none.
 *
 * The eight must-refuse questions are persona-agnostic, so PERSONA_ROLE is NULL on them. They are
 * scored as the STEWARD, which holds the broadest grants: a refusal that only holds for a narrow
 * persona is not a refusal, it is an access error wearing one. Asking the most privileged role
 * makes the decline attributable to the metric catalogue rather than to a missing grant.
 */
const DEFAULT_ROLE = process.env.EVAL_DEFAULT_ROLE ?? "SC_ONTOLOGY_STEWARD"

async function cookieFor(role) {
  const key = role ?? DEFAULT_ROLE
  if (cookies.has(key)) return cookies.get(key)
  const user = USERS.get(key)
  if (!user) throw new Error(`No demo account maps to ${key}. Add one to DEMO_USERS.`)
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password }),
  })
  if (!res.ok) throw new Error(`sign-in as ${user.username} failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers.getSetCookie()[0].split(";")[0]
  cookies.set(key, cookie)
  return cookie
}

/** Order-insensitive set equality over metric ids. */
function sameIds(a, b) {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((v, i) => v === right[i])
}

/**
 * The three rules, in the order they apply. See sql/14_agent_eval_run.sql for why
 * the ambiguous case scores a confident single answer as a failure.
 */
function score(q, reply) {
  const resolved = Array.isArray(reply.metrics) ? reply.metrics.map((m) => m.metricId) : []
  const answerable = reply.answerable === true

  if (!q.shouldAnswer) {
    return answerable
      ? { passed: false, failureMode: `answered a question that must be refused (${resolved.join(", ") || "no metric"})`, resolved }
      : { passed: true, failureMode: null, resolved }
  }

  if (!q.expectedMetricIds) {
    // Ambiguous: asking is correct, and so is answering with the competing
    // metrics side by side. Quietly picking one is the failure.
    if (!answerable) return { passed: true, failureMode: null, resolved }
    if (resolved.length >= 2) return { passed: true, failureMode: null, resolved }
    return {
      passed: false,
      failureMode: `committed to ${resolved[0] ?? "one metric"} on an ambiguous question instead of asking`,
      resolved,
    }
  }

  const expected = q.expectedMetricIds.split("|").map((s) => s.trim()).filter(Boolean)
  if (!answerable) {
    return { passed: false, failureMode: `refused an answerable question: ${reply.reason ?? "no reason given"}`, resolved }
  }
  if (!sameIds(resolved, expected)) {
    return { passed: false, failureMode: `expected ${expected.join("|")}, resolved ${resolved.join("|") || "nothing"}`, resolved }
  }
  return { passed: true, failureMode: null, resolved }
}

// ---------------------------------------------------------------------------

const conn = await connect("sc-ontology-eval")

let questions = await query(
  conn,
  `SELECT question_id, category, persona_role, question, should_answer,
          expected_metric_ids, expected_tool, expected_behaviour
     FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_QUESTION
    ORDER BY question_id`,
)
questions = questions.map((r) => ({
  questionId: r.QUESTION_ID,
  category: r.CATEGORY,
  personaRole: r.PERSONA_ROLE,
  question: r.QUESTION,
  shouldAnswer: r.SHOULD_ANSWER === true,
  expectedMetricIds: r.EXPECTED_METRIC_IDS ?? null,
}))

if (ONLY) questions = questions.filter((q) => q.category === ONLY.toUpperCase())
if (LIMIT > 0) questions = questions.slice(0, LIMIT)

console.log(`Scoring ${questions.length} questions against ${BASE}\n`)
if (DRY_RUN) {
  for (const q of questions) {
    console.log(`  ${q.questionId}  ${q.category.padEnd(17)} ${q.personaRole ?? "-"}  ${q.question}`)
  }
  process.exit(0)
}

const runId = randomUUID()
const results = []

for (const q of questions) {
  const started = Date.now()
  let reply = {}
  let errored = false
  try {
    const cookie = await cookieFor(q.personaRole)
    const res = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ question: q.question, persona: q.personaRole ?? DEFAULT_ROLE, history: [] }),
    })
    reply = await res.json()
    // A 4xx/5xx with a JSON body is still the layer answering; only an
    // unparseable or transport-level failure is an ERROR.
    if (!res.ok && reply.answerable === undefined && !reply.reason) {
      errored = true
      reply = { answerable: false, reason: `HTTP ${res.status}` }
    }
  } catch (e) {
    errored = true
    reply = { answerable: false, reason: String(e.message ?? e) }
  }
  const latency = Date.now() - started

  const s = errored
    ? { passed: false, failureMode: `ERRORED: ${reply.reason}`, resolved: [] }
    : score(q, reply)

  results.push({ ...q, ...s, errored, latency, reply })

  const mark = s.passed ? "PASS" : errored ? "ERR " : "FAIL"
  console.log(
    `  ${mark}  ${q.questionId}  ${String(latency).padStart(6)}ms  ${q.category.padEnd(17)}` +
      (s.passed ? "" : ` ${s.failureMode}`),
  )
}

// --- persist ---

const passed = results.filter((r) => r.passed).length
const errors = results.filter((r) => r.errored).length
const failed = results.length - passed - errors
const latencies = results.map((r) => r.latency).sort((a, b) => a - b)
const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1))
const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0

const refusals = results.filter((r) => !r.shouldAnswer)
const ambiguous = results.filter((r) => r.shouldAnswer && !r.expectedMetricIds)
const traps = results.filter((r) => r.category === "TRAP")

for (const r of results) {
  await query(
    conn,
    `INSERT INTO SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_RESULT
       (run_id, question_id, category, persona_role, should_answer, expected_metric_ids,
        resolved_metric_ids, semantic_view_used, answerable, reason, passed, failure_mode, latency_ms)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?`,
    [
      runId,
      r.questionId,
      r.category,
      r.personaRole,
      r.shouldAnswer,
      r.expectedMetricIds,
      r.resolved.length ? r.resolved.join("|") : null,
      "SC_ONTOLOGY_360",
      r.reply.answerable === true,
      (r.reply.reason ?? "").slice(0, 500) || null,
      r.passed,
      r.failureMode ? r.failureMode.slice(0, 500) : null,
      r.latency,
    ],
  )
}

await query(
  conn,
  `INSERT INTO SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_RUN
     (run_id, run_at, target_base, resolver_model, questions, passed, failed, errored, accuracy,
      refusals_expected, refusals_correct, ambiguity_correct, traps_correct,
      mean_latency_ms, p95_latency_ms)
   SELECT ?, CURRENT_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
  [
    runId,
    BASE,
    process.env.RESOLVER_MODEL ?? "claude-sonnet-4-5",
    results.length,
    passed,
    failed,
    errors,
    results.length ? passed / results.length : 0,
    refusals.length,
    refusals.filter((r) => r.passed).length,
    ambiguous.filter((r) => r.passed).length,
    traps.filter((r) => r.passed).length,
    mean,
    p95,
  ],
)

console.log(
  `\n${passed}/${results.length} passed` +
    (failed ? `, ${failed} failed` : "") +
    (errors ? `, ${errors} errored` : "") +
    `  |  refusals ${refusals.filter((r) => r.passed).length}/${refusals.length}` +
    `  |  traps ${traps.filter((r) => r.passed).length}/${traps.length}` +
    `  |  mean ${mean}ms, p95 ${p95}ms`,
)
console.log(`run_id ${runId} — SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_AGENT_EVAL_FAILURE;`)

// A run that scored nothing is a failed run, not a perfect one.
process.exit(results.length === 0 || errors === results.length ? 1 : 0)
