"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useTransition } from "react"
import { PERIOD_OPTIONS } from "@/lib/period"
import { cn } from "@/lib/utils"

/**
 * Reporting-period selector.
 *
 * The selection lives in the URL rather than in React state for three reasons: every page stays a
 * Server Component, a period-scoped view is a shareable link, and the back button works. Changing
 * the period replaces the current history entry so the browser history does not fill with
 * intermediate selections.
 *
 * Rendered per page rather than in the global header on purpose: `/metrics`, `/ontology` and
 * `/consistency` are deliberately all-history (a definition and its drift status have no reporting
 * period), and a control in the header would imply it affects them too.
 */
export function PeriodControl({ asOf, description }: { asOf: string; description: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const current = params.get("period") ?? (params.get("from") && params.get("to") ? "custom" : "t12m")
  const from = params.get("from") ?? ""
  const to = params.get("to") ?? ""

  function update(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") sp.delete(k)
      else sp.set(k, v)
    }
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }))
  }

  function selectPreset(value: string) {
    if (value === "custom") {
      // Seed the range with the current month so the inputs are never empty; resolvePeriod ignores
      // an incoherent range, so a half-entered one falls back rather than inverting.
      const start = `${asOf.slice(0, 7)}-01`
      update({ period: null, from: from || start, to: to || asOf })
    } else {
      update({ period: value, from: null, to: null })
    }
  }

  return (
    <div className={cn("rounded-lg border border-border bg-secondary/45 px-3 py-2.5 shadow-sm flex flex-col items-end gap-1.5", pending && "opacity-60")}>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <label className="u-label" htmlFor="period">
          Period
        </label>
        <select
          id="period"
          value={current}
          onChange={(e) => selectPreset(e.target.value)}
          className="h-8 rounded-md border border-border bg-card px-2 text-xs shadow-sm"
        >
          {/* Set explicitly: native option popups ignore the select's dark-theme classes. */}
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.id} value={p.id} title={p.hint} className="bg-card text-foreground">
              {p.label}
            </option>
          ))}
          <option value="custom" title="Pick an explicit start and end date" className="bg-card text-foreground">
            Custom range
          </option>
        </select>

        {current === "custom" && (
          <>
            <input
              type="date"
              aria-label="Range start"
              value={from}
              max={to || asOf}
              onChange={(e) => update({ period: null, from: e.target.value || null })}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs shadow-sm"
            />
            <span className="u-meta">to</span>
            <input
              type="date"
              aria-label="Range end"
              value={to}
              min={from || undefined}
              max={asOf}
              onChange={(e) => update({ period: null, to: e.target.value || null })}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs shadow-sm"
            />
          </>
        )}

        <label className="u-label" htmlFor="asOf">
          As of
        </label>
        <input
          id="asOf"
          type="date"
          value={asOf}
          onChange={(e) => update({ asOf: e.target.value || null })}
          className="h-8 rounded-md border border-border bg-card px-2 text-xs shadow-sm"
        />
      </div>
      <span className="u-mono text-muted-foreground">{description}</span>
    </div>
  )
}
