/**
 * Edge-case probe for the reporting-period controls against a deployed instance.
 *
 * The attached URL was `/?asOf%3D2027-03-31` — the `=` is percent-encoded, so the query string is a
 * single parameter *named* `asOf=2027-03-31` with an empty value, and there is no `asOf` key at all.
 * That must fall back to the default as-of date rather than throwing. The correctly-formed version
 * asks a different and more interesting question: an as-of date months past the end of the data
 * (which stops at 2026-11-25), where several periods contain no rows whatsoever.
 *
 * Usage: SMOKE_BASE=<url> SMOKE_USER=<u> SMOKE_PASSWORD=<p> node scripts/probe-asof.mjs
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000"
const USER = process.env.SMOKE_USER ?? "planner"
const PASSWORD = process.env.SMOKE_PASSWORD

const CASES = [
  ["attached URL (encoded =)", "/?asOf%3D2027-03-31"],
  ["asOf past end of data", "/?asOf=2027-03-31"],
  ["asOf future + last-month (empty period)", "/?period=last-month&asOf=2027-03-31"],
  ["asOf future + t12m", "/?period=t12m&asOf=2027-03-31"],
  ["asOf before any data", "/?asOf=2024-01-01"],
  ["non-date asOf", "/?asOf=not-a-date"],
  ["inverted custom range", "/?from=2026-08-31&to=2026-06-01"],
  ["custom range entirely in the future", "/?from=2027-01-01&to=2027-03-31"],
  ["operations, asOf past end of data", "/operations?asOf=2027-03-31"],
  ["metrics (period-independent)", "/metrics?asOf=2027-03-31"],
]

const first = (html, re) => {
  const m = html.match(re)
  return m ? m[1] : null
}

let failures = 0

const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASSWORD }),
})
if (!res.ok) {
  console.error(`sign-in failed: ${res.status}`)
  process.exit(1)
}
const cookie = res.headers.getSetCookie()[0].split(";")[0]

for (const [name, path] of CASES) {
  const started = Date.now()
  let status = 0
  let html = ""
  try {
    const r = await fetch(BASE + path, { headers: { cookie } })
    status = r.status
    html = await r.text()
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(40)} request threw: ${e.message}`)
    failures++
    continue
  }

  // A section boundary rendering its error state is a failure even though the page returns 200.
  const sectionError = /could not be loaded/i.test(html)
  const appError = /Application error|Internal Server Error|Unhandled Runtime/i.test(html)
  const ok = status === 200 && !sectionError && !appError

  const asOf = first(html, /type="date"[^>]*value="(\d{4}-\d{2}-\d{2})"/)
  const range = first(html, /(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2})/)
  const emptyTrend = /Not enough periods in range/.test(html)
  const dashes = (html.match(/>—</g) ?? []).length

  if (!ok) failures++
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name.padEnd(40)} ${status} ${((Date.now() - started) / 1000).toFixed(1)}s` +
      `  asOf=${asOf ?? "?"}  range=${range ?? "-"}` +
      `${emptyTrend ? "  [no-trend]" : ""}${dashes ? `  [${dashes} em-dash]` : ""}` +
      `${sectionError ? "  <<SECTION ERROR>>" : ""}${appError ? "  <<APP ERROR>>" : ""}`,
  )
}

console.log(failures === 0 ? "\nAll period edge cases handled." : `\n${failures} case(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
