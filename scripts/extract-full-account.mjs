/**
 * Extract everything GET_DDL('DATABASE', 'SUPPLY_CHAIN', true) cannot see:
 *   - account-level roles + their grants to users        -> sql/LIVE_ROLES.sql
 *   - the COMPUTE_WH warehouse                            -> sql/LIVE_WAREHOUSE.sql
 *   - the SNOWFLAKE_INTELLIGENCE database (agent's home)   -> sql/LIVE_DDL_INTELLIGENCE.sql
 *   - the Cortex Agent's true live spec, as a runnable
 *     CREATE OR REPLACE AGENT ... FROM SPECIFICATION       -> sql/LIVE_AGENT.sql
 *   - the small GOVERNANCE operational tables that are
 *     NOT reproducible by rerunning sql/*.sql (drift runs,
 *     predictions, backtests, verified-query checks, ...)  -> sql/LIVE_GOVERNANCE_DATA.sql
 *
 * Deliberately NOT dumped: RAW/CANONICAL transactional data. sql/00c_raw_transactions.sql
 * generates it from ABS(HASH(i, 'salt')), not RANDOM() -- see its header -- so it is
 * bit-for-bit reproducible by rerunning `node scripts/rebuild.mjs` in a new account.
 * Dumping 7.6M rows of already-deterministic data would just be a slower, bigger copy
 * of the same generator.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import snowflake from "snowflake-sdk"
import { parse as parseToml } from "smol-toml"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SQL_DIR = path.join(ROOT, "sql")

function connectionConfig() {
  if (process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
    return {
      account: process.env.SNOWFLAKE_ACCOUNT,
      username: process.env.SNOWFLAKE_USER,
      password: process.env.SNOWFLAKE_PASSWORD,
      role: process.env.SNOWFLAKE_ROLE ?? "ACCOUNTADMIN",
      warehouse: process.env.SNOWFLAKE_WAREHOUSE ?? "COMPUTE_WH",
      source: "env",
    }
  }
  const snowDir = process.env.SNOWFLAKE_HOME ?? path.join(os.homedir(), ".snowflake")
  const file = path.join(snowDir, "connections.toml")
  if (!fs.existsSync(file)) throw new Error(`No credentials. Set SNOWFLAKE_USER/SNOWFLAKE_PASSWORD, or create ${file}.`)
  const raw = parseToml(fs.readFileSync(file, "utf8"))
  const connections = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (k === "connections") {
        for (const [ck, cv] of Object.entries(v)) {
          if (cv && typeof cv === "object") connections[ck] = cv
        }
      } else {
        connections[k] = v
      }
    }
  }
  const wanted = process.env.SNOWFLAKE_CONNECTION_NAME ?? process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME ??
    (typeof raw.default_connection_name === "string" ? raw.default_connection_name : undefined)
  const names = Object.keys(connections)
  const name = wanted && connections[wanted] ? wanted : names[0]
  if (!name) throw new Error(`No connection found in ${file}`)
  const c = connections[name]
  return {
    account: c.account, username: c.user, password: c.password,
    role: c.role ?? "ACCOUNTADMIN", warehouse: c.warehouse ?? "COMPUTE_WH",
    source: `connections.toml [${name}]`,
  }
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: cfg.account, username: cfg.username, password: cfg.password,
      role: cfg.role, warehouse: cfg.warehouse, database: "SUPPLY_CHAIN",
      application: "sc-ontology-extract-full", clientSessionKeepAlive: true,
    })
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

function exec(conn, sqlText) {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)) })
  })
}

/** Render one value as a SQL literal for a plain INSERT ... VALUES. */
function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  // snowflake-sdk returns DATE/TIMESTAMP columns as JS Date objects; toISOString()
  // is unambiguous SQL-parseable input, unlike Date's locale-formatted default.
  if (v instanceof Date) return `'${v.toISOString()}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

function rowsToInsert(fqTable, rows) {
  if (rows.length === 0) return `-- ${fqTable}: 0 rows, nothing to insert\n`
  const columns = Object.keys(rows[0])
  const values = rows.map((r) => `  (${columns.map((c) => sqlLiteral(r[c])).join(", ")})`).join(",\n")
  return `INSERT INTO ${fqTable} (${columns.join(", ")}) VALUES\n${values};\n`
}

async function main() {
  const cfg = connectionConfig()
  console.log(`\n  Connecting  account=${cfg.account} user=${cfg.username} role=${cfg.role}  (${cfg.source})\n`)
  const conn = await connect(cfg)

  // --- roles ---
  const roles = await exec(conn, `SHOW ROLES LIKE 'SC%'`)
  let rolesOut = `-- ============================================================================\n-- LIVE_ROLES.sql — live roles, pulled ${new Date().toISOString()}\n-- ============================================================================\n\nUSE ROLE ACCOUNTADMIN;\n\n`
  for (const r of roles) {
    rolesOut += `CREATE ROLE IF NOT EXISTS ${r.name}${r.comment ? `\n  COMMENT = '${r.comment.replace(/'/g, "''")}'` : ""};\n`
  }
  rolesOut += "\n-- Role -> user grants (SHOW GRANTS OF ROLE)\n"
  for (const r of roles) {
    let ofRows = []
    try { ofRows = await exec(conn, `SHOW GRANTS OF ROLE ${r.name}`) } catch { /* role may have no grants */ }
    for (const g of ofRows) {
      if (g.granted_to === "USER") rolesOut += `GRANT ROLE ${r.name} TO USER ${g.grantee_name};\n`
    }
  }
  fs.writeFileSync(path.join(SQL_DIR, "LIVE_ROLES.sql"), rolesOut)
  console.log(`  Wrote sql/LIVE_ROLES.sql  (${roles.length} roles)`)

  // --- warehouse ---
  const whRows = await exec(conn, `SELECT GET_DDL('WAREHOUSE', 'COMPUTE_WH') AS D`)
  fs.writeFileSync(
    path.join(SQL_DIR, "LIVE_WAREHOUSE.sql"),
    `-- ============================================================================\n-- LIVE_WAREHOUSE.sql — live warehouse DDL, pulled ${new Date().toISOString()}\n-- ============================================================================\n\nUSE ROLE ACCOUNTADMIN;\n\n${whRows[0].D}\n`,
  )
  console.log(`  Wrote sql/LIVE_WAREHOUSE.sql`)

  // --- SNOWFLAKE_INTELLIGENCE database DDL (agent's home schema, eval tables, file format) ---
  const siRows = await exec(conn, `SELECT GET_DDL('DATABASE', 'SNOWFLAKE_INTELLIGENCE', true) AS D`)
  fs.writeFileSync(
    path.join(SQL_DIR, "LIVE_DDL_INTELLIGENCE.sql"),
    `-- ============================================================================\n-- LIVE_DDL_INTELLIGENCE.sql — SNOWFLAKE_INTELLIGENCE database, pulled ${new Date().toISOString()}\n-- Holds the Cortex Agent's home schema. The AGENT object itself is NOT included\n-- here (GET_DDL does not support object type AGENT) — see LIVE_AGENT.sql.\n-- ============================================================================\n\n${siRows[0].D}\n`,
  )
  console.log(`  Wrote sql/LIVE_DDL_INTELLIGENCE.sql`)

  // --- true live agent spec, reconstructed as a runnable CREATE ---
  const agentRows = await exec(conn, `SHOW AGENTS IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS`)
  let agentOut = `-- ============================================================================\n-- LIVE_AGENT.sql — Cortex Agent, true live spec pulled ${new Date().toISOString()}\n-- Reconstructed from DESCRIBE AGENT's agent_spec column (JSON), so this is the\n-- account's actual behaviour right now, not sql/10_agent.sql's source text.\n-- ============================================================================\n\nUSE ROLE ACCOUNTADMIN;\nUSE DATABASE SNOWFLAKE_INTELLIGENCE;\nUSE SCHEMA AGENTS;\n\n`
  for (const a of agentRows) {
    const desc = await exec(conn, `DESCRIBE AGENT SNOWFLAKE_INTELLIGENCE.AGENTS.${a.name}`)
    const row = desc[0]
    const profile = row.profile ?? "{}"
    agentOut += `CREATE OR REPLACE AGENT ${a.name}\n`
    agentOut += `  COMMENT = '${(row.comment ?? "").replace(/'/g, "''")}'\n`
    agentOut += `  PROFILE = '${profile.replace(/'/g, "''")}'\n`
    agentOut += `  FROM SPECIFICATION\n  $$\n${row.agent_spec}\n  $$\n;\n\n`
  }
  fs.writeFileSync(path.join(SQL_DIR, "LIVE_AGENT.sql"), agentOut)
  console.log(`  Wrote sql/LIVE_AGENT.sql  (${agentRows.length} agent(s))`)

  // --- small GOVERNANCE operational tables not reproducible by rerunning sql/*.sql ---
  const opTables = [
    "AGENT_EVAL_QUESTION", "AGENT_QUESTION_LOG", "METRIC_DRIFT_ALERT_LOG",
    "METRIC_DRIFT_BASELINE", "METRIC_DRIFT_NEGATIVE_CONTROL", "METRIC_DRIFT_RESULT",
    "METRIC_PREDICTION", "PERSONA_REGION_SCOPE", "PREDICTION_BACKTEST",
    "VERIFIED_QUERY_CHECK", "VOLUME_BACKTEST_FORECAST",
  ]
  let dataOut = `-- ============================================================================\n-- LIVE_GOVERNANCE_DATA.sql — operational rows pulled ${new Date().toISOString()}\n-- These are procedure/task OUTPUT, not config: sql/00f etc. create the tables\n-- empty. Rerunning the .sql files does not repopulate them; only running\n-- METRIC_DRIFT_TEST(), PREDICT_TARGET_BREACH(), 08_prediction_layer.sql and\n-- 93_verify_verified_queries.sql does, and reruns will get new run_ids/timestamps\n-- rather than these exact historical rows. Load this file if the exact history\n-- (not just equivalent fresh runs) needs to carry over to the new account.\n-- ============================================================================\n\n`
  for (const t of opTables) {
    const rows = await exec(conn, `SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.${t}`)
    dataOut += `\n-- ${t} (${rows.length} rows)\n`
    dataOut += rowsToInsert(`SUPPLY_CHAIN.GOVERNANCE.${t}`, rows)
  }
  fs.writeFileSync(path.join(SQL_DIR, "LIVE_GOVERNANCE_DATA.sql"), dataOut)
  console.log(`  Wrote sql/LIVE_GOVERNANCE_DATA.sql`)

  conn.destroy(() => {})
  console.log("\n  Done.\n")
}

main().catch((err) => {
  console.error(`\n  ${err?.message ?? err}\n`)
  process.exit(1)
})
