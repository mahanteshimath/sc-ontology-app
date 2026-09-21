"use client"

import { useState } from "react"
import { StatusPill, Tag } from "@/components/ui-kit"
import { formatMetric } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface FamilyBaseline {
  family: string
  meanOtd: number
  sdOtd: number
  meanFill: number
  sdFill: number
}

// Measured stationary monthly distributions across 22 full months
export const FAMILY_BASELINES: FamilyBaseline[] = [
  { family: "Abrasives", meanOtd: 0.86837, sdOtd: 0.00353, meanFill: 0.98230, sdFill: 0.00086 },
  { family: "Adhesives", meanOtd: 0.87766, sdOtd: 0.00213, meanFill: 0.98557, sdFill: 0.00056 },
  { family: "Films", meanOtd: 0.85866, sdOtd: 0.00398, meanFill: 0.98061, sdFill: 0.00122 },
  { family: "Respiratory", meanOtd: 0.88740, sdOtd: 0.00250, meanFill: 0.98806, sdFill: 0.00062 },
  { family: "Tapes", meanOtd: 0.90772, sdOtd: 0.00257, meanFill: 0.99189, sdFill: 0.00069 },
]

function calculateBreach(mean: number, sd: number, target: number) {
  if (sd <= 0) return { z: 0, p: 0, verdict: "on-target" as const }
  const z = (target - mean) / sd
  // Logistic approximation to normal CDF: 1 / (1 + exp(-1.702 * z))
  const p = Math.min(1, Math.max(0, 1 / (1 + Math.exp(-1.702 * z))))
  let verdict: "on-target" | "warn" | "off-target" = "on-target"
  let label = "on track"
  if (p >= 0.95) {
    verdict = "off-target"
    label = "will breach without intervention"
  } else if (p >= 0.60) {
    verdict = "off-target"
    label = "more likely than not to breach"
  } else if (p >= 0.20) {
    verdict = "warn"
    label = "at risk"
  }
  return { z, p, verdict, label }
}

export function TargetSimulator() {
  const [metric, setMetric] = useState<"otd_pct" | "fill_rate_pct">("otd_pct")
  const [target, setTarget] = useState<number>(metric === "otd_pct" ? 0.95 : 0.98)

  const handleMetricChange = (m: "otd_pct" | "fill_rate_pct") => {
    setMetric(m)
    setTarget(m === "otd_pct" ? 0.95 : 0.98)
  }

  const presets = metric === "otd_pct" ? [0.86, 0.88, 0.90, 0.92, 0.95] : [0.97, 0.98, 0.985, 0.99, 0.995]

  return (
    <div className="u-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="u-subhead">Interactive Target Reachability &amp; Simulation</h3>
          <p className="u-meta text-muted-foreground">
            Test hypothetical targets against empirical family capability to evaluate if a target is achievable or unreachable.
          </p>
        </div>
        <div className="flex items-center gap-1.5 p-1 rounded-md bg-secondary/60 border border-border">
          <button
            onClick={() => handleMetricChange("otd_pct")}
            className={cn(
              "px-3 py-1 rounded text-xs font-medium transition-colors",
              metric === "otd_pct" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            On-Time Delivery
          </button>
          <button
            onClick={() => handleMetricChange("fill_rate_pct")}
            className={cn(
              "px-3 py-1 rounded text-xs font-medium transition-colors",
              metric === "fill_rate_pct" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Fill Rate
          </button>
        </div>
      </div>

      <div className="p-4 rounded-lg bg-secondary/30 border border-border/80 space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <span className="u-label">Simulate Target Level</span>
            <div className="text-xl font-bold tabular-nums font-mono text-[var(--link)]">
              {(target * 100).toFixed(1)}%
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="u-label mr-1">Presets:</span>
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => setTarget(p)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-mono border transition-colors",
                  Math.abs(target - p) < 0.0001
                    ? "bg-[var(--brand-primary)]/20 border-[var(--brand-primary)] text-foreground font-semibold"
                    : "bg-card/80 border-border text-muted-foreground hover:text-foreground hover:bg-secondary",
                )}
              >
                {(p * 100).toFixed(1)}%
              </button>
            ))}
          </div>
        </div>

        <input
          type="range"
          min={metric === "otd_pct" ? 0.82 : 0.95}
          max={metric === "otd_pct" ? 0.98 : 0.999}
          step={0.001}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          className="w-full accent-[var(--brand-primary)] cursor-pointer"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Product Family</th>
              <th className="px-3 py-2 font-medium text-right">Realized Mean</th>
              <th className="px-3 py-2 font-medium text-right">Monthly SD</th>
              <th className="px-3 py-2 font-medium text-right">Simulated Target</th>
              <th className="px-3 py-2 font-medium text-right">Distance (z-score)</th>
              <th className="px-3 py-2 font-medium text-right">Breach Probability</th>
              <th className="px-3 py-2 font-medium">Assessment</th>
            </tr>
          </thead>
          <tbody>
            {FAMILY_BASELINES.map((b) => {
              const mean = metric === "otd_pct" ? b.meanOtd : b.meanFill
              const sd = metric === "otd_pct" ? b.sdOtd : b.sdFill
              const sim = calculateBreach(mean, sd, target)

              return (
                <tr key={b.family} className="border-b border-border/60 hover:bg-secondary/20">
                  <td className="px-3 py-2.5 font-medium">{b.family}</td>
                  <td className="px-3 py-2.5 text-right u-mono">{formatMetric(mean, "percent")}</td>
                  <td className="px-3 py-2.5 text-right u-mono text-muted-foreground">
                    ±{(sd * 100).toFixed(2)}pp
                  </td>
                  <td className="px-3 py-2.5 text-right u-mono font-semibold text-[var(--link)]">
                    {(target * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right u-mono">
                    {sim.z > 0 ? `+${sim.z.toFixed(1)}σ` : `${sim.z.toFixed(1)}σ`}
                  </td>
                  <td className="px-3 py-2.5 text-right u-mono font-medium">
                    {(sim.p * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill kind="target" status={sim.verdict} label={sim.label} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="p-3 rounded bg-secondary/20 border border-border/70 text-xs text-muted-foreground leading-relaxed">
        <strong>Mathematical formulation:</strong> Z-score is computed as{" "}
        <code className="font-mono text-foreground">(target - mean) / sd</code>. Breach probability uses the
        governed logistic approximation <code className="font-mono text-foreground">1 / (1 + exp(-1.702 * z))</code>.
        Because month-to-month variation is small (0.2–0.4pp), setting a target even 1.5pp above current mean pushes
        breach probability above 95%, mathematically demonstrating process capability limits.
      </div>
    </div>
  )
}
