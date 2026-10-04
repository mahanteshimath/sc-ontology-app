/**
 * Cortex Analyst parity over the governed eval set.
 *
 *   node scripts/analyst-parity.mjs [--limit N]
 *
 * For every question in GOVERNANCE.AGENT_EVAL_QUESTION, under that question's persona role with
 * secondary roles disabled, ask Cortex Analyst (via SEMANTIC.ASK_CORTEX_ANALYST) over
 * SC_ONTOLOGY_360 and grade the result:
 *
 *   answerable question   PASS when Analyst's SQL is a SEMANTIC_VIEW query whose METRICS clause
 *                         names every expected governed metric, and the SQL executes under the role.
 *   refusal question      PASS when Analyst produces no SQL (it asks for clarification or declines).
 *
 * Results land in GOVERNANCE.ANALYST_PARITY_RESULT so the /impact page and the deck read the
 * measured number rather than a claim.
 */
import { connect, query } from "./sf.mjs"

const limitArg = process.argv.indexOf("--limit")
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : null
const VIEW = "SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360"

function governed(sql) {
  const body = String(sql ?? "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "")
  if (!/^(SELECT|WITH)\b/i.test(body) || body.includes(";") || !/SEMANTIC_VIEW\s*\(/i.test(body)) return null
  return body
}

const conn = await connect("sc-ontology-analyst-parity")
await query(conn, "USE ROLE ACCOUNTADMIN")
await query(
  conn,
  `CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.ANALYST_PARITY_RESULT (
     run_at TIMESTAMP_LTZ, question_id STRING, persona_role STRING, question STRING,
     should_answer BOOLEAN, expected_metric_ids STRING, analyst_sql STRING, metrics_found STRING,
     executed BOOLEAN, status STRING, detail STRING, latency_ms NUMBER, verified_query_used STRING)
   COMMENT = 'Cortex Analyst graded against the governed eval set, per persona role. Written by scripts/analyst-parity.mjs.'`,
)

const questions = await query(
  conn,
  `SELECT question_id, persona_role, question, should_answer, expected_metric_ids
     FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_QUESTION ORDER BY question_id`,
)
const runAt = new Date().toISOString()
const subset = LIMIT ? questions.slice(0, LIMIT) : questions
let pass = 0

for (const q of subset) {
  const role = q.PERSONA_ROLE || "SC_ONTOLOGY_STEWARD"
  const expected = String(q.EXPECTED_METRIC_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const t0 = Date.now()
  let status = "FAIL", detail = "", sql = null, found = [], executed = false, vq = null
  try {
    await query(conn, `USE ROLE ${role}`)
    await query(conn, "USE SECONDARY ROLES NONE")
    const r = await query(conn, "CALL SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(?, ?)", [q.QUESTION, VIEW])
    const raw = Object.values(r[0] ?? {})[0]
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw
    if (payload?.status !== 200) throw new Error(`Analyst status ${payload?.status}: ${String(payload?.response?.message ?? "").slice(0, 200)}`)
    const content = payload?.response?.message?.content ?? []
    const block = content.find((c) => c.type === "sql")
    vq = block?.confidence?.verified_query_used?.name ?? null
    sql = block?.statement ?? null
    const stmt = governed(sql)
    // Analyst writes metrics both qualified (landed_cost.landed_cost_per_unit) and bare
    // (METRICS ppv), so take every identifier's last segment.
    found = [...String(stmt ?? "").matchAll(/\b(?:[a-z_][a-z_0-9]*\.)*([a-z_][a-z_0-9]*)\b/gi)].map((m) => m[1].toLowerCase())

    if (!q.SHOULD_ANSWER) {
      status = sql ? "FAIL" : "PASS"
      detail = sql ? "produced SQL for a question that should be refused" : "declined / asked to clarify"
    } else if (!stmt) {
      detail = sql ? "SQL not a governed SEMANTIC_VIEW query" : "no SQL produced"
    } else {
      // EXPECTED_METRIC_IDS: comma = all required, "a|b" = either is acceptable.
      const missing = expected.filter((m) => !m.split("|").some((alt) => found.includes(alt.trim())))
      await query(conn, `SELECT * FROM (${stmt}) LIMIT 1`)
      executed = true
      status = missing.length === 0 ? "PASS" : "FAIL"
      detail = missing.length === 0 ? "resolved to governed metric(s)" : `missing metric(s): ${missing.join(", ")}`
    }
  } catch (e) {
    detail = String(e?.message ?? e).slice(0, 300)
  }
  if (status === "PASS") pass++
  const ms = Date.now() - t0
  console.log(`${q.QUESTION_ID} ${role.padEnd(20)} ${status}  ${detail}  (${ms} ms)`)
  await query(conn, "USE ROLE ACCOUNTADMIN")
  await query(
    conn,
    `INSERT INTO SUPPLY_CHAIN.GOVERNANCE.ANALYST_PARITY_RESULT
       SELECT ?::TIMESTAMP_LTZ, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
    [runAt, q.QUESTION_ID, role, q.QUESTION, !!q.SHOULD_ANSWER, expected.join(","), sql,
     [...new Set(found)].join(","), executed, status, detail, ms, vq],
  )
}

console.log(`\nCortex Analyst parity: ${pass}/${subset.length} PASS (${((100 * pass) / subset.length).toFixed(1)}%)`)
conn.destroy(() => {})
