/**
 * Runtime environment detection.
 *
 * The app runs in three places with different constraints:
 *   - local dev / `next start`      — no limits, everything interactive
 *   - Vercel                        — serverless function time limits
 *   - Snowflake App Runtime (SPCS)  — no practical limit
 *
 * Only the Vercel case needs behaviour changes, so that is the only one detected here.
 *
 * ON THE VERCEL TIME LIMIT, MEASURED RATHER THAN ASSUMED.
 * This file previously asserted a flat 10s ceiling on Hobby. That is no longer true of this
 * deployment: scripts/smoke-chat.mjs recorded /api/ask completing successfully at 11.5s and 12.0s in
 * production, which a 10s ceiling would have killed. The routes declare their own `maxDuration`, and
 * the platform honours it up to the plan maximum.
 *
 * The exact ceiling is deliberately NOT restated here as a number, because the last hardcoded number
 * silently went stale and started driving behaviour that was no longer justified. Measure it with the
 * smoke script rather than trusting a comment — including this one.
 */

/** True when running on Vercel, where serverless functions are time-limited. */
export function isVercel(): boolean {
  return Boolean(process.env.VERCEL)
}

/**
 * Whether the governed drift test can be triggered from the UI.
 *
 * The procedure takes ~25s because it evaluates every metric through every semantic view that
 * serves it. On Vercel the UI shows the last stored result instead of offering a re-run. The result
 * itself is identical either way — it is read from GOVERNANCE.METRIC_DRIFT_RESULT, which the
 * procedure writes.
 *
 * KEPT DISABLED ON PURPOSE, AND THE REASON IS NOW WEAKER THAN IT WAS. This guard was introduced
 * because 25s exceeded an assumed 10s limit. That assumption has since been disproven (see above),
 * so 25s may well now complete. It stays disabled because nobody has measured it: re-enabling a
 * 25-second request on the strength of a 12-second observation would be replacing one unverified
 * number with another. Measure the procedure against the deployment first, then change this.
 */
export function canRunDriftTest(): boolean {
  return !isVercel()
}

/** Short label for where the app is running, shown in the UI footer. */
export function runtimeLabel(): string {
  if (isVercel()) return "Vercel"
  return "local"
}

/**
 * Whether governed metric reads should run with the calling user's own Snowflake grants.
 *
 * Off by default, and deliberately opt-in rather than inferred. Caller's rights is the right answer
 * inside Snowflake App Runtime, where the platform authenticates a real Snowflake user — but only
 * once that user has been granted SELECT on the semantic views. Today only the five SC_* persona
 * roles have those grants, so enabling this by default would turn every page into an authorisation
 * error for anyone else. Enabling it is therefore a deployment decision, made after the grants
 * exist, not a guess made at runtime.
 *
 * Set CALLERS_RIGHTS=1 (app.yml `environment_variables`) to turn it on. Outside SPCS the flag has
 * no effect: lib/snowflake.ts ignores caller's rights when there is no service token, because there
 * is no caller identity to run as.
 *
 * What it does NOT change: the persona comparison on /consistency and the persona-scoped execution
 * in /api/ask both need to run as a *named* role rather than as the caller, so they keep using
 * lib/persona.ts either way.
 */
export function useCallersRights(): boolean {
  const v = process.env.CALLERS_RIGHTS
  return v === "1" || v === "true"
}
