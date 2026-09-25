/**
 * Run one SQL statement against the configured account and print the rows as JSON.
 *
 *   node scripts/sq.mjs "select current_role()"
 *   node scripts/sq.mjs --file sql/90_verify_base.sql
 *
 * For ad-hoc inspection only. Anything that must survive belongs in sql/ and runs through
 * scripts/rebuild.mjs, which is the complete replayable record of the database.
 */
import fs from "node:fs"
import { connect, query } from "./sf.mjs"

const argv = process.argv.slice(2)
const fileIdx = argv.indexOf("--file")
const sql = fileIdx >= 0 ? fs.readFileSync(argv[fileIdx + 1], "utf8") : argv.join(" ")
if (!sql.trim()) {
  console.error('Usage: node scripts/sq.mjs "<sql>"  |  node scripts/sq.mjs --file <path>')
  process.exit(1)
}

const conn = await connect("sc-ontology-sq")
// Multi-statement files need the count declared up front; 0 means "however many there are".
if (fileIdx >= 0) await query(conn, "ALTER SESSION SET MULTI_STATEMENT_COUNT = 0")
const rows = await query(conn, sql)
console.log(JSON.stringify(rows, null, 2))
process.exit(0)
