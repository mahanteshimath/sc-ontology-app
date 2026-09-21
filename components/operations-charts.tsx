"use client"

interface Props {
  title: string
  unit: string | null
  data: { label: string; value: number }[]
}

function format(unit: string | null, v: number): string {
  if (unit === "percent") return `${(v * 100).toFixed(2)}%`
  if (unit === "days") return `${v.toFixed(1)}d`
  if (unit === "USD per unit") return `$${v.toFixed(2)}`
  if (unit === "USD") {
    const abs = Math.abs(v)
    const sign = v < 0 ? "-" : ""
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
    return `${sign}$${abs.toFixed(0)}`
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/**
 * Horizontal bar chart for one governed metric broken down by one ontology dimension.
 *
 * Hand-rolled rather than pulled from a charting library: the shape is simple, it keeps the
 * dependency surface small, and bar widths are computed deterministically so the render is
 * identical every time. Colours come from the theme's --chart-* variables so light and dark
 * both stay legible.
 */
export function OperationsCharts({ title, unit, data }: Props) {
  if (data.length === 0) {
    return <div className="text-xs text-muted-foreground p-4">No data returned.</div>
  }

  const values = data.map((d) => d.value)
  const max = Math.max(...values)
  const min = Math.min(...values)

  // Percent and cost metrics cluster tightly, so anchoring every bar at zero hides the
  // differences that matter. Use a baseline just below the minimum instead, and say so.
  const zeroAnchored = min <= 0 || min / max < 0.35
  const base = zeroAnchored ? Math.min(0, min) : min - (max - min) * 0.4
  const span = max - base || 1

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium">{title}</div>
        {!zeroAnchored && (
          <div className="text-[11px] text-muted-foreground" title="Axis does not start at zero">
            axis from {format(unit, base)}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {data.map((d, i) => {
          const pct = Math.max(1.5, ((d.value - base) / span) * 100)
          return (
            <div key={d.label} className="grid grid-cols-[minmax(64px,88px)_1fr_auto] items-center gap-2">
              <div className="text-[11px] text-muted-foreground truncate text-right" title={d.label}>
                {d.label}
              </div>
              <div className="h-4 rounded-sm bg-secondary/60 overflow-hidden">
                <div
                  className="h-full rounded-sm transition-[width]"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: `var(--chart-${(i % 5) + 1}, var(--primary))`,
                  }}
                />
              </div>
              <div className="text-[11px] tabular-nums text-foreground/90 w-[62px] text-right">
                {format(unit, d.value)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
