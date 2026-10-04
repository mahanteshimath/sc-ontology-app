"use client"

/**
 * Second opinion from Cortex Analyst for one governed answer.
 *
 * The registry engine produced the number above. This asks Cortex Analyst the same question over the
 * same semantic view, under the same persona role, and says whether the two agree. Agreement is
 * evidence that the answer is a property of the semantic layer rather than of one resolver; a
 * disagreement is shown, not hidden, because that is exactly what a judge or auditor needs to see.
 */

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Scale } from "lucide-react"
import { Tag } from "@/components/ui-kit"
import { formatMetricValue } from "@/lib/format"

interface GovernedMetric {
  metricId: string
  businessName: string
  column: string
  unit: string | null
  reference: string
}

interface AnalystResponse {
  answerable: boolean
  executedAs: string
  interpretation: string | null
  sql?: string
  rows?: Record<string, unknown>[]
  rejected?: string
  error?: string
  verifiedQueryUsed: string | null
  models: string[]
  latencyMs?: number
}

/** Relative tolerance: both paths aggregate the same metric, so only float formatting may differ. */
const TOLERANCE = 1e-6

/** Pick Analyst's value for a governed metric: by metric column name, else the sole numeric column. */
function analystValue(row: Record<string, unknown>, m: GovernedMetric): number | null {
  const want = m.reference.split(".").pop()?.toUpperCase()
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase() === want || k.toUpperCase() === m.column) return v === null ? null : Number(v)
  }
  const numeric = Object.values(row).filter((v) => typeof v === "number" || (v !== null && v !== "" && !isNaN(Number(v))))
  return numeric.length === 1 ? Number(numeric[0]) : null
}

export function AnalystCrossCheck({
  question,
  metrics,
  governedRow,
  period,
}: {
  question: string
  metrics: GovernedMetric[]
  governedRow: Record<string, unknown>
  /** The governed answer's window. Analyst must be asked about the same one, or a correct
   *  all-time figure would read as a disagreement with a correct trailing-12-month figure. */
  period?: { from: string | null; to: string | null }
}) {
  const scoped =
    period?.from && period?.to
      ? `${question} Only include events dated from ${period.from} to ${period.to} inclusive.`
      : question
  const [open, setOpen] = useState(false)
  const mutation = useMutation({
    mutationFn: async (): Promise<AnalystResponse> => {
      const r = await fetch("/api/ask/analyst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: scoped }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      return j
    },
  })

  const data = mutation.data
  const row = data?.rows?.length === 1 ? data.rows[0] : null
  const comparisons = row
    ? metrics.map((m) => {
        const governed = governedRow[m.column] === null ? null : Number(governedRow[m.column])
        const analyst = analystValue(row, m)
        const agree =
          governed !== null && analyst !== null &&
          Math.abs(governed - analyst) <= TOLERANCE * Math.max(1, Math.abs(governed))
        return { m, governed, analyst, agree }
      })
    : []
  const allAgree = comparisons.length > 0 && comparisons.every((c) => c.agree)

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Scale className="h-3.5 w-3.5 text-[var(--link)]" aria-hidden />
          <span className="u-label">Cortex Analyst cross-check</span>
          {data && comparisons.length > 0 && (
            <span className={allAgree ? "u-good" : "u-warn"} data-testid="analyst-agreement">
              {allAgree ? "Agrees with governed answer" : "Differs from governed answer"}
            </span>
          )}
        </div>
        {!data && (
          <button
            type="button"
            onClick={() => { setOpen(true); mutation.mutate() }}
            disabled={mutation.isPending}
            className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            {mutation.isPending ? "Asking Cortex Analyst…" : "Ask Cortex Analyst too"}
          </button>
        )}
      </div>

      {open && mutation.isError && <p className="u-warn text-xs">{(mutation.error as Error).message}</p>}

      {data && (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-2">
            <Tag title="Analyst generated and ran its SQL under this role">executed as {data.executedAs}</Tag>
            {data.verifiedQueryUsed && <Tag title="Analyst matched a verified query">verified query: {data.verifiedQueryUsed}</Tag>}
            {data.models.length > 0 && <Tag>{data.models.join(", ")}</Tag>}
            {data.latencyMs !== undefined && <Tag>{(data.latencyMs / 1000).toFixed(1)} s</Tag>}
          </div>
          {comparisons.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Metric</th>
                  <th className="py-1 font-medium text-right">Registry engine</th>
                  <th className="py-1 font-medium text-right">Cortex Analyst</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((c) => (
                  <tr key={c.m.metricId} className="border-t border-border">
                    <td className="py-1">{c.m.businessName}</td>
                    <td className="py-1 text-right tabular-nums">{formatMetricValue(c.governed, c.m.unit)}</td>
                    <td className={`py-1 text-right tabular-nums ${c.agree ? "" : "u-warn"}`}>
                      {c.analyst === null ? "—" : formatMetricValue(c.analyst, c.m.unit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!data.answerable && (
            <p className="text-muted-foreground">{data.rejected ?? data.error ?? "Cortex Analyst did not produce SQL for this question."}</p>
          )}
          {data.answerable && !row && (
            <p className="text-muted-foreground">Analyst returned {data.rows?.length ?? 0} rows; value comparison applies to single-value answers.</p>
          )}
          {data.interpretation && <p className="text-muted-foreground italic">{data.interpretation}</p>}
          {data.sql && <pre className="font-mono text-[11px] whitespace-pre-wrap break-words text-foreground/90">{data.sql}</pre>}
        </div>
      )}
    </div>
  )
}
