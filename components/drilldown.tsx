"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"

interface DrilldownResult {
  metricId: string
  businessName: string
  description: string
  canonicalFact: string
  period: { label: string; description: string }
  dimension: string | null
  dimensionValue: string | null
  columns: string[]
  rows: Record<string, unknown>[]
  shown: number
  offset: number
  limit: number
  hasMore: boolean
  total: number
  sql: string
  error?: string
}

const PAGE_SIZE = 50

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return String(v)
}

/**
 * "Show the rows" affordance.
 *
 * Collapsed until asked: the exception query scans a fact table, so firing it for every metric on
 * every page load would be wasteful when most of them are never opened.
 */
export function DrilldownButton({
  metricId,
  label,
  dimension,
  dimensionValue,
  period,
  from,
  to,
  asOf,
}: {
  metricId: string
  label?: string
  dimension?: string
  dimensionValue?: string
  period?: string
  from?: string
  to?: string
  asOf?: string
}) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)

  const mutation = useMutation<DrilldownResult, Error, number>({
    mutationFn: async (nextOffset: number) => {
      const res = await fetch("/api/drilldown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metricId,
          dimension,
          dimensionValue,
          period,
          from,
          to,
          asOf,
          limit: PAGE_SIZE,
          offset: nextOffset,
        }),
      })
      const json = (await res.json()) as DrilldownResult
      if (!res.ok) throw new Error(json.error ?? "Failed to load exception rows")
      return json
    },
  })

  function toggle() {
    if (!open && !mutation.data && !mutation.isPending) mutation.mutate(0)
    setOpen((v) => !v)
  }

  function page(next: number) {
    setOffset(next)
    mutation.mutate(next)
  }

  const data = mutation.data

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="u-action disabled:opacity-50"
        disabled={mutation.isPending}
      >
        {mutation.isPending && !data
          ? "Loading rows…"
          : open
            ? "Hide the rows"
            : (label ?? "Show the rows behind this")}
      </button>

      {open && mutation.isError && (
        <div className="rounded-md border u-chip-bad p-2 text-[11px]">
          {(mutation.error as Error).message}
        </div>
      )}

      {open && data && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="space-y-1">
            <p className="text-[11px] text-foreground/90 leading-relaxed">{data.description}</p>
            <p className="text-[11px] text-muted-foreground font-mono">
              {data.total.toLocaleString()} exception row{data.total === 1 ? "" : "s"} in {data.period.label}
              {data.dimension && data.dimensionValue ? ` · ${data.dimension} = ${data.dimensionValue}` : ""}
              {data.total > data.shown
                ? ` · showing ${(data.offset + 1).toLocaleString()}–${(data.offset + data.shown).toLocaleString()}, worst first`
                : ""}
            </p>
            <p className="text-[11px] text-muted-foreground font-mono">from {data.canonicalFact}</p>
          </div>

          {data.rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No exception rows in this period — nothing to chase.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto max-h-80 overflow-y-auto rounded border border-border bg-background">
                <table className="w-full text-[11px]">
                  <thead className="bg-secondary/60 sticky top-0">
                    <tr className="text-left">
                      {data.columns.map((c) => (
                        <th key={c} className="px-2 py-1.5 font-medium whitespace-nowrap">
                          {c.replace(/_/g, " ").toLowerCase()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {data.columns.map((c) => (
                          <td key={c} className="px-2 py-1 whitespace-nowrap tabular-nums">
                            {cell(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(data.offset > 0 || data.hasMore) && (
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => page(Math.max(0, offset - PAGE_SIZE))}
                    disabled={data.offset === 0 || mutation.isPending}
                    className="rounded border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-secondary/50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => page(offset + PAGE_SIZE)}
                    disabled={!data.hasMore || mutation.isPending}
                    className="rounded border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-secondary/50"
                  >
                    Next
                  </button>
                  {mutation.isPending && <span className="text-muted-foreground">loading…</span>}
                </div>
              )}
            </>
          )}

          <details>
            <summary className="text-[11px] text-muted-foreground cursor-pointer">Query</summary>
            <pre className="text-[11px] font-mono whitespace-pre-wrap mt-1 text-foreground/80">{data.sql}</pre>
          </details>
        </div>
      )}
    </div>
  )
}
