"use client"

/**
 * Charts for a governed answer.
 *
 * Renders the ChartSpec that lib/chart.ts derived on the server. The component makes no decisions
 * about what to plot: chart type, series grouping, category ordering and truncation are all settled
 * before the payload arrives, so the same question always looks the same.
 *
 * ONE PANEL PER UNIT, ALWAYS. The spec groups series by unit and this renders one chart per group.
 * Putting on-time delivery (0.885) and total landed cost (1.98e9) on a shared axis would flatten the
 * percentage onto the baseline — present, unreadable, and implying a relationship between two series
 * that merely appeared in the same answer.
 *
 * A metric with a governed target gets that target drawn as a reference line, because "88.5%" and
 * "88.5% against a 95% target" support completely different conclusions and the chart is where that
 * comparison is cheapest to make.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ChartTooltip } from "@/components/chart-utils"
import { formatAxisTick, formatMetricValue, axisDecimals } from "@/lib/format"
import type { ChartPanel, ChartSpec } from "@/lib/chart"

/**
 * Series colours.
 *
 * Taken from CSS variables so the charts follow the app's theme rather than carrying their own
 * palette that drifts out of step with it.
 *
 * Each carries an explicit fallback. A missing CSS variable does not warn, it just yields an empty
 * value and the mark renders black — which is exactly what happened before --chart-1..5 were defined
 * in globals.css. The fallback means a future theme that drops one of them degrades to the brand
 * colour instead of to black.
 */
const SERIES_COLORS = [
  "var(--chart-1, var(--primary))",
  "var(--chart-2, var(--primary))",
  "var(--chart-3, var(--primary))",
  "var(--chart-4, var(--primary))",
  "var(--chart-5, var(--primary))",
]

const MISS_COLOR = "var(--status-bad, var(--destructive))"

/** Whether a value fails its governed target, given which direction is good. */
function missesTarget(value: number, target: number | null, direction: string | null): boolean {
  if (target === null || !Number.isFinite(value)) return false
  return direction === "LOWER" ? value > target : value < target
}

/**
 * Tooltip that formats each series in its own unit.
 *
 * The shared ChartTooltip renders raw numbers, which would show 0.885475 directly under an axis
 * labelled 88% — the inconsistency reads as two different figures.
 */
function UnitTooltip({
  active,
  payload,
  label,
  panel,
}: {
  active?: boolean
  payload?: { dataKey: string; value: number; color: string; name: string }[]
  label?: string
  panel: ChartPanel
}) {
  if (!active || !payload?.length) return null
  return (
    <div
      style={{
        background: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
        minWidth: 140,
      }}
    >
      {label && <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{label}</p>}
      {payload.map((entry) => {
        const series = panel.series.find((s) => s.column === entry.dataKey)
        return (
          <p key={entry.dataKey} style={{ color: entry.color, margin: 0 }}>
            {series?.label ?? entry.name}: {formatMetricValue(entry.value, series?.unit ?? panel.unit)}
          </p>
        )
      })}
    </div>
  )
}

/**
 * Y-axis bounds.
 *
 * Deliberately NOT anchored at zero for rate metrics. On-time delivery moving between 86% and 91% is
 * the entire story, and a 0–100% axis compresses that into four pixels of visual difference. The
 * domain is padded around the observed range instead, and the target line is always kept in view so
 * the axis cannot crop away the comparison that matters.
 */
function domainFor(panel: ChartPanel, rows: Record<string, any>[]): [number, number] | undefined {
  const values: number[] = []
  for (const s of panel.series) {
    for (const r of rows) {
      const n = Number(r[s.column])
      if (Number.isFinite(n)) values.push(n)
    }
    if (s.target !== null && Number.isFinite(Number(s.target))) values.push(Number(s.target))
  }
  if (values.length === 0) return undefined

  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return undefined

  const pad = (max - min) * 0.12
  // Never cross zero for a series that is entirely non-negative: a negative axis floor on a rate
  // implies values that cannot occur.
  const lower = min >= 0 ? Math.max(0, min - pad) : min - pad
  return [lower, max + pad]
}

function Panel({
  panel,
  spec,
  rows,
  index,
}: {
  panel: ChartPanel
  spec: ChartSpec
  rows: Record<string, any>[]
  index: number
}) {
  const dimCol = spec.dimensionColumn as string
  const domain = domainFor(panel, rows)
  const single = panel.series.length === 1
  const target = single ? panel.series[0].target : null

  // Tick precision comes from how wide the axis actually is, so a narrow range does not collapse
  // into five ticks all reading "98%".
  const decimals = domain ? axisDecimals(panel.unit, domain[1] - domain[0]) : undefined
  const tick = (v: number) => formatAxisTick(v, panel.unit, decimals)

  // Long category names need room; a time axis does not.
  const longLabels =
    spec.kind === "bar" && rows.some((r) => String(r[dimCol] ?? "").length > 10)

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="u-meta">
          {panel.series.map((s) => s.label).join(" · ")}
          <span className="text-muted-foreground"> — {panel.unitLabel}</span>
        </p>
        {target !== null && (
          <p className="u-meta text-muted-foreground">
            target {formatMetricValue(target, panel.unit)}
          </p>
        )}
      </div>

      <div style={{ width: "100%", height: spec.kind === "bar" ? Math.max(180, rows.length * 22 + 60) : 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          {spec.kind === "line" ? (
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey={dimCol} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                width={56}
                {...(domain ? { domain } : {})}
                tickFormatter={(v: number) => tick(v)}
              />
              <Tooltip content={<UnitTooltip panel={panel} />} />
              {!single && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {target !== null && (
                <ReferenceLine
                  y={target}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              )}
              {panel.series.map((s, i) => (
                <Line
                  key={s.column}
                  type="monotone"
                  dataKey={s.column}
                  name={s.label}
                  stroke={SERIES_COLORS[(index + i) % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  // Gaps are shown as gaps. Joining across a period that returned no rows would
                  // invent a trend line through data that does not exist.
                  connectNulls={false}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 4, left: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                {...(domain ? { domain } : {})}
                tickFormatter={(v: number) => tick(v)}
              />
              <YAxis
                type="category"
                dataKey={dimCol}
                tick={{ fontSize: 11 }}
                stroke="var(--muted-foreground)"
                width={longLabels ? 132 : 88}
                interval={0}
              />
              <Tooltip content={<UnitTooltip panel={panel} />} />
              {!single && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {target !== null && (
                <ReferenceLine
                  x={target}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              )}
              {panel.series.map((s, i) => (
                <Bar key={s.column} dataKey={s.column} name={s.label} radius={[0, 3, 3, 0]}>
                  {rows.map((r, ri) => (
                    <Cell
                      key={ri}
                      // Single-series bars are tinted red where they miss the governed target, so
                      // "which of these is a problem" is answerable without reading the axis. With
                      // several series that recolouring would collide with the legend, so the
                      // series colour wins.
                      fill={
                        single && missesTarget(Number(r[s.column]), s.target, s.direction)
                          ? MISS_COLOR
                          : SERIES_COLORS[(index + i) % SERIES_COLORS.length]
                      }
                    />
                  ))}
                </Bar>
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function AskCharts({
  spec,
  rows,
}: {
  spec: ChartSpec
  rows: Record<string, any>[]
}) {
  if (spec.kind === "none" || spec.panels.length === 0 || rows.length === 0) return null

  return (
    <div className="space-y-4">
      {/*
        Small multiples when the answer mixes units. Two panels sit side by side on a wide screen and
        stack on a narrow one; three or more always stack, because a 33%-width bar chart with
        category labels is unreadable.
      */}
      <div className={spec.panels.length === 2 ? "grid gap-5 lg:grid-cols-2" : "space-y-5"}>
        {spec.panels.map((panel, i) => (
          <Panel key={panel.unitLabel + i} panel={panel} spec={spec} rows={rows} index={i} />
        ))}
      </div>

      {spec.note && <p className="u-meta text-muted-foreground">{spec.note}</p>}

      {spec.panels.length > 1 && (
        <p className="u-meta text-muted-foreground">
          Shown as separate panels because these metrics have different units — plotting them on one
          axis would flatten the smaller scale onto the baseline.
        </p>
      )}
    </div>
  )
}
