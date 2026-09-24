/**
 * Rebuild SUPPLY_CHAIN from nothing.
 *
 *   node scripts/rebuild.mjs                 # everything, in order
 *   node scripts/rebuild.mjs --only 00c      # one file (prefix match)
 *   node scripts/rebuild.mjs --from 01       # resume from a file onwards
 *   node scripts/rebuild.mjs --verify        # only the 90-92 verification files
 *   node scripts/rebuild.mjs --dry-run       # print the plan, execute nothing
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN `snow sql -f`
 *
 * `snow sql -f` splits a file on semicolons client-side. That breaks every
 * construct in sql/ that legally contains a semicolon inside its body:
 *
 *   - the METRIC_DRIFT_TEST procedure in 00f (a DECLARE ... END block)
 *   - the anonymous DECLARE ... END blocks in 01 and 07 that splice GET_DDL output
 *
 * This was not theoretical: running 00f through `snow sql -f` produced
 * "syntax error line 7 at position 21 unexpected '<EOF>'" because the procedure
 * body had been cut into fragments at its internal semicolons.
 *
 * So this runner does not split statements at all. It sets MULTI_STATEMENT_COUNT
 * on the session and hands each file to Snowflake whole, letting the server's own
 * parser decide where statements end. That parser is the same one Snowsight uses,
 * so it is correct by construction for anything a human could paste into a
 * worksheet -- and it cannot drift from the dialect the way a hand-written
 * tokeniser would.
 *
 * The cost is coarser error attribution: Snowflake reports the failing statement
 * within the file rather than this script tracking an index. In exchange the
 * statements are actually correct, which matters more.
 *
 * ---------------------------------------------------------------------------
 * ORDER IS ENFORCED, AND ONE ORDERING IS A TRAP
 *
 * 00e creates SC_ONTOLOGY_360 with 10 entities. 01 then reads it back with
 * GET_DDL and splices in the CALENDAR entity. Running 00e AFTER 01 silently
 * reverts the view, removing calendar.cal_date and calendar.is_future, which
 * lib/period.ts filters on for every reporting period -- so the app breaks on
 * every page that applies a period, with no error at rebuild time.
 *
 * FILES below is the single source of truth for order. --only and --from exist
 * for iteration, and --only 00e prints a warning for exactly this reason.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import snowflake from "snowflake-sdk"
import { parse as parseToml } from "smol-toml"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SQL_DIR = path.join(ROOT, "sql")

/**
 * Execution order. Base layer, then the increments, then verification.
 *
 * The increments 01-08 are listed explicitly rather than globbed so that adding a
 * file to sql/ is a deliberate act: a glob would silently pick up a scratch file
 * and run it against the account.
 */
const FILES = [
  { file: "00a_foundation.sql",        phase: "base",   note: "database, schemas, roles, warehouse grants" },
  { file: "00b_raw_dimensions.sql",    phase: "base",   note: "RAW conformed dimensions" },
  { file: "00c_raw_transactions.sql",  phase: "base",   note: "RAW transactional data, full scale (slowest step)" },
  { file: "00d_canonical.sql",         phase: "base",   note: "CANONICAL atomic facts" },
  { file: "00e_semantic.sql",          phase: "base",   note: "the 8 SEMANTIC views — MUST precede 01" },
  { file: "00f_governance.sql",        phase: "base",   note: "registry, drift procedure, ontology views, personas" },
  { file: "01_calendar_dimension.sql", phase: "increment", note: "splices CALENDAR into SC_ONTOLOGY_360" },
  { file: "02_as_of_rule.sql",         phase: "increment", note: "adds and populates the as-of and target columns" },
  { file: "03_targets.sql",            phase: "increment", note: "governed targets and thresholds" },
  { file: "04_drift_schedule.sql",     phase: "increment", note: "daily drift task and alert" },
  { file: "05_exception_rules.sql",    phase: "increment", note: "what an exception row is, per metric" },
  { file: "06_drift_notification.sql", phase: "increment", note: "email integration and the negative-control binding" },
  { file: "07_verified_queries.sql",   phase: "increment", note: "documents amending verified queries on a live view — adds none (they live in 00e)" },
  { file: "07b_prediction_objects.sql", phase: "increment", note: "objects 08 calls but never creates — must follow 03, precede 08" },
  { file: "08_prediction_layer.sql",   phase: "increment", note: "ML forecast, anomaly detection, outlook view" },
  { file: "08b_persist_forecast.sql",  phase: "increment", note: "persists the volume forecast 08 discards, and backtests it" },
  { file: "09_agent_eval.sql",         phase: "increment", note: "60-question evaluation set — needs the registry, so it follows 00f" },
  { file: "10_agent.sql",              phase: "increment", note: "the Cortex Agent — needs every semantic view incl. SC_OUTLOOK from 07b" },
  { file: "10b_geospatial_reference.sql", phase: "increment", note: "geocoded nodes, regional lane geometry, and chokepoint reference data" },
  { file: "90_verify_base.sql",        phase: "verify", note: "splice anchors, registry shape, THE DRIFT GATE" },
  { file: "91_verify_personas.sql",    phase: "verify", note: "EU row scope is genuinely filtering" },
  { file: "92_verify_counts.sql",      phase: "verify", note: "row counts, snapshot cardinality, data shape" },
  { file: "93_verify_verified_queries.sql", phase: "verify", note: "executes all 38 verified queries — they are not validated at create time" },
]

// --- arguments ---

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const DRY_RUN = flag("dry-run")
const ONLY = value("only")
const FROM = value("from")
const VERIFY_ONLY = flag("verify")

let plan = FILES
if (VERIFY_ONLY) plan = FILES.filter((f) => f.phase === "verify")
if (ONLY) plan = FILES.filter((f) => f.file.startsWith(ONLY))
if (FROM) {
  const i = FILES.findIndex((f) => f.file.startsWith(FROM))
  if (i < 0) {
    console.error(`--from ${FROM} matched no file in sql/`)
    process.exit(1)
  }
  plan = FILES.slice(i)
}

if (plan.length === 0) {
  console.error(`Nothing to run. --only/${ONLY} matched no file.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 01 IS NOT IDEMPOTENT, AND THAT MAKES 00e A MANDATORY TRAVELLING COMPANION.
//
// 01 splices a CALENDAR entity into whatever SC_ONTOLOGY_360 currently is. Run it
// against a view that already has CALENDAR and it appends a second one:
//   "duplicate alias 'CALENDAR'"
//
// The only way to run 01 safely is immediately after 00e, which recreates the view
// with 10 entities and no CALENDAR. So `--from 00f` and `--only 01` both look
// reasonable and both fail.
//
// Rather than leave that as a documented trap, the plan is repaired here: any plan
// containing 01 but not 00e gets 00e prepended. This is also why the reverse
// hazard cannot happen through this runner -- 00e is never run without 01
// following it, because FILES always keeps them adjacent and in that order.
// ---------------------------------------------------------------------------
const NEEDS_SEMANTIC_RESET = "01_calendar_dimension.sql"
const SEMANTIC_RESET = "00e_semantic.sql"

if (plan.some((f) => f.file === NEEDS_SEMANTIC_RESET) && !plan.some((f) => f.file === SEMANTIC_RESET)) {
  const reset = FILES.find((f) => f.file === SEMANTIC_RESET)
  plan = [reset, ...plan]
  console.warn(
    `\n  NOTE: prepending ${SEMANTIC_RESET} because the plan includes ${NEEDS_SEMANTIC_RESET}.\n` +
    "  01 splices CALENDAR into SC_ONTOLOGY_360 and would fail with \"duplicate alias\n" +
    "  'CALENDAR'\" against a view that already has it, so the view is reset first.\n",
  )
}

// Running 00e on its own, after 01 has already spliced CALENDAR in, reverts the
// view. Warn loudly rather than silently breaking every period-scoped page.
if (ONLY && ONLY.startsWith("00e")) {
  console.warn(
    "\n  WARNING: 00e recreates SC_ONTOLOGY_360 with 10 entities and no CALENDAR.\n" +
    "  If 01 has already run, you must run 01 again immediately after this, or\n" +
    "  every page that applies a reporting period will fail on a missing\n" +
    "  calendar.cal_date dimension. See sql/00_README.md.\n",
  )
}

// --- connection ---

/**
 * Credentials, in the same priority order lib/snowflake.ts uses locally, so the
 * rebuild targets whatever the app targets and the two cannot disagree about
 * which account is being written to.
 */
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
    throw new Error(
      `No credentials. Set SNOWFLAKE_USER/SNOWFLAKE_PASSWORD, or create ${file}.`,
    )
  }
  const raw = parseToml(fs.readFileSync(file, "utf8"))

  // connections.toml supports both [connections.name] and legacy top-level
  // [name]; and default_connection_name is sometimes a bare string rather than a
  // table, which is why non-object values are skipped rather than treated as
  // connections.
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
      application: "sc-ontology-rebuild",
      clientSessionKeepAlive: true,
    })
    conn.connect((err) => (err ? reject(err) : resolve(conn)))
  })
}

function exec(conn, sqlText) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, stmt, rows) => (err ? reject(err) : resolve({ stmt, rows })),
    })
  })
}

// --- run ---

function banner(cfg) {
  console.log("")
  console.log("  Rebuilding SUPPLY_CHAIN")
  console.log(`  account   ${cfg.account}`)
  console.log(`  user      ${cfg.username}  role ${cfg.role}  warehouse ${cfg.warehouse}`)
  console.log(`  creds     ${cfg.source}`)
  console.log(`  files     ${plan.length}${DRY_RUN ? "  (dry run)" : ""}`)
  console.log("")
}

async function main() {
  const cfg = connectionConfig()
  banner(cfg)

  if (DRY_RUN) {
    for (const [i, s] of plan.entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. [${s.phase}] ${s.file}`)
      console.log(`      ${s.note}`)
    }
    console.log("\n  Dry run: nothing executed.\n")
    return
  }

  for (const s of plan) {
    if (!fs.existsSync(path.join(SQL_DIR, s.file))) {
      console.error(`  MISSING  ${s.file}`)
      process.exit(1)
    }
  }

  const conn = await connect(cfg)

  // MULTI_STATEMENT_COUNT = 0 means "any number of statements", which is what lets
  // a whole file be submitted as one request and parsed server-side. Without it
  // the driver rejects anything after the first statement.
  await exec(conn, "ALTER SESSION SET MULTI_STATEMENT_COUNT = 0")
  // Long enough for the 1.5M-row generators in 00c and the ML training in 08.
  await exec(conn, "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 3600")

  let failed = null

  for (const [i, s] of plan.entries()) {
    const label = `[${i + 1}/${plan.length}] ${s.file}`
    const sql = fs.readFileSync(path.join(SQL_DIR, s.file), "utf8")
    const started = Date.now()
    process.stdout.write(`  ${label.padEnd(38)} `)
    try {
      await exec(conn, sql)
      console.log(`ok   ${((Date.now() - started) / 1000).toFixed(1)}s   ${s.note}`)
    } catch (err) {
      console.log(`FAIL ${((Date.now() - started) / 1000).toFixed(1)}s`)
      failed = { file: s.file, message: err?.message ?? String(err) }
      break
    }
  }

  conn.destroy(() => {})

  if (failed) {
    console.error("")
    console.error(`  Stopped at ${failed.file}`)
    console.error("")
    for (const line of String(failed.message).split("\n")) console.error(`    ${line}`)
    console.error("")
    console.error("  Fix the file, then resume without redoing the earlier steps:")
    console.error(`    node scripts/rebuild.mjs --from ${failed.file.slice(0, 3)}`)
    console.error("")
    process.exit(1)
  }

  console.log("")
  console.log("  Rebuild complete.")
  console.log("")
  console.log("  The verification files print a VERDICT column per check. Review them:")
  console.log("    snow sql -f sql/90_verify_base.sql       # includes the drift gate")
  console.log("    snow sql -f sql/91_verify_personas.sql")
  console.log("    snow sql -f sql/92_verify_counts.sql")
  console.log("")
  console.log("  The gate is 90: 14 metrics, all PASS, zero spread.")
  console.log("")
}

main().catch((err) => {
  console.error("")
  console.error(`  ${err?.message ?? err}`)
  console.error("")
  process.exit(1)
})
