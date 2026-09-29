/**
 * Inventory every Snowflake object this project owns, in one account.
 *
 *   node scripts/inventory.mjs                       # default connection, prints a summary
 *   node scripts/inventory.mjs --json out.json       # also writes the full inventory
 *   node scripts/inventory.mjs --checksums           # adds COUNT + HASH_AGG per base table
 *   SNOWFLAKE_CONNECTION_NAME=target node scripts/inventory.mjs --json target.json
 *
 * Two inventories (source and target) are what scripts/migrate.mjs compares to prove a copy is
 * complete. Row counts come from INFORMATION_SCHEMA so they are exact for base tables.
 */
import fs from "node:fs"
import { connect, query, connectionConfig } from "./sf.mjs"

const DB = "SUPPLY_CHAIN"

/** SHOW commands scoped to the database. `kind` is the label; failures are recorded, not fatal. */
const DB_SHOWS = [
  ["SCHEMA", `SHOW SCHEMAS IN DATABASE ${DB}`],
  ["TABLE", `SHOW TABLES IN DATABASE ${DB}`],
  ["VIEW", `SHOW VIEWS IN DATABASE ${DB}`],
  ["SEMANTIC VIEW", `SHOW SEMANTIC VIEWS IN DATABASE ${DB}`],
  ["DYNAMIC TABLE", `SHOW DYNAMIC TABLES IN DATABASE ${DB}`],
  ["PROCEDURE", `SHOW USER PROCEDURES IN DATABASE ${DB}`],
  ["FUNCTION", `SHOW USER FUNCTIONS IN DATABASE ${DB}`],
  ["TASK", `SHOW TASKS IN DATABASE ${DB}`],
  ["ALERT", `SHOW ALERTS IN DATABASE ${DB}`],
  ["STAGE", `SHOW STAGES IN DATABASE ${DB}`],
  ["STREAM", `SHOW STREAMS IN DATABASE ${DB}`],
  ["PIPE", `SHOW PIPES IN DATABASE ${DB}`],
  ["SEQUENCE", `SHOW SEQUENCES IN DATABASE ${DB}`],
  ["FILE FORMAT", `SHOW FILE FORMATS IN DATABASE ${DB}`],
  ["CORTEX SEARCH SERVICE", `SHOW CORTEX SEARCH SERVICES IN DATABASE ${DB}`],
  ["MCP SERVER", `SHOW MCP SERVERS IN DATABASE ${DB}`],
  ["ROW ACCESS POLICY", `SHOW ROW ACCESS POLICIES IN DATABASE ${DB}`],
  ["MASKING POLICY", `SHOW MASKING POLICIES IN DATABASE ${DB}`],
  ["TAG", `SHOW TAGS IN DATABASE ${DB}`],
  ["ML FORECAST", `SHOW SNOWFLAKE.ML.FORECAST IN DATABASE ${DB}`],
  ["ML ANOMALY", `SHOW SNOWFLAKE.ML.ANOMALY_DETECTION IN DATABASE ${DB}`],
  // SHOW NOTEBOOKS rejects IN DATABASE on this release; the account listing is filtered below.
  ["NOTEBOOK", `SHOW NOTEBOOKS IN ACCOUNT`],
  ["STREAMLIT", `SHOW STREAMLITS IN DATABASE ${DB}`],
  ["SECRET", `SHOW SECRETS IN DATABASE ${DB}`],
  ["NETWORK RULE", `SHOW NETWORK RULES IN DATABASE ${DB}`],
  ["IMAGE REPOSITORY", `SHOW IMAGE REPOSITORIES IN DATABASE ${DB}`],
  ["SERVICE", `SHOW SERVICES IN DATABASE ${DB}`],
  ["APPLICATION SERVICE", `SHOW APPLICATION SERVICES IN DATABASE ${DB}`],
  ["AGENT", `SHOW AGENTS IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS`],
]

/** Account-level objects the project creates, filtered to its own names below. */
const ACCOUNT_SHOWS = [
  ["ROLE", `SHOW ROLES`],
  ["WAREHOUSE", `SHOW WAREHOUSES`],
  ["INTEGRATION", `SHOW INTEGRATIONS`],
  ["USER", `SHOW USERS`],
  ["COMPUTE POOL", `SHOW COMPUTE POOLS`],
]

/** An account object belongs to the project if its name matches one of these. */
const PROJECT_ACCOUNT_OBJECT = /^(SC_|SVC_|SUPPLY_CHAIN|COMPUTE_WH$)/i

const col = (r, ...names) => {
  for (const n of names) if (r[n] !== undefined && r[n] !== null) return r[n]
  return null
}

export async function inventory(conn) {
  const objects = []
  const errors = []

  for (const [kind, sql] of DB_SHOWS) {
    try {
      const rows = await query(conn, sql)
      for (const r of rows) {
        const db = col(r, "database_name") ?? (kind === "SCHEMA" ? DB : null)
        const schema = kind === "SCHEMA" ? null : col(r, "schema_name")
        const name = col(r, "name")
        if (kind === "SCHEMA" && ["INFORMATION_SCHEMA"].includes(name)) continue
        // System views vary by release and account, and are not the project's objects.
        if (col(r, "schema_name") === "INFORMATION_SCHEMA") continue
        if (kind === "NOTEBOOK" && db !== DB) continue
        // SHOW VIEWS also lists semantic views on some releases; they are inventoried separately.
        objects.push({
          kind,
          database: db,
          schema,
          name,
          // Procedures and functions overload, so the signature is part of the identity.
          signature: kind === "PROCEDURE" || kind === "FUNCTION" ? col(r, "arguments") : null,
          state: col(r, "state"),
          owner: col(r, "owner"),
        })
      }
    } catch (e) {
      errors.push({ kind, error: String(e.message ?? e).split("\n")[0] })
    }
  }

  for (const [kind, sql] of ACCOUNT_SHOWS) {
    try {
      const rows = await query(conn, sql)
      for (const r of rows) {
        const name = col(r, "name")
        if (!PROJECT_ACCOUNT_OBJECT.test(name)) continue
        objects.push({ kind, database: null, schema: null, name, signature: null, state: col(r, "state", "disabled"), owner: col(r, "owner") })
      }
    } catch (e) {
      errors.push({ kind, error: String(e.message ?? e).split("\n")[0] })
    }
  }

  // Exact row counts for base tables, so a copy can be proved row-for-row.
  const tables = await query(
    conn,
    `SELECT table_schema, table_name, table_type, row_count, bytes
       FROM ${DB}.INFORMATION_SCHEMA.TABLES
      WHERE table_schema <> 'INFORMATION_SCHEMA'
      ORDER BY 1, 2`,
  )
  const rowCounts = Object.fromEntries(
    tables
      .filter((t) => t.TABLE_TYPE === "BASE TABLE")
      .map((t) => [`${t.TABLE_SCHEMA}.${t.TABLE_NAME}`, Number(t.ROW_COUNT ?? 0)]),
  )

  return { objects, rowCounts, errors }
}

/**
 * Row count and an order-independent content hash per base table. HASH_AGG(*) is computed by the
 * same function in every account, so equal hashes on two accounts mean equal rows (to 64 bits),
 * whatever the physical file layout. `tables` are "SCHEMA.TABLE" names.
 */
export async function checksums(conn, tables) {
  const out = {}
  for (const t of tables) {
    const [schema, table] = t.split(".")
    try {
      const [r] = await query(conn, `SELECT COUNT(*) AS N, TO_VARCHAR(HASH_AGG(*)) AS H FROM ${DB}."${schema}"."${table}"`)
      out[t] = { rows: Number(r.N), hash: r.H ?? "0" }
    } catch (e) {
      out[t] = { rows: null, hash: null, error: String(e.message ?? e).split("\n")[0] }
    }
  }
  return out
}

export function key(o) {
  return [o.kind, o.database, o.schema, o.name, o.signature].filter(Boolean).join(" | ")
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("inventory.mjs")) {
  const argv = process.argv.slice(2)
  const jsonIdx = argv.indexOf("--json")
  const withHash = argv.includes("--checksums")
  const cfg = connectionConfig()
  const conn = await connect("sc-ontology-inventory")
  const inv = await inventory(conn)
  if (withHash) inv.checksums = await checksums(conn, Object.keys(inv.rowCounts))

  const byKind = {}
  for (const o of inv.objects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1
  console.log(`\n  Inventory of ${cfg.account} (${cfg.source})\n`)
  for (const [k, n] of Object.entries(byKind).sort()) console.log(`  ${k.padEnd(24)} ${n}`)
  const totalRows = Object.values(inv.rowCounts).reduce((a, b) => a + b, 0)
  console.log(`  ${"BASE TABLE ROWS".padEnd(24)} ${totalRows.toLocaleString()}`)
  if (inv.errors.length) {
    console.log("\n  Not inventoried (SHOW failed):")
    for (const e of inv.errors) console.log(`    ${e.kind}: ${e.error}`)
  }
  if (jsonIdx >= 0) {
    fs.writeFileSync(argv[jsonIdx + 1], JSON.stringify({ account: cfg.account, at: new Date().toISOString(), ...inv }, null, 2))
    console.log(`\n  Written to ${argv[jsonIdx + 1]}`)
  }
  process.exit(0)
}
