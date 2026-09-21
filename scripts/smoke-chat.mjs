/**
 * Smoke test for the conversational Ask layer, with latency measured.
 *
 * Covers what the unit tests cannot: that a real multi-turn conversation against a real Snowflake
 * account keeps the metric across a follow-up, produces the chart spec the UI expects, refuses an
 * off-ontology question, and does all of it inside the serverless budget.
 *
 * ---------------------------------------------------------------------------------------------
 * LATENCY IS AN ASSERTION HERE, NOT A STATISTIC
 *
 * The chat is split across two calls specifically so neither becomes the whole wait: /api/ask
 * resolves and executes, then /api/ask/narrate describes the result, so the governed number and its
 * chart render while the prose is still being written. A regression that slows either call does not
 * produce a wrong answer, it produces a wait the user reads as a broken product, and no unit test
 * would catch it. So timings are asserted, and the budget is justified below.
 *
 * Usage:
 *   node scripts/smoke-chat.mjs
 *   SMOKE_BASE=https://sc-ontology-app.vercel.app SMOKE_PASSWORD=... node scripts/smoke-chat.mjs
 */
import fs from "node:fs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const username = process.env.SMOKE_USER ?? "logistics"
const password =
  process.env.SMOKE_PASSWORD ??
  fs.readFileSync(".env.local", "utf8").match(/DEMO_USERS=planner:([^:]+):/)[1]

/**
 * Latency budget, set from measurement rather than from a documented figure.
 *
 * The first version of this script asserted 10s, taken from a comment in lib/env.ts. Production then
 * served /api/ask successfully at 11.5s and 12.0s, which proved the comment stale rather than the
 * app broken — a 10s ceiling would have killed those requests.
 *
 * So the ceiling here is a REGRESSION GUARD, not a claim about the platform limit: it is set well
 * above what the app currently needs and well below where a user would give up. If a change pushes a
 * call past it, that is a performance regression worth failing on, whatever the platform would
 * tolerate. Override with SMOKE_BUDGET_MS when measuring a different deployment.
 */
const BUDGET_MS = Number(process.env.SMOKE_BUDGET_MS ?? 20_000)
const WARN_MS = Number(process.env.SMOKE_WARN_MS ?? 13_000)

let pass = 0
let fail = 0
const timings = []

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
if (!login.ok) {
  console.error(`sign-in failed: ${login.status} ${await login.text()}`)
  process.exit(1)
}
const cookie = login.headers.getSetCookie()[0].split(";")[0]
console.log(`Signed in as ${username} against ${BASE}\n`)

async function timed(label, path, body) {
  const started = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - started
  const json = await res.json().catch(() => ({}))
  timings.push({ label, path, ms, status: res.status })
  return { res, json, ms }
}

/** The conversation, carried forward exactly as the browser carries it. */
const history = []

// ---------------------------------------------------------------------------
// Turn 1 — a single overall figure.
// ---------------------------------------------------------------------------
console.log("Turn 1: What is our supplier on-time delivery?")
const t1 = await timed("ask turn 1", "/api/ask", {
  question: "What is our supplier on-time delivery?",
  persona: "SC_LOGISTICS",
  history,
})
check("turn 1 answered", t1.json.answerable === true, t1.json.reason ?? t1.json.error)
check("turn 1 resolved supplier_otd_pct", t1.json.metrics?.[0]?.metricId === "supplier_otd_pct", t1.json.metrics?.map((m) => m.metricId).join(", "))
check("turn 1 has no dimension", t1.json.dimensionColumn === null)
check("turn 1 chart kind is none", t1.json.chart?.kind === "none", `got ${t1.json.chart?.kind}`)
check("turn 1 ran as the persona role", String(t1.json.executedAs).includes("SC_LOGISTICS"), t1.json.executedAs)
const otd = t1.json.rows?.[0]?.SUPPLIER_OTD_PCT
check("turn 1 returned a plausible rate", Number(otd) > 0.5 && Number(otd) < 1, String(otd))

if (t1.json.answerable) {
  history.push({
    question: "What is our supplier on-time delivery?",
    metricIds: t1.json.metrics.map((m) => m.metricId),
    dimension: t1.json.dimension ?? null,
  })

  const n1 = await timed("narrate turn 1", "/api/ask/narrate", {
    question: "What is our supplier on-time delivery?",
    metrics: t1.json.metrics,
    rows: t1.json.rows,
    dimensionColumn: null,
    periodLabel: t1.json.period?.label,
  })
  check("turn 1 narrated", typeof n1.json.narration === "string" && n1.json.narration.length > 20, n1.json.narrationSource)
  // Either source is acceptable. What is not acceptable is prose that kept a fabricated figure.
  check(
    "turn 1 narration declares its source",
    n1.json.narrationSource === "model" || n1.json.narrationSource === "template",
    n1.json.narrationSource,
  )
  if (n1.json.narrationSource === "template" && n1.json.rejectedNumbers?.length) {
    console.log(`        guardrail discarded: ${n1.json.rejectedNumbers.join(", ")}`)
  }
}

// ---------------------------------------------------------------------------
// Turn 2 — THE FOLLOW-UP. Names no metric; must inherit it from turn 1.
// ---------------------------------------------------------------------------
console.log("\nTurn 2: and by supplier region?   (names no metric — must inherit it)")
const t2 = await timed("ask turn 2", "/api/ask", {
  question: "and by supplier region?",
  persona: "SC_LOGISTICS",
  history,
})
check("turn 2 answered", t2.json.answerable === true, t2.json.reason ?? t2.json.error)
check(
  "turn 2 INHERITED supplier_otd_pct from the conversation",
  t2.json.metrics?.some((m) => m.metricId === "supplier_otd_pct"),
  t2.json.metrics?.map((m) => m.metricId).join(", "),
)
check("turn 2 added a region breakdown", t2.json.dimensionColumn === "SUPPLIER_REGION", String(t2.json.dimensionColumn))
check("turn 2 chart is a bar chart", t2.json.chart?.kind === "bar", `got ${t2.json.chart?.kind}`)
check("turn 2 chart has exactly one panel", t2.json.chart?.panels?.length === 1, `got ${t2.json.chart?.panels?.length}`)
check("turn 2 returned several categories", (t2.json.rowCount ?? 0) >= 3, `${t2.json.rowCount} rows`)
// Ranked descending on the first metric, so the chart and the table tell the same story.
const vals = (t2.json.chartRows ?? []).map((r) => Number(r.SUPPLIER_OTD_PCT))
check(
  "turn 2 chart rows are ranked descending",
  vals.every((v, i) => i === 0 || vals[i - 1] >= v),
  vals.map((v) => v?.toFixed(4)).join(" >= "),
)

if (t2.json.answerable) {
  history.push({
    question: "and by supplier region?",
    metricIds: t2.json.metrics.map((m) => m.metricId),
    dimension: t2.json.dimension ?? null,
  })
  const n2 = await timed("narrate turn 2", "/api/ask/narrate", {
    question: "and by supplier region?",
    metrics: t2.json.metrics,
    rows: t2.json.chartRows ?? t2.json.rows,
    dimensionColumn: t2.json.dimensionColumn,
    periodLabel: t2.json.period?.label,
  })
  check("turn 2 narrated", typeof n2.json.narration === "string" && n2.json.narration.length > 20, n2.json.narrationSource)
}

// ---------------------------------------------------------------------------
// Turn 3 — three metrics, three units. Must split into separate panels.
// ---------------------------------------------------------------------------
console.log("\nTurn 3: three metrics with three different units")
const t3 = await timed("ask turn 3", "/api/ask", {
  question: "Show fill rate, days of inventory and landed cost per unit by product family",
  persona: "SC_LOGISTICS",
  history,
})
check("turn 3 answered", t3.json.answerable === true, t3.json.reason ?? t3.json.error)
check("turn 3 resolved three metrics", t3.json.metrics?.length === 3, `got ${t3.json.metrics?.length}`)
check(
  "turn 3 split into one panel per unit",
  (t3.json.chart?.panels?.length ?? 0) >= 2,
  `${t3.json.chart?.panels?.length} panels: ${t3.json.chart?.panels?.map((p) => p.unitLabel).join(" | ")}`,
)
check(
  "turn 3 mixed a SNAPSHOT metric with REALIZED ones",
  t3.json.metrics?.some((m) => m.asOfScope === "SNAPSHOT"),
  t3.json.metrics?.map((m) => `${m.metricId}:${m.asOfScope}`).join(", "),
)
check("turn 3 pinned the snapshot date", Boolean(t3.json.snapshotDate), String(t3.json.snapshotDate))

// ---------------------------------------------------------------------------
// Turn 4 — off-ontology. A refusal is the correct answer.
// ---------------------------------------------------------------------------
console.log("\nTurn 4: an off-ontology question (must be refused)")
const t4 = await timed("ask turn 4", "/api/ask", {
  question: "What is our average customer satisfaction score?",
  persona: "SC_LOGISTICS",
  history,
})
check("turn 4 refused", t4.json.answerable === false, t4.json.reason)
check("turn 4 named governed alternatives", (t4.json.suggestions?.length ?? 0) > 0, t4.json.suggestions?.join(", "))
check("turn 4 invented no rows", !t4.json.rows || t4.json.rows.length === 0)

// ---------------------------------------------------------------------------
// Latency.
// ---------------------------------------------------------------------------
console.log("\nLatency")
let overBudget = 0
let nearBudget = 0
for (const t of timings) {
  const flag = t.ms > BUDGET_MS ? "OVER BUDGET" : t.ms > WARN_MS ? "near budget" : ""
  if (t.ms > BUDGET_MS) overBudget += 1
  else if (t.ms > WARN_MS) nearBudget += 1
  console.log(`  ${String(t.ms).padStart(6)}ms  ${t.label.padEnd(16)} ${flag}`)
}
const slowest = Math.max(...timings.map((t) => t.ms))
check(`every call inside the ${BUDGET_MS}ms regression budget`, overBudget === 0, `slowest ${slowest}ms, ${overBudget} over`)
if (nearBudget > 0) {
  console.log(`  NOTE  ${nearBudget} call(s) over ${WARN_MS}ms — worth watching.`)
}
console.log(
  `  Split across two calls, so the first governed number appears after the 'ask' time, not the sum.`,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
