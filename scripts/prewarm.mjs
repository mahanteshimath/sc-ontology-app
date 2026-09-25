/**
 * Pre-warms the Snowflake warehouse and /api/ask path before a live demo.
 *
 * /api/ask is measured at ~13.8s cold vs 4.8-10.9s warm (see README, "The Ask module").
 * A judge's first click should not be the cold one. Run this a few minutes before
 * presenting; it throws away its own answer.
 *
 * Usage:
 *   node scripts/prewarm.mjs
 *   SMOKE_BASE=https://sc-ontology-app.vercel.app SMOKE_PASSWORD=... node scripts/prewarm.mjs
 */
import fs from "node:fs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const username = process.env.SMOKE_USER ?? "logistics"
const password =
  process.env.SMOKE_PASSWORD ??
  fs.readFileSync(".env.local", "utf8").match(/DEMO_USERS=planner:([^:]+):/)[1]

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
if (!login.ok) {
  console.error(`sign-in failed: ${login.status} ${await login.text()}`)
  process.exit(1)
}
const cookie = login.headers.getSetCookie()[0].split(";")[0]

const started = Date.now()
const res = await fetch(`${BASE}/api/ask`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    question: "What is our supplier on-time delivery?",
    persona: "SC_LOGISTICS",
    history: [],
  }),
})
const ms = Date.now() - started
console.log(res.ok ? `Warmed in ${ms}ms against ${BASE} — safe to demo.` : `Warm-up call failed: ${res.status}`)
process.exit(res.ok ? 0 : 1)
