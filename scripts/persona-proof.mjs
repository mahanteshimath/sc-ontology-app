/**
 * The brief's last requirement, as one command:
 *
 *   "Demonstrate that the same metric resolves identically across personas
 *    (planning, procurement, logistics)."
 *
 *   npm run persona-proof
 *
 * For each of the four canonical metrics the brief names, every semantic-view binding in
 * GOVERNANCE.METRIC_BINDING is executed under every persona role that PERSONA_VIEW_ACCESS grants
 * it - USE ROLE <persona> + USE SECONDARY ROLES NONE, the same isolation the app uses - and the
 * result is compared with the metric's own CANONICAL_SQL on the atomic fact.
 *
 * Nothing here is hand-picked: the metrics, bindings, grants and canonical SQL all come from the
 * registry, so adding a binding or a persona adds a row to this table. Exits 1 if any value
 * differs, so it is a test, not a screenshot.
 *
 * Scope is all-history, the same scope METRIC_DRIFT_TEST uses. SC_LOGISTICS_EU is excluded on
 * purpose: its row access policy narrows the rows, so its number is SUPPOSED to differ, and
 * 91_verify_personas.sql proves that separately.
 */
import { connect, query } from "./sf.mjs"

const METRICS = ["supplier_otd_pct", "otd_pct", "fill_rate_pct", "days_of_inventory", "landed_cost_per_unit"]
const PERSONAS = ["SC_PLANNER", "SC_PROCUREMENT", "SC_LOGISTICS"]
const TOLERANCE = 1e-9

const conn = await connect("persona-proof")
const inList = (xs) => xs.map((x) => `'${x}'`).join(",")

const defs = await query(
  conn,
  `SELECT metric_id, business_name, canonical_sql FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
    WHERE metric_id IN (${inList(METRICS)})`,
)
const bindings = await query(
  conn,
  `SELECT metric_id, semantic_view, metric_reference FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
    WHERE metric_id IN (${inList(METRICS)})`,
)
const access = await query(
  conn,
  `SELECT role_name, semantic_view FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS
    WHERE role_name IN (${inList(PERSONAS)})`,
)
const granted = (role, view) => access.some((a) => a.ROLE_NAME === role && a.SEMANTIC_VIEW === view)

const results = []
for (const d of defs.sort((a, b) => METRICS.indexOf(a.METRIC_ID) - METRICS.indexOf(b.METRIC_ID))) {
  // Canonical first, as the owner, straight off the atomic fact.
  await query(conn, "USE ROLE ACCOUNTADMIN")
  const canonical = Number(Object.values((await query(conn, d.CANONICAL_SQL))[0])[0])
  const rows = []
  for (const role of PERSONAS) {
    await query(conn, `USE ROLE ${role}`)
    await query(conn, "USE SECONDARY ROLES NONE")
    for (const b of bindings.filter((x) => x.METRIC_ID === d.METRIC_ID && granted(role, x.SEMANTIC_VIEW))) {
      const r = await query(
        conn,
        `SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.${b.SEMANTIC_VIEW} METRICS ${b.METRIC_REFERENCE})`,
      )
      rows.push({ role, view: b.SEMANTIC_VIEW, value: Number(Object.values(r[0])[0]) })
    }
  }
  const identical = rows.length > 0 && rows.every((r) => Math.abs(r.value - canonical) <= TOLERANCE)
  results.push({ name: d.BUSINESS_NAME, canonical, rows, identical })
}
await query(conn, "USE ROLE ACCOUNTADMIN")

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(6))
console.log("\n  Same metric, every persona, every view it is granted - executed under that persona's role\n")
for (const r of results) {
  console.log(`  ${r.name.padEnd(28)} canonical ${fmt(r.canonical).padStart(12)}   ${r.identical ? "IDENTICAL" : "DIVERGENT"}`)
  for (const x of r.rows) console.log(`      ${x.role.padEnd(16)} via ${x.view.padEnd(16)} ${fmt(x.value).padStart(12)}`)
}
const bad = results.filter((r) => !r.identical)
const executions = results.reduce((n, r) => n + r.rows.length, 0)
console.log(
  `\n  ${results.length - bad.length}/${results.length} metrics identical across ${PERSONAS.length} personas` +
    ` (${executions} persona-scoped executions, tolerance ${TOLERANCE})\n`,
)
process.exit(bad.length === 0 ? 0 : 1)
