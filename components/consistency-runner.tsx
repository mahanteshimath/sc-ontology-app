"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface MetricOption {
  metricId: string
  businessName: string
  unit: string | null
  definition: string
}

interface PersonaResult {
  roleName: string
  personaLabel: string
  rowScope: string
  values: { semanticView: string; metricReference: string; value: number | null; error?: string }[]
}

type Agreement = "EXACT" | "DIVERGENT" | "SINGLE OBSERVATION" | "UNPROVEN"

interface ConsistencyResponse {
  metricId: string
  businessName: string
  unit: string | null
  canonicalValue: number | null
  distinctValues: number
  observations: number
  agreement: Agreement
  unprovenReason: string | null
  personas: PersonaResult[]
  error?: string
}

/** Only EXACT is a green outcome; everything else must not look like one. */
function agreementTone(a: Agreement): { border: string; text: string; headline: string } {
  switch (a) {
    case "EXACT":
      return {
        border: "border-emerald-500/40 bg-emerald-500/5",
        text: "u-good",
        headline: "All personas agree exactly",
      }
    case "DIVERGENT":
      return {
        border: "border-red-500/40 bg-red-500/5",
        text: "u-bad",
        headline: "Personas disagree",
      }
    case "SINGLE OBSERVATION":
      return {
        border: "border-amber-500/40 bg-amber-500/5",
        text: "u-warn",
        headline: "Only one observation — nothing to compare",
      }
    default:
      return {
        border: "border-amber-500/40 bg-amber-500/5",
        text: "u-warn",
        headline: "Agreement could not be established",
      }
  }
}

function fmt(value: number | null, unit: string | null): string {
  if (value === null) return "—"
  if (unit === "percent") return `${(value * 100).toFixed(4)}%`
  if (unit === "days") return `${value.toFixed(4)} days`
  if (unit === "USD") return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (unit === "USD per unit") return `$${value.toFixed(6)}`
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function ConsistencyRunner({ metrics }: { metrics: MetricOption[] }) {
  const [metricId, setMetricId] = useState(
    metrics.find((m) => m.metricId === "supplier_otd_pct")?.metricId ?? metrics[0]?.metricId ?? "",
  )

  const mutation = useMutation<ConsistencyResponse>({
    mutationFn: async () => {
      const res = await fetch("/api/consistency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metricId }),
      })
      const json = (await res.json()) as ConsistencyResponse
      if (!res.ok) throw new Error(json.error ?? "Failed to run the consistency check")
      return json
    },
  })

  const selected = metrics.find((m) => m.metricId === metricId)

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Governed metric</span>
          <select
            value={metricId}
            onChange={(e) => setMetricId(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm min-w-[280px]"
          >
            {metrics.map((m) => (
              <option key={m.metricId} value={m.metricId}>
                {m.businessName}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !metricId} size="sm">
          {mutation.isPending ? "Executing as each persona…" : "Run as all personas"}
        </Button>
      </div>

      {selected && <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">{selected.definition}</p>}

      {mutation.isError && (
        <div className="rounded-md border u-chip-bad p-3 u-body">
          {mutation.error instanceof Error ? mutation.error.message : "Failed"}
        </div>
      )}

      {mutation.isSuccess && (
        <div className="space-y-3">
          <div
            className={cn(
              "rounded-lg border p-4 flex items-center justify-between gap-4 flex-wrap",
              agreementTone(mutation.data.agreement).border,
            )}
          >
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {mutation.data.businessName} — one governed answer
              </div>
              <div className="text-3xl font-semibold tabular-nums mt-1">
                {fmt(mutation.data.canonicalValue, mutation.data.unit)}
              </div>
            </div>
            <div className="text-right">
              <div className={cn("text-sm font-semibold", agreementTone(mutation.data.agreement).text)}>
                {agreementTone(mutation.data.agreement).headline}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {mutation.data.distinctValues} distinct value
                {mutation.data.distinctValues === 1 ? "" : "s"} across{" "}
                {mutation.data.observations} successful execution
                {mutation.data.observations === 1 ? "" : "s"}
              </div>
              {mutation.data.unprovenReason && (
                <div className="text-[11px] u-warn mt-1 max-w-sm">
                  {mutation.data.unprovenReason}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {mutation.data.personas.map((p) => (
              <div key={p.roleName} className="rounded-lg border border-border bg-card p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.personaLabel}</span>
                  <span className="text-[11px] font-mono text-muted-foreground">{p.rowScope}</span>
                </div>
                <div className="text-[11px] font-mono text-muted-foreground">{p.roleName}</div>
                <div className="space-y-1.5 pt-1">
                  {p.values.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      This persona has no view serving this metric.
                    </div>
                  )}
                  {p.values.map((v) => (
                    <div key={v.semanticView} className="space-y-0.5">
                      <div className="text-lg font-semibold tabular-nums">
                        {v.error ? <span className="text-xs text-red-600">{v.error}</span> : fmt(v.value, mutation.data.unit)}
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground break-words">
                        {v.semanticView}.{v.metricReference}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
