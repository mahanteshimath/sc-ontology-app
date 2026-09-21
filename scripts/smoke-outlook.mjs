/**
 * Verifies the /outlook page renders governed predictions end to end.
 *
 * Separate from smoke.mjs because it needs the prediction registry to be populated, which is a
 * Snowflake-side step (CALL GOVERNANCE.PREDICT_TARGET_BREACH) rather than part of the app.
 */
import fs from "node:fs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const password =
  process.env.SMOKE_PASSWORD ??
  fs.readFileSync(".env.local", "utf8").match(/DEMO_USERS=planner:([^:]+):/)[1]
const username = process.env.SMOKE_USER ?? "planner"

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
if (!login.ok) {
  console.error(`sign-in failed: ${login.status}`)
  process.exit(1)
}
const cookie = login.headers.getSetCookie()[0].split(";")[0]

const res = await fetch(`${BASE}/outlook`, { headers: { cookie } })
const html = await res.text()

const checks = [
  ["page returns 200", res.status === 200, `status ${res.status}`],
  ["no section failed to load", !/could not be loaded/.test(html), ""],
  ["breach tile present", /Will breach target/.test(html), ""],
  ["method accuracy shown", /Method accuracy/.test(html), ""],
  ["per-family rows present", /Films/.test(html) && /Tapes/.test(html), ""],
  ["verdict rendered", /will breach without intervention/.test(html), ""],
  ["at-risk case discriminated", /at risk/.test(html), ""],
  ["volume forecast section", /Order-line volume forecast/.test(html), ""],
  ["stationarity disclosed", /stationary/.test(html), ""],
  ["backtest accuracy disclosed", /99\.\d%/.test(html), (html.match(/99\.\d%/) ?? ["none"])[0]],
  ["governance rules stated", /A prediction is not a measurement/.test(html), ""],
]

let failures = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failures++
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` \u2014 ${detail}` : ""}`)
}
console.log(failures === 0 ? "\nOutlook page verified." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
