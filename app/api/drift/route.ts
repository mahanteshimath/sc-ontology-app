/**
 * Runs the governed metric drift test and returns a pass/fail summary.
 *
 * POST /api/drift
 *
 * The procedure evaluates every metric in GOVERNANCE.METRIC_DEFINITION through every
 * semantic view bound to it in GOVERNANCE.METRIC_BINDING, compares each against the
 * canonical atomic-grain fact, and writes one row per metric to METRIC_DRIFT_RESULT.
 */

import { runDriftTest } from "@/lib/sc"

export const dynamic = "force-dynamic"

/**
 * The procedure takes ~25s. Vercel Hobby caps functions well below this, which is why the UI
 * disables the button there (see lib/env.ts); this ceiling is for hosts that allow it.
 */
export const maxDuration = 300

export async function POST() {
  try {
    const rows = await runDriftTest()
    const failed = rows.filter((r) => r.status !== "PASS")
    return Response.json({
      total: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      failures: failed.map((f) => ({
        metricId: f.metricId,
        spread: f.valueSpread,
        detail: f.detail,
      })),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[drift] metric drift test failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to run the drift test" },
      { status: 500 },
    )
  }
}
