/**
 * Ask the same question of both engines and record whether they agree.
 *
 *   npm run dev            # in another shell
 *   npm run parity
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * /api/ask does not route through the Cortex Agent, for reasons set out in
 * app/api/ask/route.ts: an agent resolves permissions from the user's DEFAULT
 * role, so the per-request persona guarantee would stop holding. That is a
 * decision, but read quickly it looks like a gap — "they built an agent and then
 * didn't use it" — and the only honest way to settle it is to run both.
 *
 * The two paths share nothing except the ontology. The agent picks a DOMAIN view
 * and writes its own SQL; the application picks registered metric ids and
 * assembles SQL from the registry against the CROSS-DOMAIN view, under the
 * persona's role. Different engine, different view, different SQL. The number is
 * the same anyway — which is the entire claim of the project, demonstrated
 * rather than asserted.
 *
 * TOLERANCE IS NOT ZERO, AND THE REASON IS ARITHMETIC, NOT CHARITY. The agent
 * returns its figure through a JSON result set that carries the column's declared
 * scale; the application returns a JavaScript number. Comparing them exactly
 * would eventually fail on a representation difference rather than a definition
 * one, which is the opposite of what this measures.
 *
 * ---------------------------------------------------------------------------
 * SCOPE MUST MATCH OR THE COMPARISON IS MEANINGLESS
 *
 * The first run of this script reported supplier OTD as 0.875824 from the agent
 * and 0.871675 from the application. That gap was NOT a definition divergence,
 * and calling it one would have been the worst possible outcome: a red status on
 * a correct system, "fixed" later by loosening the tolerance until it passed.
 *
 * There are two scope differences, and they are handled differently:
 *
 *   1. REPORTING PERIOD. The application applies the selected period; an agent
 *      turn does not. Fixed by asking the application for `period: "all"`, the
 *      same scope METRIC_DRIFT_TEST deliberately runs at.
 *
 *   2. THE AS-OF RULE. sql/02_as_of_rule.sql requires realized-service metrics to
 *      exclude future-dated rows -- promised activity that has not happened yet
 *      is not measured performance. The application obeys that rule. The agent's
 *      verified query does not, because it was written against the semantic view
 *      directly. This one cannot be configured away, so it is MEASURED instead.
 *
 * So each question is scored three ways, not two: the agent, the application,
 * and the metric's own CANONICAL_SQL from the registry -- the independent
 * atomic-grain definition the drift test uses. That turns an unexplained gap
 * into an attributed one:
 *
 *   MATCH      the two engines agree within tolerance
 *   AS_OF_GAP  the agent equals CANONICAL_SQL exactly, so it is faithful to the
 *              definition, and the residual against the application is the
 *              as-of rule doing its job. Not a failure.
 *   DIVERGE    anything else. This is the one that means something is wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIRST REAL RUNS FOUND, AND WHY IT IS THE POINT
 *
 * Across repeated runs the pattern is consistent and it splits on exactly one
 * variable — whether the agent reused a VERIFIED QUERY or derived its own SQL:
 *
 *   verified query used   agent matches CANONICAL_SQL exactly, every run.
 *   SQL derived           agent returns a number matching neither the canonical
 *                         definition nor its own previous run. Customer fill
 *                         rate came back 0.973944 on one run and 0.973633 on the
 *                         next, against a canonical 0.974613.
 *
 * That is not an argument against agents. It is the argument for the governed
 * layer, measured rather than asserted: free-text to SQL is non-deterministic at
 * the third decimal place, which is invisible on a dashboard and fatal in a
 * review. The application never derives SQL — it resolves registered metric ids
 * and assembles the query from the registry — so it returns the same number
 * every time by construction.
 */
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { connect, query } from "./sf.mjs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const AGENT = "SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT"
/** Representation noise, not definition drift. See the header. */
const TOLERANCE = 1e-6

/**
 * The questions, and the persona each is asked as.
 *
 * Chosen to span four different facts, so a match cannot be explained by both
 * paths happening to read the same table. Each resolves to exactly one metric —
 * a parity check on a multi-metric answer would be comparing two lists and
 * reporting one number, which tells you less than it appears to.
 */
const QUESTIONS = [
  { question: "What is our supplier on-time delivery?", persona: "SC_PROCUREMENT", metricId: "supplier_otd_pct" },
  { question: "What is our customer fill rate?", persona: "SC_LOGISTICS", metricId: "fill_rate_pct" },
  { question: "What is our landed cost per unit?", persona: "SC_LOGISTICS", metricId: "landed_cost_per_unit" },
  // Phrased with the snapshot named. Asked as "how many days of inventory are we
  // holding?", the agent answered in prose without executing SQL, because a
  // balance with no date named has no single correct row set — the same
  // ambiguity AGENT_EVAL_QUESTION Q27 exists to catch.
  {
    question: "What is our days of inventory at the most recent snapshot date?",
    persona: "SC_PLANNER",
    metricId: "days_of_inventory",
  },
]

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
async function cookieFor(role) {
  if (cookies.has(role)) return cookies.get(role)
  const u = USERS.get(role)
  if (!u) throw new Error(`No demo account maps to ${role}`)
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u.username, password: u.password }),
  })
  if (!res.ok) throw new Error(`sign-in as ${u.username} failed: ${res.status}`)
  const cookie = res.headers.getSetCookie()[0].split(";")[0]
  cookies.set(role, cookie)
  return cookie
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * Numeric or null, never NaN.
 *
 * Number(undefined) is NaN, and binding NaN to a FLOAT column fails the whole
 * INSERT with "Numeric value 'null' is not recognized" — so one agent turn that
 * answered in prose destroyed the record of the three that had not.
 */
const finite = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Run one turn through the Cortex Agent.
 *
 * Both arguments must be SQL literals: DATA_AGENT_RUN rejects a bind with
 * "needs to be constant", so the payload is escaped and inlined. It is built
 * from a JSON.stringify of our own object rather than assembled by hand, so the
 * only thing reaching the quoting layer is well-formed JSON.
 */
async function askAgent(conn, question) {
  const payload = JSON.stringify({
    messages: [{ role: "user", content: [{ type: "text", text: question }] }],
  })
  const started = Date.now()
  const rows = await query(conn, `SELECT SNOWFLAKE.CORTEX.DATA_AGENT_RUN(${lit(AGENT)}, ${lit(payload)}) AS R`)
  const latency = Date.now() - started
  const raw = rows[0]?.R
  const body = typeof raw === "string" ? JSON.parse(raw) : raw

  // The answer is inside a tool_result block, not the prose: the prose is a
  // rendering of the number and rounds it. An agent turn may carry several tool
  // results, so take the first that actually produced a result set rather than
  // assuming there is exactly one.
  const json = (body?.content ?? [])
    .filter((c) => c.type === "tool_result")
    .flatMap((c) => c.tool_result?.content ?? [])
    .filter((c) => c.type === "json")
    .map((c) => c.json)
    .find((j) => j?.result_set?.data?.[0]?.[0] !== undefined)

  const cell = json?.result_set?.data?.[0]?.[0]
  return {
    value: finite(cell),
    sql: json?.sql ?? null,
    semanticView: json?.semantic_model_path ?? null,
    verifiedQuery: json?.verified_query_used === true,
    latency,
    // Kept so an ERROR row can say WHY nothing came back rather than just "null".
    prose: (body?.content ?? []).find((c) => c.type === "text")?.text ?? null,
  }
}

/** Run the same question through the governed application path, as the persona. */
async function askApp(q) {
  const cookie = await cookieFor(q.persona)
  const started = Date.now()
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    // All history: the same scope the agent runs at, and the same scope
    // METRIC_DRIFT_TEST uses. See the header.
    body: JSON.stringify({ question: q.question, persona: q.persona, period: "all", history: [] }),
  })
  const latency = Date.now() - started
  const body = await res.json()
  const row = body.rows?.[0] ?? {}
  // The metric column is the metric id upper-cased; fall back to the first
  // numeric value rather than reporting null for a naming difference.
  const direct = row[q.metricId.toUpperCase()]
  const value =
    direct !== undefined ? finite(direct) : (Object.values(row).map(finite).find((v) => v !== null) ?? null)
  return { value, executedAs: body.executedAs ?? null, answerable: body.answerable === true, reason: body.reason ?? null, latency }
}

// ---------------------------------------------------------------------------

const conn = await connect("sc-ontology-parity")
const runId = randomUUID()
console.log(`Parity run against ${BASE} and ${AGENT}\n`)

// The registry's independent atomic-grain definition of each metric. Same SQL
// METRIC_DRIFT_TEST evaluates, so "faithful to the definition" means the same
// thing here as it does on /metrics.
const canonicalSql = new Map(
  (
    await query(
      conn,
      `SELECT metric_id, canonical_sql FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
        WHERE metric_id IN (${QUESTIONS.map(() => "?").join(",")})`,
      QUESTIONS.map((q) => q.metricId),
    )
  ).map((r) => [r.METRIC_ID, r.CANONICAL_SQL]),
)

let diverged = 0
for (const q of QUESTIONS) {
  let agent = {}
  let app = {}
  let canonical = null
  let status = "MATCH"
  let detail = ""
  let spread = null

  try {
    // Sequential: the agent turn and the app turn both consume the warehouse,
    // and running them together would measure contention rather than agreement.
    agent = await askAgent(conn, q.question)
    app = await askApp(q)

    const csql = canonicalSql.get(q.metricId)
    if (csql) {
      const rows = await query(conn, csql)
      canonical = finite(Object.values(rows[0] ?? {})[0])
    }

    if (agent.value === null || app.value === null || !app.answerable) {
      status = "ERROR"
      detail = `agent=${agent.value ?? "no result set"} app=${app.value ?? "no value"} | ${app.reason ?? agent.prose ?? ""}`.trim()
    } else {
      spread = Math.abs(agent.value - app.value)
      const agentFaithful = canonical !== null && Math.abs(agent.value - canonical) <= TOLERANCE
      if (spread <= TOLERANCE) {
        status = "MATCH"
        detail =
          `both ${agent.value} | agent via ${agent.semanticView}` +
          (agent.verifiedQuery ? " (verified query)" : " (derived SQL)") +
          ` | app via SC_ONTOLOGY_360 as ${q.persona}`
      } else if (agentFaithful) {
        status = "AS_OF_GAP"
        detail =
          `agent ${agent.value} equals CANONICAL_SQL exactly, so the definition is shared. ` +
          `App ${app.value} is the same definition with the governed as-of rule applied, ` +
          `which excludes future-dated rows. Residual ${spread.toFixed(6)} is that rule, not drift.`
      } else {
        status = "DIVERGE"
        detail =
          `agent ${agent.value}, app ${app.value}, canonical ${canonical}. ` +
          (agent.verifiedQuery
            ? "The agent reused a verified query and still missed the canonical definition — the stored query is wrong."
            : "The agent DERIVED its own SQL rather than reusing a verified query, and landed on a number the registry does not recognise. The application cannot do this: it never writes SQL.")
      }
    }
  } catch (e) {
    status = "ERROR"
    detail = String(e.message ?? e)
  }

  if (status === "DIVERGE" || status === "ERROR") diverged += 1
  console.log(`  ${status.padEnd(10)} ${q.metricId.padEnd(22)} spread ${spread ?? "-"}`)
  console.log(`             ${detail}`)

  await query(
    conn,
    `INSERT INTO SUPPLY_CHAIN.GOVERNANCE.AGENT_PARITY_RESULT
       (run_id, run_at, question, metric_id, agent_value, agent_semantic_view, agent_sql,
        agent_verified_query, agent_latency_ms, app_value, app_semantic_view, app_persona,
        app_latency_ms, canonical_value, spread, status, detail)
     SELECT ?, CURRENT_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
    [
      runId,
      q.question,
      q.metricId,
      agent.value ?? null,
      agent.semanticView ?? null,
      agent.sql ? agent.sql.slice(0, 2000) : null,
      agent.verifiedQuery ?? null,
      agent.latency ?? null,
      app.value ?? null,
      "SC_ONTOLOGY_360",
      q.persona,
      app.latency ?? null,
      canonical,
      spread,
      status,
      detail.slice(0, 1000),
    ],
  )
}

console.log(
  `\n${QUESTIONS.length - diverged}/${QUESTIONS.length} reconciled` +
    `  |  SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_AGENT_PARITY_LATEST;`,
)
process.exit(diverged === 0 ? 0 : 1)
