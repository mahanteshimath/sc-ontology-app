import { formatNumber } from "@/lib/format"
import { type MetricOutlook } from "@/lib/sc"

export function VolumeForecastChart({ forecasts }: { forecasts: MetricOutlook[] }) {
  if (!forecasts || forecasts.length === 0) return null

  const maxVal = Math.max(...forecasts.map((f) => f.upperBound ?? f.predictedValue ?? 0)) * 1.05
  const minVal = Math.min(...forecasts.map((f) => f.lowerBound ?? f.predictedValue ?? 0)) * 0.95

  return (
    <div className="u-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="u-subhead">Order-Line Volume Forecast with 95% Confidence Intervals</h3>
          <p className="u-meta text-muted-foreground">
            Trained on 22 full months via <code className="u-mono">SNOWFLAKE.ML.FORECAST</code>. Level + days-in-month effect.
          </p>
        </div>
        <div className="flex items-center gap-2 u-meta">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-[var(--brand-primary)]" /> Point Forecast
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-[var(--brand-primary)]/25 border border-[var(--brand-primary)]/50" /> 95% Interval
          </span>
        </div>
      </div>

      <div className="space-y-4 pt-2">
        {forecasts.map((f) => {
          const pred = f.predictedValue ?? 0
          const lower = f.lowerBound ?? pred
          const upper = f.upperBound ?? pred

          // Percent positions across range [minVal, maxVal]
          const leftPct = Math.max(0, Math.min(100, ((lower - minVal) / (maxVal - minVal)) * 100))
          const rightPct = Math.max(0, Math.min(100, ((upper - minVal) / (maxVal - minVal)) * 100))
          const widthPct = Math.max(2, rightPct - leftPct)
          const pointPct = Math.max(0, Math.min(100, ((pred - minVal) / (maxVal - minVal)) * 100))

          return (
            <div key={f.horizonPeriod} className="space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold">{f.horizonPeriod}</span>
                <div className="flex items-center gap-3 u-mono">
                  <span className="text-muted-foreground">
                    CI: {formatNumber(Math.round(lower))} – {formatNumber(Math.round(upper))}
                  </span>
                  <span className="font-bold text-foreground">
                    {formatNumber(Math.round(pred))} lines
                  </span>
                </div>
              </div>

              {/* Visual Interval Bar */}
              <div className="h-6 w-full rounded bg-secondary/60 relative overflow-hidden border border-border">
                {/* Confidence interval range */}
                <div
                  className="absolute top-1 bottom-1 rounded bg-[var(--brand-primary)]/20 border-x border-[var(--brand-primary)]"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
                {/* Point forecast marker */}
                <div
                  className="absolute top-0 bottom-0 w-1.5 bg-[var(--brand-primary)] rounded-full shadow"
                  style={{ left: `calc(${pointPct}% - 3px)` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
