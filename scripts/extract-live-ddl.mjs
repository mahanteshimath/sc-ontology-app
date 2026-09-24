/**
 * Extract the ACTUAL deployed DDL from the live SUPPLY_CHAIN database — not the
 * sql/*.sql source files, the real definitions as they exist in the account right
 * now (post-increments, post any manual drift).
 *
 *   node scripts/extract-live-ddl.mjs
 *
 * Writes:
 *   sql/LIVE_DDL_EXTRACT.sql   — GET_DDL('DATABASE', 'SUPPLY_CHAIN', true): every
 *                                schema, table, view, semantic view, function,
 *                                procedure, task, stream, sequence, policy, etc.
 *   sql/LIVE_GRANTS.sql        — SHOW GRANTS output, as GRANT statements. Not part
 *                                of GET_DDL('DATABASE', ...) output.
 *
 * Data (DML/row contents) is deliberately not dumped — RAW.RECEIPT_LINE alone is
 * 1M+ rows (see 00c). If row-level data is actually needed, use snow CLI's
 * `snow sql -q "SELECT ..." --format csv` or SnowSQL COPY INTO an external stage.
 *
 * Auth: same priority order as scripts/rebuild.mjs — SNOWFLAKE_USER/PASSWORD env
 * vars, else ~/.snowflake/connections.toml default connection.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import snowflake from "snowflake-sdk"
import { parse as parseToml } from "smol-toml"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SQL_DIR = path.join(ROOT, "sql")
const DATABASE = "SUPPLY_CHAIN"

// --- connection (identical resolution order to scripts/rebuild.mjs) ---

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
  if (!fs.existsSync(file)) {
    throw new Error(`No credentials. Set SNOWFLAKE_USER/SNOWFLAKE_PASSWORD, or create ${file}.`)
  }
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

  const wanted =
    process.env.SNOWFLAKE_CONNECTION_NAME ??
    process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME ??
    (typeof raw.default_connection_name === "string" ? raw.default_connection_name : undefined)

  const names = Object.keys(connections)
  const name = wanted && connections[wanted] ? wanted : names[0]
  if (!name) throw new Error(`No connection found in ${file}`)

  const c = connections[name]
  return {
    account: c.account,
    username: c.user,
    password: c.password,
    role: c.role ?? "ACCOUNTADMIN",
    warehouse: c.warehouse ?? "COMPUTE_WH",
    source: `connections.toml [${name}]`,
  }
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: cfg.account,
      username: cfg.username,
      password: cfg.password,
      role: cfg.role,
      warehouse: cfg.warehouse,
      application: "sc-ontology-extract-ddl",
      clientSessionKeepAlive: true,
    })
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

function exec(conn, sqlText) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, stmt, rows) => (err ? reject(err) : resolve(rows)),
    })
  })
}

async function main() {
  const cfg = connectionConfig()
  console.log(`\n  Connecting  account=${cfg.account} user=${cfg.username} role=${cfg.role}  (${cfg.source})\n`)
  const conn = await connect(cfg)

  // --- 1. full recursive database DDL ---
  console.log(`  Fetching GET_DDL('DATABASE', '${DATABASE}', true) ...`)
  const ddlRows = await exec(conn, `SELECT GET_DDL('DATABASE', '${DATABASE}', true) AS DDL`)
  const ddl = ddlRows[0].DDL
  const ddlPath = path.join(SQL_DIR, "LIVE_DDL_EXTRACT.sql")
  fs.writeFileSync(
    ddlPath,
    `-- ============================================================================\n` +
      `-- LIVE_DDL_EXTRACT.sql — actual deployed DDL, pulled live from ${DATABASE}\n` +
      `-- via GET_DDL('DATABASE', '${DATABASE}', true) on ${new Date().toISOString()}.\n` +
      `-- This is the account's ground truth, not the sql/*.sql source files.\n` +
      `-- ============================================================================\n\n${ddl}\n`,
  )
  console.log(`  Wrote ${ddlPath}  (${ddl.length.toLocaleString()} chars)`)

  // --- 2. grants (not covered by GET_DDL('DATABASE', ...)) ---
  console.log(`  Fetching grants ...`)
  const targets = [
    { label: `DATABASE ${DATABASE}`, sql: `SHOW GRANTS ON DATABASE ${DATABASE}` },
    ...["RAW", "CANONICAL", "SEMANTIC", "GOVERNANCE", "UTIL", "APPS"].map((s) => ({
      label: `SCHEMA ${DATABASE}.${s}`,
      sql: `SHOW GRANTS ON SCHEMA ${DATABASE}.${s}`,
    })),
  ]

  const roleRows = await exec(conn, `SHOW ROLES LIKE 'SC%'`)
  const roleNames = roleRows.map((r) => r.name)
  for (const name of roleNames) {
    targets.push({ label: `ROLE ${name}`, sql: `SHOW GRANTS TO ROLE ${name}` })
    targets.push({ label: `GRANTS ON ROLE ${name}`, sql: `SHOW GRANTS ON ROLE ${name}` })
  }

  let grantsOut = `-- ============================================================================\n`
  grantsOut += `-- LIVE_GRANTS.sql — SHOW GRANTS output, pulled live on ${new Date().toISOString()}.\n`
  grantsOut += `-- Informational (SHOW output), not directly re-runnable GRANT statements.\n`
  grantsOut += `-- ============================================================================\n`

  for (const t of targets) {
    let rows
    try {
      rows = await exec(conn, t.sql)
    } catch (err) {
      grantsOut += `\n-- ${t.label}: ${t.sql}\n-- ERROR: ${err?.message ?? err}\n`
      continue
    }
    grantsOut += `\n-- ============================================================================\n-- ${t.label}\n-- ============================================================================\n`
    grantsOut += JSON.stringify(rows, null, 2) + "\n"
  }

  const grantsPath = path.join(SQL_DIR, "LIVE_GRANTS.sql")
  fs.writeFileSync(grantsPath, grantsOut)
  console.log(`  Wrote ${grantsPath}`)

  conn.destroy(() => {})
  console.log("\n  Done.\n")
}

main().catch((err) => {
  console.error(`\n  ${err?.message ?? err}\n`)
  process.exit(1)
})
