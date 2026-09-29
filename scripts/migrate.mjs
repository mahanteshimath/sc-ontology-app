/**
 * Move the whole SUPPLY_CHAIN backend from one Snowflake account to another, data as-is.
 *
 *   node scripts/migrate.mjs --from pramogm-ln72054 --to target
 *   node scripts/migrate.mjs --from pramogm-ln72054 --to target --dry-run   # preflight + plan only
 *   node scripts/migrate.mjs --from pramogm-ln72054 --to target --resume    # continue after a failure
 *   node scripts/migrate.mjs --from pramogm-ln72054 --to target --verify-only
 *
 *   --notify-email x@y.com   steward email on the target (default: the target user's own email)
 *   --app-users "A, B"       users on the target granted every persona role
 *                            (default: the users holding SC_PLANNER on the source; missing ones are skipped)
 *   --force                  allow a target whose SUPPLY_CHAIN already has tables
 *   --skip-rebuild           the target was already built with rebuild.mjs --connection; copy data only
 *   --export-dir <path>      where the Parquet export is staged locally (default: OS temp dir)
 *
 * --from and --to are connection names in ~/.snowflake/connections.toml. Both must use ACCOUNTADMIN.
 *
 * ---------------------------------------------------------------------------
 * WHY OBJECTS ARE REBUILT BUT DATA IS COPIED
 *
 * Every object is created by sql/ through scripts/rebuild.mjs, so the target gets the same
 * definitions the repository documents rather than a clone of whatever drifted in the source.
 * The data cannot be regenerated that way: contract terms come from AI_EXTRACT, and the eval runs,
 * question log, drift history and certification snapshots are records of things that happened.
 * So every base table is copied, then proved equal by row count and HASH_AGG on both sides.
 *
 * The copy is type-exact. Values travel through Parquet as text wherever a binary encoding could
 * shift them: GEOGRAPHY as WKB hex, VARIANT/ARRAY/OBJECT as JSON, NUMBER as its decimal string,
 * dates and timestamps with nanoseconds and offset. FLOAT and BOOLEAN travel natively (exact in
 * Parquet). A table already identical on the target is skipped, so a --resume is cheap.
 *
 * NOT COPIED, deliberately: GOVERNANCE.NOTIFICATION_SETTING (the steward email is per account),
 * users and their passwords, and the app's Vercel environment. The report says so.
 * ---------------------------------------------------------------------------
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { connectNamed, connectionConfig, query } from "./sf.mjs"
import { inventory, checksums, key } from "./inventory.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const WORK = path.join(ROOT, ".migrate")
const STATE_FILE = path.join(WORK, "state.json")
const DB = "SUPPLY_CHAIN"
const STAGE = "@~/sc_migrate"
/** Account-specific; each account keeps its own. */
const NOT_COPIED = new Set(["GOVERNANCE.NOTIFICATION_SETTING"])
/** RAW before CANONICAL before GOVERNANCE: the ML models are retrained between the second and third. */
const SCHEMA_ORDER = ["RAW", "CANONICAL", "GOVERNANCE"]

// --- arguments ---

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const value = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const FROM = value("from")
const TO = value("to")
const DRY_RUN = flag("dry-run")
const RESUME = flag("resume")
const FORCE = flag("force")
const VERIFY_ONLY = flag("verify-only")
const EXPORT_DIR = path.resolve(value("export-dir") ?? path.join(os.tmpdir(), "sc-ontology-migrate"))

const SELFTEST = value("selftest")

if (!FROM || (!TO && !SELFTEST)) {
  console.error("Usage: node scripts/migrate.mjs --from <source connection> --to <target connection> [--dry-run|--resume|--verify-only]")
  process.exit(1)
}
if (!SELFTEST && FROM === TO) {
  console.error("--from and --to name the same connection.")
  process.exit(1)
}

// --- state ---

fs.mkdirSync(WORK, { recursive: true })
let state = { from: FROM, to: TO, steps: {}, tables: {}, notes: [] }
if ((RESUME || VERIFY_ONLY) && fs.existsSync(STATE_FILE)) {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  if (state.from !== FROM || state.to !== TO) {
    console.error(`State in ${STATE_FILE} is for ${state.from} -> ${state.to}, not ${FROM} -> ${TO}.`)
    process.exit(1)
  }
}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
const done = (step) => Boolean(state.steps[step]?.done)
const mark = (step, extra = {}) => {
  state.steps[step] = { done: true, at: new Date().toISOString(), ...extra }
  save()
}

const log = (s = "") => console.log(s ? `  ${s}` : "")
const lit = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`
const fq = (t) => {
  const [s, n] = t.split(".")
  return `${DB}.${ident(s)}.${ident(n)}`
}

// --- column encodings ---

function family(c) {
  const t = c.type.toUpperCase()
  if (t === "GEOGRAPHY" || t === "GEOMETRY") return "geo"
  if (t === "VARIANT" || t === "ARRAY" || t === "OBJECT") return "semi"
  if (t.startsWith("TIMESTAMP")) return "ts"
  if (t === "NUMBER" || t === "DECIMAL") return "number"
  if (t === "BINARY") return "binary"
  if (t === "DATE" || t === "TIME") return t.toLowerCase()
  return "native" // TEXT, FLOAT, BOOLEAN
}

const TS_FMT = { TIMESTAMP_NTZ: "YYYY-MM-DD HH24:MI:SS.FF9", TIMESTAMP_LTZ: "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM", TIMESTAMP_TZ: "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM" }

function exportExpr(c) {
  const q = ident(c.name)
  switch (family(c)) {
    case "geo": return `HEX_ENCODE(ST_ASWKB(${q}))`
    case "semi": return `TO_JSON(${q})`
    case "ts": return `TO_VARCHAR(${q}, ${lit(TS_FMT[c.type] ?? TS_FMT.TIMESTAMP_TZ)})`
    case "number": return `TO_VARCHAR(${q})`
    case "binary": return `HEX_ENCODE(${q})`
    case "date": return `TO_VARCHAR(${q}, 'YYYY-MM-DD')`
    case "time": return `TO_VARCHAR(${q}, 'HH24:MI:SS.FF9')`
    default: return q
  }
}

/** Loaded into the TARGET column's type: a CTAS-created column can infer a different precision. */
function loadExpr(c, into = c) {
  const v = `$1:${ident(c.name)}`
  const s = `${v}::STRING`
  switch (family(c)) {
    case "geo": return `${c.type === "GEOMETRY" ? "TO_GEOMETRY" : "TO_GEOGRAPHY"}(HEX_DECODE_BINARY(${s}))`
    case "semi": return c.type === "VARIANT" ? `PARSE_JSON(${s})` : `PARSE_JSON(${s})::${c.type}`
    case "ts": return `TO_${c.type}(${s}, ${lit(TS_FMT[c.type] ?? TS_FMT.TIMESTAMP_TZ)})`
    case "number": return `${s}::NUMBER(${into.precision ?? 38}, ${into.scale ?? 0})`
    case "binary": return `HEX_DECODE_BINARY(${s})`
    case "date": return `TO_DATE(${s}, 'YYYY-MM-DD')`
    case "time": return `TO_TIME(${s}, 'HH24:MI:SS.FF9')`
    default: {
      const t = c.type.toUpperCase()
      return t === "FLOAT" ? `${v}::FLOAT` : t === "BOOLEAN" ? `${v}::BOOLEAN` : s
    }
  }
}

const sig = (c) => `${c.type}${c.precision != null ? `(${c.precision},${c.scale})` : ""}`

/** HASH_AGG does not accept GEOGRAPHY, so geo columns are hashed through their WKB. */
const hashExpr = (c) => (family(c) === "geo" ? `HEX_ENCODE(ST_ASWKB(${ident(c.name)}))` : ident(c.name))

async function tableColumns(conn) {
  const rows = await query(
    conn,
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.numeric_precision, c.numeric_scale
       FROM ${DB}.INFORMATION_SCHEMA.COLUMNS c
       JOIN ${DB}.INFORMATION_SCHEMA.TABLES t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE t.table_type = 'BASE TABLE' AND c.table_schema <> 'INFORMATION_SCHEMA'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  )
  const out = {}
  for (const r of rows) {
    const t = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`
    ;(out[t] ??= []).push({ name: r.COLUMN_NAME, type: r.DATA_TYPE, precision: r.NUMERIC_PRECISION, scale: r.NUMERIC_SCALE })
  }
  return out
}

/** COUNT + HASH_AGG over the source's column list, so both sides hash the same expression. */
async function profile(conn, table, cols) {
  const [r] = await query(conn, `SELECT COUNT(*) AS N, TO_VARCHAR(HASH_AGG(${cols.map(hashExpr).join(", ")})) AS H FROM ${fq(table)}`)
  return { rows: Number(r.N), hash: r.H ?? "0" }
}

// --- connections ---

async function open(name, label) {
  const cfg = connectionConfig(name)
  const conn = await connectNamed(name, `sc-ontology-migrate-${label}`)
  // Timestamps are rendered and hashed identically on both sides only under one timezone.
  await query(conn, "ALTER SESSION SET TIMEZONE = 'UTC'")
  await query(conn, "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 3600")
  const [who] = await query(conn, "SELECT CURRENT_ACCOUNT() AS A, CURRENT_ORGANIZATION_NAME() AS O, CURRENT_ACCOUNT_NAME() AS N, CURRENT_REGION() AS R, CURRENT_USER() AS U, CURRENT_ROLE() AS ROLE")
  return { conn, cfg, who }
}

async function accountParam(conn, name) {
  const rows = await query(conn, `SHOW PARAMETERS LIKE '${name}' IN ACCOUNT`)
  return rows[0]?.value ?? null
}

// --- rebuild (child process, so its output and failure handling stay its own) ---

function runRebuild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "rebuild.mjs"), "--connection", TO, ...args], { cwd: ROOT })
    let out = ""
    const tee = (d) => {
      out += d
      process.stdout.write(d)
    }
    child.stdout.on("data", tee)
    child.stderr.on("data", tee)
    child.on("close", (code) => {
      const stopped = /Stopped at (\S+)/.exec(out)?.[1]
      resolve({ ok: code === 0, stopped })
    })
  })
}

// --- data copy ---

async function copyTable(src, tgt, table, cols, tcols) {
  const folder = `${STAGE}/${table}/`
  const local = path.join(EXPORT_DIR, table)
  fs.rmSync(local, { recursive: true, force: true })
  fs.mkdirSync(local, { recursive: true })
  const uri = `file://${local.replace(/\\/g, "/")}/`

  await query(src, `REMOVE ${folder}`)
  await query(
    src,
    `COPY INTO ${folder} FROM (SELECT ${cols.map((c) => `${exportExpr(c)} AS ${ident(c.name)}`).join(", ")} FROM ${fq(table)})
       FILE_FORMAT = (TYPE = PARQUET) HEADER = TRUE OVERWRITE = TRUE MAX_FILE_SIZE = 104857600`,
  )
  await query(src, `GET ${folder} ${lit(uri)} PARALLEL = 8`)
  await query(src, `REMOVE ${folder}`)

  const files = fs.readdirSync(local)
  await query(tgt, `REMOVE ${folder}`)
  await query(tgt, `TRUNCATE TABLE ${fq(table)}`)
  if (files.length > 0) {
    await query(tgt, `PUT ${lit(`${uri}*`)} ${folder} AUTO_COMPRESS = FALSE OVERWRITE = TRUE PARALLEL = 8`)
    await query(
      tgt,
      `COPY INTO ${fq(table)} (${cols.map((c) => ident(c.name)).join(", ")})
         FROM (SELECT ${cols.map((c) => loadExpr(c, tcols.get(c.name))).join(", ")} FROM ${folder})
         FILE_FORMAT = (TYPE = PARQUET) ON_ERROR = ABORT_STATEMENT FORCE = TRUE PURGE = TRUE`,
    )
  }
  fs.rmSync(local, { recursive: true, force: true })
}

async function copySchema(src, tgt, schema, source, targetCols) {
  let copied = 0
  const tables = Object.keys(source.columns).filter((t) => t.startsWith(`${schema}.`) && !NOT_COPIED.has(t)).sort()
  for (const table of tables) {
    if (state.tables[table]?.status === "copied" || state.tables[table]?.status === "identical") continue
    const cols = source.columns[table]
    const tcols = new Map((targetCols[table] ?? []).map((c) => [c.name, c]))
    const have = new Set(tcols.keys())
    const missing = cols.filter((c) => !have.has(c.name)).map((c) => c.name)
    process.stdout.write(`  ${table.padEnd(46)} `)
    if (!targetCols[table] || missing.length) {
      const why = !targetCols[table] ? "table not created by sql/ on the target" : `target lacks columns ${missing.join(", ")}`
      console.log(`GAP  ${why}`)
      state.tables[table] = { status: "gap", why }
      save()
      continue
    }
    const want = source.profiles[table]
    const before = await profile(tgt, table, cols)
    if (before.rows === want.rows && before.hash === want.hash) {
      console.log(`identical  ${want.rows.toLocaleString()} rows`)
      state.tables[table] = { status: "identical", rows: want.rows }
      save()
      continue
    }
    const started = Date.now()
    const drift = cols.filter((c) => sig(tcols.get(c.name)) !== sig(c)).map((c) => `${c.name} ${sig(c)}->${sig(tcols.get(c.name))}`)
    await copyTable(src, tgt, table, cols, tcols)
    const after = await profile(tgt, table, cols)
    const ok = after.rows === want.rows && after.hash === want.hash
    console.log(`${ok ? "copied" : "MISMATCH"}  ${after.rows.toLocaleString()}/${want.rows.toLocaleString()} rows  ${((Date.now() - started) / 1000).toFixed(1)}s${drift.length ? `  column types differ: ${drift.join(", ")}` : ""}`)
    state.tables[table] = { status: ok ? "copied" : "mismatch", rows: after.rows, expected: want.rows, hash: after.hash, expectedHash: want.hash }
    save()
    if (ok) copied++
  }
  return copied
}

// --- report ---

function writeReport(r) {
  const lines = []
  lines.push(`# SUPPLY_CHAIN migration report`, "")
  lines.push(`- Source: \`${r.source}\``, `- Target: \`${r.target}\``, `- Finished: ${new Date().toISOString()}`, `- Verdict: **${r.verdict}**`, "")
  lines.push(`## Objects`, "", "| Kind | Source | Target |", "|---|---:|---:|")
  for (const k of Object.keys(r.kinds).sort()) lines.push(`| ${k} | ${r.kinds[k].source} | ${r.kinds[k].target} |`)
  lines.push("")
  lines.push(r.missing.length ? `Missing on target (${r.missing.length}):\n\n${r.missing.map((m) => `- ${m}`).join("\n")}` : "Every source object exists on the target.", "")
  if (r.extra.length) lines.push(`Only on target (${r.extra.length}, expected for NOTIFICATION_SETTING):\n\n${r.extra.map((m) => `- ${m}`).join("\n")}`, "")
  if (r.unsupported.length) lines.push(`Not inventoried (SHOW unsupported on an account): ${r.unsupported.join(", ")}`, "")
  lines.push(`## Data`, "", "| Table | Source rows | Target rows | Content hash | Action |", "|---|---:|---:|---|---|")
  for (const t of r.tables) lines.push(`| ${t.table} | ${t.sourceRows.toLocaleString()} | ${t.targetRows?.toLocaleString() ?? "-"} | ${t.hashMatch ? "equal" : "DIFFERENT"} | ${t.action} |`)
  lines.push("", `Totals: ${r.totalSource.toLocaleString()} source rows, ${r.totalTarget.toLocaleString()} target rows, ${r.tables.filter((t) => t.hashMatch).length}/${r.tables.length} tables content-equal.`, "")
  lines.push(`## Schedules`, "", "| Object | Source | Target |", "|---|---|---|")
  for (const s of r.schedules) lines.push(`| ${s.name} | ${s.source} | ${s.target} |`)
  lines.push("", `## Functional checks (run after the data comparison, on the target)`, "")
  for (const c of r.checks) lines.push(`- ${c.ok ? "PASS" : "FAIL"} - ${c.name}${c.detail ? `: ${c.detail}` : ""}`)
  lines.push("", `## Not migrated, by design`, "")
  for (const n of r.notes) lines.push(`- ${n}`)
  const file = path.join(WORK, "report.md")
  fs.writeFileSync(file, lines.join("\n") + "\n")
  return file
}

// --- main ---

async function main() {
  log("")
  log(`Migrating ${DB}: [${FROM}] -> [${TO}]${DRY_RUN ? "  (dry run)" : ""}${RESUME ? "  (resume)" : ""}`)
  log("")

  const S = await open(FROM, "source")
  const T = await open(TO, "target")
  const src = S.conn
  const tgt = T.conn
  log(`source  ${S.who.O}-${S.who.N} (${S.who.A}, ${S.who.R})  user ${S.who.U}  role ${S.who.ROLE}`)
  log(`target  ${T.who.O}-${T.who.N} (${T.who.A}, ${T.who.R})  user ${T.who.U}  role ${T.who.ROLE}`)
  if (`${S.who.O}-${S.who.N}` === `${T.who.O}-${T.who.N}`) throw new Error("Source and target are the same account.")
  for (const [side, w] of [["source", S.who], ["target", T.who]]) {
    if (w.ROLE !== "ACCOUNTADMIN") throw new Error(`The ${side} connection must use role ACCOUNTADMIN (it uses ${w.ROLE}).`)
  }

  // --- 1. preflight ---
  const existing = (await query(tgt, `SHOW DATABASES LIKE '${DB}'`)).length
  let targetTables = 0
  if (Number(existing) > 0) {
    const [r] = await query(tgt, `SELECT COUNT(*) AS N FROM ${DB}.INFORMATION_SCHEMA.TABLES WHERE table_type = 'BASE TABLE' AND table_schema <> 'INFORMATION_SCHEMA'`)
    targetTables = Number(r.N)
  }
  log(`target ${DB}: ${Number(existing) ? `exists, ${targetTables} base tables` : "does not exist"}`)
  if (targetTables > 0 && !FORCE && !RESUME && !VERIFY_ONLY && !flag("skip-rebuild")) {
    throw new Error(`Target ${DB} already has ${targetTables} base tables. Re-run with --resume to continue a migration, or --force to overwrite.`)
  }

  const crossSrc = await accountParam(src, "CORTEX_ENABLED_CROSS_REGION")
  const crossTgt = await accountParam(tgt, "CORTEX_ENABLED_CROSS_REGION")
  log(`CORTEX_ENABLED_CROSS_REGION  source ${crossSrc}  target ${crossTgt}`)

  let appUsers = value("app-users")
  if (!appUsers) {
    const grants = await query(src, "SHOW GRANTS OF ROLE SC_PLANNER").catch(() => [])
    appUsers = grants.filter((g) => g.granted_to === "USER").map((g) => g.grantee_name).join(",")
  }
  log(`persona roles will be granted on the target to: ${T.who.U}${appUsers ? `, and if they exist there: ${appUsers}` : ""}`)
  log(`export staging: ${EXPORT_DIR}`)

  if (DRY_RUN) {
    log("")
    log("Plan:")
    log(`  1. ${crossSrc !== crossTgt ? `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = '${crossSrc}' on the target` : "cross-region inference already matches"}`)
    log("  2. snapshot the source: inventory, columns, COUNT + HASH_AGG per base table")
    log("  3. node scripts/rebuild.mjs --connection " + TO + " --no-verify  (every object from sql/)")
    log("  4. copy RAW, CANONICAL; retrain the ML models (08, 08b); copy GOVERNANCE")
    log("  5. refresh Cortex Search; set task and alert states to match the source")
    log("  6. verify: inventory diff, counts + hashes, drift test, CI gate, sql/90-93; write .migrate/report.md")
    log("")
    log("Dry run: nothing changed.")
    return
  }

  // --- 2. cross-region inference: the agent, AI_EXTRACT and AI_CLASSIFY need the source's setting ---
  if (!VERIFY_ONLY && !done("cross-region")) {
    if (crossSrc && crossSrc !== crossTgt) {
      await query(tgt, `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = ${lit(crossSrc)}`)
      log(`target CORTEX_ENABLED_CROSS_REGION set to ${crossSrc}`)
    }
    mark("cross-region", { value: crossSrc })
  }

  // --- 3. source snapshot ---
  const snapFile = path.join(WORK, "source.json")
  let source
  if (done("snapshot") && fs.existsSync(snapFile)) {
    source = JSON.parse(fs.readFileSync(snapFile, "utf8"))
    log(`source snapshot reused (${source.at})`)
  } else {
    log("")
    log("Snapshotting the source (inventory, columns, row counts, content hashes)...")
    const inv = await inventory(src)
    const columns = await tableColumns(src)
    const profiles = {}
    for (const [t, cols] of Object.entries(columns)) profiles[t] = await profile(src, t, cols)
    source = { account: `${S.who.O}-${S.who.N}`, at: new Date().toISOString(), ...inv, columns, profiles }
    fs.writeFileSync(snapFile, JSON.stringify(source, null, 2))
    mark("snapshot")
    const total = Object.values(profiles).reduce((a, p) => a + p.rows, 0)
    log(`${source.objects.length} objects, ${Object.keys(columns).length} base tables, ${total.toLocaleString()} rows`)
  }

  // --- 4. rebuild every object on the target ---
  if (!VERIFY_ONLY && !done("rebuild") && flag("skip-rebuild")) {
    log("rebuild skipped (--skip-rebuild): the target's objects were already built from sql/")
    mark("rebuild", { skipped: true })
  }
  if (!VERIFY_ONLY && !done("rebuild")) {
    // The rebuild's connection asks for COMPUTE_WH; a new account may not have it until 00a runs.
    await query(tgt, "CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE")
    const args = ["--no-verify"]
    if (state.rebuildFrom) args.push("--from", state.rebuildFrom)
    if (appUsers) args.push("--app-users", appUsers)
    if (value("notify-email")) args.push("--notify-email", value("notify-email"))
    log("")
    log(`Rebuilding every object on the target${state.rebuildFrom ? ` from ${state.rebuildFrom}` : ""}...`)
    const r = await runRebuild(args)
    if (!r.ok) {
      state.rebuildFrom = r.stopped ? r.stopped.slice(0, 3) : state.rebuildFrom
      save()
      throw new Error(`Rebuild stopped${r.stopped ? ` at ${r.stopped}` : ""}. Fix it, then re-run with --resume.`)
    }
    delete state.rebuildFrom
    mark("rebuild")
  }

  // --- 5. data ---
  if (!VERIFY_ONLY && !done("data")) {
    await query(tgt, "USE WAREHOUSE COMPUTE_WH")
    const targetCols = await tableColumns(tgt)
    log("")
    log("Copying data (skipping tables already identical)...")
    let upstreamCopied = 0
    for (const schema of SCHEMA_ORDER) {
      if (schema === "GOVERNANCE" && !done("retrain")) {
        // Derived from saved state, not this run's counter, so a --resume still retrains.
        upstreamCopied = Object.entries(state.tables).filter(([t, v]) => v.status === "copied" && !t.startsWith("GOVERNANCE.")).length
        // The forecast and anomaly models were trained during the rebuild on the rebuild's data.
        // If RAW or CANONICAL was replaced, retrain on the copied data before GOVERNANCE (which
        // holds the persisted forecasts from the source) is copied over the top.
        if (upstreamCopied > 0) {
          log("")
          log("RAW/CANONICAL changed - retraining the ML models on the copied data (08, 08b)...")
          const r = await runRebuild(["--only", "08"])
          if (!r.ok) throw new Error("Retraining (08) failed. Fix it, then re-run with --resume.")
        }
        mark("retrain", { needed: upstreamCopied > 0 })
      }
      upstreamCopied += await copySchema(src, tgt, schema, source, targetCols)
    }
    // Anything outside the three data schemas (UTIL, APPS, PUBLIC are empty today) is copied last.
    const others = [...new Set(Object.keys(source.columns).map((t) => t.split(".")[0]))].filter((s) => !SCHEMA_ORDER.includes(s))
    for (const schema of others) await copySchema(src, tgt, schema, source, targetCols)
    const bad = Object.entries(state.tables).filter(([, v]) => v.status === "mismatch" || v.status === "gap")
    if (bad.length) {
      for (const [t] of bad) delete state.tables[t]
      save()
      throw new Error(`${bad.length} table(s) did not copy cleanly: ${bad.map(([t]) => t).join(", ")}. See above; --resume retries them.`)
    }
    mark("data")
  }

  // --- 6. search index and schedules ---
  if (!VERIFY_ONLY && !done("post")) {
    log("")
    await query(tgt, `ALTER CORTEX SEARCH SERVICE ${DB}.SEMANTIC.SUPPLIER_CONTRACT_SEARCH REFRESH`)
    log("Cortex Search refreshed over the copied contracts")
    for (const o of source.objects.filter((o) => o.kind === "TASK" || o.kind === "ALERT")) {
      const verb = String(o.state).toLowerCase() === "started" ? "RESUME" : "SUSPEND"
      await query(tgt, `ALTER ${o.kind} ${DB}.${ident(o.schema)}.${ident(o.name)} ${verb}`)
      log(`${o.kind.toLowerCase()} ${o.name}: ${verb === "RESUME" ? "started" : "suspended"} (as on the source)`)
    }
    mark("post")
  }

  // --- 7. verify ---
  log("")
  log("Verifying...")
  const tinv = await inventory(tgt)
  const strip = (o) => key({ ...o, owner: null, state: null })
  const sKeys = new Set(source.objects.map(strip))
  const tKeys = new Set(tinv.objects.map(strip))
  const missing = [...sKeys].filter((k) => !tKeys.has(k)).sort()
  const extra = [...tKeys].filter((k) => !sKeys.has(k)).sort()
  const kinds = {}
  for (const o of source.objects) (kinds[o.kind] ??= { source: 0, target: 0 }).source++
  for (const o of tinv.objects) (kinds[o.kind] ??= { source: 0, target: 0 }).target++
  const unsupported = [...new Set([...source.errors, ...tinv.errors].map((e) => e.kind))]

  // Data is compared before any functional check writes to GOVERNANCE (the drift test appends).
  const tables = []
  for (const [t, cols] of Object.entries(source.columns).sort()) {
    if (NOT_COPIED.has(t)) continue
    const want = source.profiles[t]
    let got = null
    try {
      got = await profile(tgt, t, cols)
    } catch {
      got = null
    }
    tables.push({
      table: t,
      sourceRows: want.rows,
      targetRows: got?.rows ?? null,
      hashMatch: Boolean(got && got.rows === want.rows && got.hash === want.hash),
      action: state.tables[t]?.status ?? "-",
    })
  }

  const schedules = []
  const tState = new Map(tinv.objects.filter((o) => o.kind === "TASK" || o.kind === "ALERT").map((o) => [o.name, o.state]))
  for (const o of source.objects.filter((o) => o.kind === "TASK" || o.kind === "ALERT")) {
    schedules.push({ name: `${o.kind} ${o.name}`, source: o.state, target: tState.get(o.name) ?? "MISSING" })
  }

  const checks = []
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail })
      log(`PASS  ${name}${detail ? `: ${detail}` : ""}`)
    } catch (e) {
      const detail = String(e.message ?? e).split("\n")[0]
      checks.push({ name, ok: false, detail })
      log(`FAIL  ${name}: ${detail}`)
    }
  }
  await query(tgt, "USE WAREHOUSE COMPUTE_WH")
  await check("drift test: every governed metric agrees with its canonical fact", async () => {
    await query(tgt, `CALL ${DB}.GOVERNANCE.METRIC_DRIFT_TEST()`)
    const [r] = await query(
      tgt,
      `SELECT COUNT(*) AS N, COUNT_IF(status <> 'PASS') AS F FROM ${DB}.GOVERNANCE.METRIC_DRIFT_RESULT
        WHERE run_id = (SELECT run_id FROM ${DB}.GOVERNANCE.METRIC_DRIFT_RESULT QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1)`,
    )
    if (Number(r.F) > 0) throw new Error(`${r.F} of ${r.N} metrics FAIL`)
    return `${r.N} metrics PASS`
  })
  await check("CI governance gate", async () => {
    const [r] = await query(tgt, `CALL ${DB}.GOVERNANCE.CI_GOVERNANCE_GATE()`)
    return JSON.stringify(Object.values(r)[0]).slice(0, 160)
  })
  await check("cross-region inference matches the source", async () => {
    const v = await accountParam(tgt, "CORTEX_ENABLED_CROSS_REGION")
    if (v !== crossSrc) throw new Error(`target ${v}, source ${crossSrc}`)
    return v
  })
  log("")
  log("Running sql/90-93 on the target (includes executing every verified query)...")
  const v = await runRebuild(["--verify"])
  checks.push({ name: "sql/90-93 verification files execute cleanly", ok: v.ok, detail: v.ok ? "" : `stopped at ${v.stopped}` })

  const totalSource = tables.reduce((a, t) => a + t.sourceRows, 0)
  const totalTarget = tables.reduce((a, t) => a + (t.targetRows ?? 0), 0)
  const verdict =
    missing.length === 0 && tables.every((t) => t.hashMatch) && checks.every((c) => c.ok) && schedules.every((s) => s.source === s.target)
      ? "COMPLETE - every object present, every table content-equal, every check passing"
      : "INCOMPLETE - see the sections below"
  const notes = [
    "GOVERNANCE.NOTIFICATION_SETTING: the steward email is per account (set by sql/06 from --notify-email or the target user's email).",
    "Users, passwords and PATs are not copied. Persona roles were granted to the target user and to any listed app user that exists on the target.",
    "The app's Vercel environment still points at the source until SNOWFLAKE_ACCOUNT / credentials are changed there.",
    "The CI gate user (sql/create_ci_user.sql) is not created by the migration.",
  ]
  const file = writeReport({ source: source.account, target: `${T.who.O}-${T.who.N}`, verdict, kinds, missing, extra, unsupported, tables, totalSource, totalTarget, schedules, checks, notes })
  mark("verify", { verdict })

  log("")
  log(`Objects: ${missing.length ? `${missing.length} MISSING on target` : "all present"}.  Tables: ${tables.filter((t) => t.hashMatch).length}/${tables.length} content-equal (${totalTarget.toLocaleString()}/${totalSource.toLocaleString()} rows).`)
  log(`Verdict: ${verdict}`)
  log(`Report:  ${path.relative(ROOT, file)}`)
  log("")
  src.destroy(() => {})
  tgt.destroy(() => {})
  if (!verdict.startsWith("COMPLETE")) process.exitCode = 1
}

// --selftest A.B,C.D proves the encoding round trip on the source alone: each table is unloaded to
// the user stage exactly as copyTable does, read back through the same load expressions, and its
// COUNT + HASH_AGG compared with the table's. Writes nothing but a scratch folder in @~.
async function selftest() {
  const { conn } = await open(FROM, "selftest")
  // TEMPORARY: lives only for this session, so the self-test leaves no object behind.
  await query(conn, `CREATE TEMPORARY FILE FORMAT ${DB}.PUBLIC.SC_MIGRATE_PARQUET TYPE = PARQUET`)
  const all = await tableColumns(conn)
  let failed = 0
  for (const table of SELFTEST.split(",").map((s) => s.trim().toUpperCase())) {
    const cols = all[table]
    if (!cols) {
      console.log(`  ${table}: no such base table`)
      failed++
      continue
    }
    const folder = `${STAGE}_selftest/${table}/`
    await query(conn, `REMOVE ${folder}`)
    await query(conn, `COPY INTO ${folder} FROM (SELECT ${cols.map((c) => `${exportExpr(c)} AS ${ident(c.name)}`).join(", ")} FROM ${fq(table)}) FILE_FORMAT = (TYPE = PARQUET) HEADER = TRUE OVERWRITE = TRUE`)
    const want = await profile(conn, table, cols)
    const reread = cols.map((c) => `${loadExpr(c)} AS ${ident(c.name)}`).join(", ")
    const [r] = await query(
      conn,
      `WITH t AS (SELECT ${reread} FROM ${folder} (FILE_FORMAT => '${DB}.PUBLIC.SC_MIGRATE_PARQUET'))
       SELECT COUNT(*) AS N, TO_VARCHAR(HASH_AGG(${cols.map(hashExpr).join(", ")})) AS H FROM t`,
    )
    await query(conn, `REMOVE ${folder}`)
    const ok = Number(r.N) === want.rows && (r.H ?? "0") === want.hash
    if (!ok) failed++
    const types = [...new Set(cols.map((c) => c.type))].join(",")
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${table.padEnd(44)} ${want.rows} rows  [${types}]${ok ? "" : `  hash ${r.H} vs ${want.hash}`}`)
  }
  return failed
}


if (SELFTEST) selftest().then((f) => process.exit(f ? 1 : 0), (e) => { console.error(e.message); process.exit(1) })
else main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("")
    console.error(`  ${err?.message ?? err}`)
    console.error("")
    process.exit(1)
  })
