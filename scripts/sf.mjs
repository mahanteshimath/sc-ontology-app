/**
 * Snowflake connection for the node scripts that are not the rebuild.
 *
 * Credential precedence matches scripts/rebuild.mjs and lib/snowflake.ts, so a script targets
 * whatever the app and the rebuild target and the three cannot disagree about which account is
 * being written to.
 *
 * connectNamed() is the exception: scripts/migrate.mjs talks to two accounts at once, so it names
 * each connection explicitly and ignores the env credentials.
 *
 * rebuild.mjs imports from here too, which is why this file depends on nothing but snowflake-sdk
 * and smol-toml: the rebuild must run when nothing else in the repository is trustworthy.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import snowflake from "snowflake-sdk"
import { parse as parseToml } from "smol-toml"

// The SDK logs connection details at INFO on every run, which buries a script's own output.
snowflake.configure({ logLevel: process.env.SNOWFLAKE_LOG_LEVEL ?? "ERROR" })

export function connectionConfig(named) {
  if (!named && process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
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

  if (named && !connections[named]) {
    throw new Error(
      `No connection [${named}] in ${file}. Known: ${Object.keys(connections).join(", ") || "none"}. ` +
        "Add it with `snow connection add` (or edit the file) - never paste the password into chat.",
    )
  }

  const wanted =
    named ??
    process.env.SNOWFLAKE_CONNECTION_NAME ??
    process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME ??
    (typeof raw.default_connection_name === "string" ? raw.default_connection_name : undefined)

  const name = wanted && connections[wanted] ? wanted : Object.keys(connections)[0]
  if (!name) throw new Error(`No connection found in ${file}`)

  const c = connections[name]
  return {
    account: c.account,
    username: c.user,
    password: c.password ?? c.token,
    authenticator: c.authenticator,
    privateKeyPath: c.private_key_file ?? c.private_key_path,
    privateKeyPass: c.private_key_file_pwd ?? c.private_key_passphrase,
    // An empty string in connections.toml means "not set", not "no role".
    role: c.role || "ACCOUNTADMIN",
    warehouse: c.warehouse || "COMPUTE_WH",
    name,
    source: `connections.toml [${name}]`,
  }
}

/** SDK options for a config, covering password, PAT, key-pair and browser SSO connections. */
export function sdkOptions(cfg, application) {
  const auth = String(cfg.authenticator ?? "").toUpperCase()
  const o = {
    account: cfg.account,
    username: cfg.username,
    role: cfg.role,
    warehouse: cfg.warehouse,
    application,
    clientSessionKeepAlive: true,
  }
  if (cfg.privateKeyPath) {
    o.authenticator = "SNOWFLAKE_JWT"
    o.privateKeyPath = cfg.privateKeyPath
    if (cfg.privateKeyPass) o.privateKeyPass = cfg.privateKeyPass
  } else if (auth === "EXTERNALBROWSER") {
    o.authenticator = "EXTERNALBROWSER"
  } else if (auth === "PROGRAMMATIC_ACCESS_TOKEN") {
    o.authenticator = "PROGRAMMATIC_ACCESS_TOKEN"
    o.token = cfg.password
  } else {
    o.password = cfg.password
    if (auth && auth !== "SNOWFLAKE") o.authenticator = auth
  }
  return o
}

function open(cfg, application) {
  const opts = sdkOptions(cfg, application)
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts)
    const cb = (err) => (err ? reject(err) : resolve(conn))
    // Browser SSO needs the async connect; the other authenticators work with either.
    if (opts.authenticator === "EXTERNALBROWSER") conn.connectAsync(cb)
    else conn.connect(cb)
  })
}

export function connect(application = "sc-ontology-script") {
  return open(connectionConfig(), application)
}

/** Connect to a specific [name] in connections.toml, ignoring the env credentials. */
export function connectNamed(name, application = "sc-ontology-script") {
  return open(connectionConfig(name), application)
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
