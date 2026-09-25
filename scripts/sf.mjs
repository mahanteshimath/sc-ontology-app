/**
 * Snowflake connection for the node scripts that are not the rebuild.
 *
 * Credential precedence matches scripts/rebuild.mjs and lib/snowflake.ts, so a script targets
 * whatever the app and the rebuild target and the three cannot disagree about which account is
 * being written to.
 *
 * rebuild.mjs keeps its own copy deliberately: it is the one script that must run when nothing
 * else in the repository is trustworthy, and importing from here would give it a dependency it
 * does not need.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import snowflake from "snowflake-sdk"
import { parse as parseToml } from "smol-toml"

// The SDK logs connection details at INFO on every run, which buries a script's own output.
snowflake.configure({ logLevel: process.env.SNOWFLAKE_LOG_LEVEL ?? "ERROR" })

export function connectionConfig() {
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

  // Both [connections.name] and legacy top-level [name] are supported, and
  // default_connection_name is sometimes a bare string rather than a table.
  const connections = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (k === "connections") {
        for (const [ck, cv] of Object.entries(v)) if (cv && typeof cv === "object") connections[ck] = cv
      } else {
        connections[k] = v
      }
    }
  }

  const wanted =
    process.env.SNOWFLAKE_CONNECTION_NAME ??
    process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME ??
    (typeof raw.default_connection_name === "string" ? raw.default_connection_name : undefined)

  const name = wanted && connections[wanted] ? wanted : Object.keys(connections)[0]
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

export function connect(application = "sc-ontology-script") {
  const cfg = connectionConfig()
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: cfg.account,
      username: cfg.username,
      password: cfg.password,
      role: cfg.role,
      warehouse: cfg.warehouse,
      application,
      clientSessionKeepAlive: true,
    })
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

export function query(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows ?? [])),
    })
  })
}
