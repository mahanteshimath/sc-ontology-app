"use client"

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ChartTooltip } from "@/components/chart-utils"

export interface DriftRunPoint {
  runId: string
  runAt: string | null
  metricsChecked: number
  passed: number
  failed: number
  maxSpread: number | null
}

/**
 * Track record of the drift control.
 *
 * A single PASS proves the test passed once. The history shows the control has been running, and
 * that it has caught something — the two red bars are the negative-control runs, where a defective
 * definition was deliberately re-bound to prove the test is capable of failing.
 *
 * Bars are the number of failing metrics per run. A clean run is zero, which recharts draws as a
 * zero-height bar — i.e. nothing at all. That made 9 of 12 runs invisible and the chart read as
 * "only failures exist" while the data said all-pass, so `minPointSize` gives every run a visible
 * floor: a clean run is a green tick on the baseline, present and countable.
 */
export function DriftHistory({ runs }: { runs: DriftRunPoint[] }) {
  if (runs.length === 0) {
    return <p className="u-meta">No drift runs recorded yet.</p>
  }

  // Oldest first so the chart reads left to right in time.
  const data = [...runs].reverse().map((r) => ({
    label: r.runAt ? r.runAt.slice(5, 16).replace("T", " ") : r.runId.slice(0, 8),
    failed: r.failed,
    checked: r.metricsChecked,
    spread: r.maxSpread,
  }))

  const failingRuns = runs.filter((r) => r.failed > 0).length
  const lastRun = runs[0]
  const cleanRuns = runs.length - failingRuns

  return (
    <div className="space-y-3">
      <div style={{ height: 132 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              width={28}
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="failed" name="failing metrics" isAnimationActive={false} minPointSize={3}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.failed > 0 ? "var(--status-bad)" : "var(--status-good)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="u-meta leading-relaxed u-prose">
        {runs.length} recorded run{runs.length === 1 ? "" : "s"}: {cleanRuns} clean, {failingRuns} with a
        failure. Last run {lastRun.runAt?.slice(0, 19).replace("T", " ") ?? "unknown"} checked{" "}
        {lastRun.metricsChecked} metrics with {lastRun.failed} failing. Each bar is one run’s failing-metric
        count — a green tick on the baseline is a clean run. The red runs are the negative controls, where a
        known-defective definition was deliberately re-bound to prove the test can fail.
      </p>
    </div>
  )
}
