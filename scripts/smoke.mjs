/**
 * End-to-end smoke test against a running dev server.
 *
 * Not part of `npm test` — it requires a live server and real Snowflake credentials. Run it after a
 * change that touches data access:
 *
 *   npm run dev            # in one shell
 *   node scripts/smoke.mjs # in another
 *
 * Unit tests mock lib/snowflake, so they cannot catch the failures that matter most here: a filter
 * that Snowflake rejects, a semantic-view reference that no longer exists, or a persona role the
 * deployment cannot assume.
 *
 * To run it against a deployment rather than localhost, supply the target and a credential that
 * exists there — the deployed DEMO_USERS is deliberately not the local one:
 *
 *   SMOKE_BASE=https://… SMOKE_USER=planner SMOKE_PASSWORD=… node scripts/smoke.mjs
 */

import fs from "node:fs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"

function demoCredentials() {
  // An explicit credential wins, so a remote deployment can be tested without its passwords ever
  // being written to a file in the repo.
  if (process.env.SMOKE_USER && process.env.SMOKE_PASSWORD) {
    return {
      username: process.env.SMOKE_USER,
      password: process.env.SMOKE_PASSWORD,
      role: process.env.SMOKE_ROLE ?? "(unknown)",
    }
  }
  const env = fs.readFileSync(".env.local", "utf8")
  const line = env.split("\n").find((l) => l.startsWith("DEMO_USERS="))
  if (!line) throw new Error("DEMO_USERS is not set in .env.local, and SMOKE_USER/SMOKE_PASSWORD are unset")
  const [username, password, role] = line.replace("DEMO_USERS=", "").split(";")[0].split(":")
  return { username, password, role }
}

let failures = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const { username, password, role } = demoCredentials()

// --- the gate ---------------------------------------------------------------
const anonPage = await fetch(`${BASE}/`, { redirect: "manual" })
check("unauthenticated page is redirected", anonPage.status === 307, `status ${anonPage.status}`)

const anonApi = await fetch(`${BASE}/api/drilldown`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
})
check("unauthenticated API is refused", anonApi.status === 401, `status ${anonApi.status}`)

const badLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password: "definitely-wrong" }),
})
check("wrong password is refused", badLogin.status === 401, `status ${badLogin.status}`)

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
check("sign-in succeeds", login.status === 200, `status ${login.status}`)
const cookie = login.headers.getSetCookie()[0]?.split(";")[0]
if (!cookie) {
  console.error("no session cookie returned; aborting")
  process.exit(1)
}

// --- pages ------------------------------------------------------------------
for (const path of [
  "/?period=last-month",
  "/?period=t3m",
  "/?period=all",
  "/operations?period=last-month",
  "/metrics",
  "/ontology",
  "/consistency",
  "/ask",
]) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  const body = await res.text()
  const sectionError = /could not be loaded/.test(body)
  check(
    `GET ${path}`,
    res.status === 200 && !sectionError,
    `${res.status}, ${((Date.now() - t0) / 1000).toFixed(1)}s${sectionError ? ", SECTION ERROR" : ""}`,
  )
}

// --- drill-down reconciles --------------------------------------------------
const drill = await fetch(`${BASE}/api/drilldown`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ metricId: "supplier_otd_pct", period: "last-month", limit: 5 }),
}).then((r) => r.json())
check("drill-down returns exception rows", drill.total > 0 && drill.rows?.length === 5, `total ${drill.total}`)
check("drill-down excludes future-dated rows", /CURRENT_DATE\(\)/.test(drill.sql ?? ""))

// --- persona is enforced ----------------------------------------------------
const ask = await fetch(`${BASE}/api/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ question: "What is our on-time delivery to customers?", persona: role, period: "last-month" }),
}).then((r) => r.json())
check("ask resolves to a governed metric", ask.answerable === true, ask.reason ?? ask.error)
check("ask executes as the persona role", (ask.executedAs ?? "").includes(role), ask.executedAs)
check("ask reports no persona error", !ask.personaError, ask.personaError ?? "")

const escalate = await fetch(`${BASE}/api/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ question: "OTD?", persona: "SC_ONTOLOGY_STEWARD" }),
})
check("persona escalation is refused", escalate.status === 403, `status ${escalate.status}`)

const offOntology = await fetch(`${BASE}/api/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ question: "What is our average customer satisfaction score?", persona: role }),
}).then((r) => r.json())
check("off-ontology question is refused, not invented", offOntology.answerable === false, offOntology.reason)

// --- cross-persona consistency ---------------------------------------------
const consistency = await fetch(`${BASE}/api/consistency`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ metricId: "supplier_otd_pct" }),
}).then((r) => r.json())
check(
  "all unscoped personas agree exactly",
  consistency.agreement === "EXACT" && consistency.observations >= 2,
  `${consistency.agreement}, ${consistency.observations} observations, ${consistency.distinctValues} distinct`,
)

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
