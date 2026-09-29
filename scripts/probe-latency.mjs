/**
 * Measures the /api/ask resolver cache against a running server, and re-checks the two ambiguity
 * questions from the evaluation set (Q54, Q55).
 *
 *   npm run dev
 *   node scripts/probe-latency.mjs
 *
 * The second ask of the same question should report resolverCached=true and return the SAME value,
 * because the governed query runs live on every turn; only the question-to-metric mapping is reused.
 */

import fs from "node:fs"

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const env = fs.readFileSync(".env.local", "utf8")
const line = env.split("\n").find((l) => l.startsWith("DEMO_USERS="))
// The evaluation scores persona-less questions as the steward (broadest grants), so probe as it too.
const PROBE_ROLE = process.env.PROBE_ROLE ?? "SC_ONTOLOGY_STEWARD"
const users = line.replace("DEMO_USERS=", "").trim().split(";").map((u) => u.split(":"))
const [username, password] = users.find((u) => u[2] === PROBE_ROLE) ?? users[0]

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
const cookie = login.headers.getSetCookie()[0]?.split(";")[0]
if (!cookie) throw new Error(`sign-in failed: ${login.status}`)

async function ask(question) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ question, period: "last-month" }),
  }).then((res) => res.json())
  const ms = Date.now() - t0
  const col = r.metrics?.[0]?.column
  return {
    ms,
    cached: r.resolverCached ?? false,
    answerable: r.answerable,
    metrics: (r.metrics ?? []).map((m) => m.metricId),
    value: col ? r.rows?.[0]?.[col] : null,
    reason: r.reason,
  }
}

const q = "What is our OTIF rate?"
const cold = await ask(q)
const warm = await ask(q)
console.log(`cold  ${cold.ms} ms  cached=${cold.cached}  ${cold.metrics.join(",")}=${cold.value}`)
console.log(`warm  ${warm.ms} ms  cached=${warm.cached}  ${warm.metrics.join(",")}=${warm.value}`)
console.log(`same value: ${cold.value === warm.value}  saved: ${cold.ms - warm.ms} ms`)

for (const [id, question] of [
  ["Q54", "What is our on-time delivery?"],
  ["Q55", "What are our freight costs?"],
]) {
  const r = await ask(question)
  const pass = !r.answerable || r.metrics.length >= 2
  console.log(`${id} ${pass ? "PASS" : "FAIL"}  answerable=${r.answerable}  metrics=${r.metrics.join(",") || "-"}  ${r.reason}`)
}
