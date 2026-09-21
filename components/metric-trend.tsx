"use client"

import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ChartTooltip } from "@/components/chart-utils"
import { formatAxisTick } from "@/lib/format"
import type { RagState } from "@/lib/target"

export interface TrendPoint {
  /** Period label, e.g. "2026-08". */
  period: string
  /** Null where the period returned no rows — deliberately not interpolated. */
  value: number | null
}

/**
 * Axis ticks.
 *
 * Delegates to lib/format so the registry's own unit vocabulary works. The local copy this replaced
 * tested for "percent" and "USD", while app/page.tsx passes `metric.unit` straight from
 * GOVERNANCE.METRIC_DEFINITION, which spells them "ratio" and "usd" — so no branch matched and the
 * on-time-delivery axis was labelled 0.88 instead of 88%.
 */
function tick(unit: string | null, v: number): string {
  return formatAxisTick(v, unit)
}

/**
 * Month-by-month trend for one governed metric, with its target drawn as a reference line.
 *
 * Nulls are passed through rather than interpolated: a month with no rows is a gap in the data,
 * and drawing a straight line across it would invent a measurement that was never taken.
 * `connectNulls` is therefore left off.
 *
 * The y-axis is not anchored at zero. These metrics cluster tightly — on-time delivery moves
 * between 82% and 88% — so a zero-anchored axis would render every month as an identical bar and
 * hide the only thing the chart exists to show. The axis range is stated in the caption instead.
 *
 * The line takes the metric's RAG colour. Previously every sparkline was the same brand cyan, which
 * made the largest coloured area on each card the one element carrying no information at all.
 */
export function MetricTrend({
  data,
  unit,
  target,
  height = 72,
  state,
}: {
  data: TrendPoint[]
  unit: string | null
  target?: number | null
  height?: number
  state?: RagState
}) {
  const present = data.filter((d) => d.value !== null).map((d) => d.value as number)
  if (present.length < 2) {
    return (
      <div className="u-meta h-[72px] flex items-center">
        Not enough periods in range to plot a trend.
      </div>
    )
  }

  const stroke =
    state === "on-target"
      ? "var(--status-good)"
      : state === "warn"
        ? "var(--status-warn)"
        : state === "off-target"
          ? "var(--status-bad)"
          : "var(--primary)"

  const candidates = target != null ? [...present, target] : present
  const lo = Math.min(...candidates)
  const hi = Math.max(...candidates)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.15

  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
            <XAxis dataKey="period" hide />
            <YAxis
              domain={[lo - pad, hi + pad]}
              width={38}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => tick(unit, v)}
              axisLine={false}
              tickLine={false}
            />
            {target != null && (
              <ReferenceLine
                y={target}
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
                strokeWidth={1}
              />
            )}
            <Tooltip content={<ChartTooltip />} />
            <Line
              type="monotone"
              dataKey="value"
              name="value"
              stroke={stroke}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="u-mono text-muted-foreground flex justify-between gap-2 mt-1">
        <span>{data[0]?.period}</span>
        {target != null && <span>dashed = target {tick(unit, target)}</span>}
        <span>{data[data.length - 1]?.period}</span>
      </div>
    </div>
  )
}
