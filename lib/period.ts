/**
 * Reporting period resolution.
 *
 * Every page that shows a number resolves its period here, so the period shown in the UI, the
 * period used in the SEMANTIC_VIEW query, and the period printed in the provenance block cannot
 * disagree.
 *
 * Two things are deliberately separate:
 *   - the PERIOD, which narrows the calendar range, and
 *   - the AS-OF RULE, which excludes future-dated rows.
 *
 * The as-of rule is not a period preference; it is recorded per metric in
 * GOVERNANCE.METRIC_DEFINITION.as_of_scope and applies regardless of which period is selected.
 * The source data runs about two months past today, so without it every "current" service metric
 * silently blends measured performance with promised future activity.
 */

import type { SemanticFilter } from "@/lib/sc"

export type PeriodId = "mtd" | "last-month" | "t3m" | "t12m" | "ytd" | "all" | "custom"

export interface PeriodOption {
  id: PeriodId
  label: string
  /** Shown under the selector so the chosen scope is never ambiguous. */
  hint: string
}

export const PERIOD_OPTIONS: PeriodOption[] = [
  { id: "mtd", label: "This month", hint: "Month to date" },
  { id: "last-month", label: "Last month", hint: "The last complete calendar month" },
  { id: "t3m", label: "Trailing 3 months", hint: "The 3 complete months before today" },
  { id: "t12m", label: "Trailing 12 months", hint: "The 12 complete months before today" },
  { id: "ytd", label: "Year to date", hint: "January 1 to today" },
  { id: "all", label: "All history", hint: "Every period in the warehouse" },
]

export interface ResolvedPeriod {
  id: PeriodId
  label: string
  /** Inclusive first day, or null for all history. */
  from: string | null
  /** Inclusive last day, never later than the as-of date. */
  to: string | null
  /** The date the period is measured as of — today unless explicitly overridden. */
  asOf: string
  /** Human-readable scope, rendered next to every figure. */
  description: string
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()))
}

/** Parse a YYYY-MM-DD string, returning null for anything malformed. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Resolve a period id (and optional explicit bounds) into concrete dates.
 *
 * `asOf` exists so the app can be pointed at a historical date for review or demonstration
 * without editing code. It defaults to today and is clamped to the end of every period, which is
 * what makes "this month" mean month-to-date rather than the whole month.
 */
export function resolvePeriod(params: {
  id?: string | null
  from?: string | null
  to?: string | null
  asOf?: string | null
}): ResolvedPeriod {
  const asOfDate = parseIsoDate(params.asOf ?? null) ?? new Date()
  const asOf = iso(asOfDate)

  const id = (PERIOD_OPTIONS.some((p) => p.id === params.id) ? params.id : null) as PeriodId | null
  const customFrom = parseIsoDate(params.from ?? null)
  const customTo = parseIsoDate(params.to ?? null)

  // An explicit range wins over a preset, but only when it is coherent.
  if (!id && customFrom && customTo && customFrom <= customTo) {
    /*
     * The end is clamped to the as-of date so a range cannot report past the point being reviewed.
     *
     * Coherence has to be re-checked AFTER that clamp, not only before it. A range that starts in
     * the future — `from=2027-01-01&to=2027-03-31` against an as-of of 2026-09-20 — passes the
     * `from <= to` test on the raw input, then has its end pulled back to the as-of date, leaving
     * `from` after `to`. That rendered as "2027-01-01 to 2026-09-20" and produced a WHERE clause
     * that no row can satisfy. A window entirely in the future contains nothing measurable, so it
     * is treated as incoherent and falls through to the preset below, exactly as an inverted range
     * already did.
     */
    const clamped = customTo > asOfDate
    const to = clamped ? asOf : iso(customTo)
    if (iso(customFrom) <= to) {
      return {
        id: "custom",
        label: "Custom range",
        from: iso(customFrom),
        to,
        asOf,
        // Say so when the end was pulled in, so a shorter window than requested is explained.
        description: clamped ? `${iso(customFrom)} to ${to} (clamped to as-of)` : `${iso(customFrom)} to ${to}`,
      }
    }
  }

  const thisMonth = startOfMonth(asOfDate)
  const resolved = id ?? "t12m"

  switch (resolved) {
    case "all":
      return {
        id: "all",
        label: "All history",
        from: null,
        to: asOf,
        asOf,
        description: `every period up to ${asOf}`,
      }
    case "mtd":
      return {
        id: "mtd",
        label: "This month",
        from: iso(thisMonth),
        to: asOf,
        asOf,
        description: `${iso(thisMonth)} to ${asOf} (month to date)`,
      }
    case "last-month": {
      const from = addMonths(thisMonth, -1)
      const to = new Date(thisMonth.getTime() - 86_400_000)
      return {
        id: "last-month",
        label: "Last month",
        from: iso(from),
        to: iso(to),
        asOf,
        description: `${iso(from)} to ${iso(to)}`,
      }
    }
    case "ytd": {
      const from = new Date(Date.UTC(asOfDate.getUTCFullYear(), 0, 1))
      return {
        id: "ytd",
        label: "Year to date",
        from: iso(from),
        to: asOf,
        asOf,
        description: `${iso(from)} to ${asOf}`,
      }
    }
    case "t3m":
    case "t12m":
    default: {
      const months = resolved === "t3m" ? 3 : 12
      // Complete months only: end at the last day before the current month starts.
      const to = new Date(thisMonth.getTime() - 86_400_000)
      const from = addMonths(thisMonth, -months)
      return {
        id: resolved === "t3m" ? "t3m" : "t12m",
        label: resolved === "t3m" ? "Trailing 3 months" : "Trailing 12 months",
        from: iso(from),
        to: iso(to),
        asOf,
        description: `${iso(from)} to ${iso(to)} (${months} complete months)`,
      }
    }
  }
}

/**
 * Turn a resolved period into governed semantic-view filters.
 *
 * `realized` reflects METRIC_DEFINITION.as_of_scope: pass false only when every metric in the
 * query is a SNAPSHOT measure, which is not additive over time and therefore must not have
 * future-dated rows excluded by the same rule.
 */
export function periodFilters(period: ResolvedPeriod, realized = true): SemanticFilter[] {
  const filters: SemanticFilter[] = []
  if (period.from) filters.push({ ref: "calendar.cal_date", op: ">=", value: period.from })
  if (period.to) filters.push({ ref: "calendar.cal_date", op: "<=", value: period.to })
  // Belt and braces: the as-of clamp above already removes future dates for every preset, but an
  // explicit rule keeps the intent visible in the provenance SQL and survives a custom range.
  if (realized) filters.push({ ref: "calendar.is_future", op: "=", value: 0 })
  return filters
}

/**
 * Filters for a SNAPSHOT metric: pin to one snapshot date rather than span the period.
 *
 * See getLatestSnapshotDate in lib/sc.ts for why. If no snapshot exists at or before the end of
 * the period, the caller gets an empty filter set and no rows, which is the honest answer.
 */
export function snapshotFilters(snapshotDate: string | null): SemanticFilter[] {
  if (!snapshotDate) return []
  return [{ ref: "calendar.cal_date", op: "=", value: snapshotDate }]
}

/**
 * The inverse of the as-of rule: only the rows the realized metrics deliberately exclude.
 *
 * Excluding future-dated rows is correct for measuring performance, but silently dropping 41,347
 * order lines and telling nobody is not. This returns the complement so the application can show
 * what was set aside and label it as open commitment rather than measured performance.
 */
export function openBacklogFilters(): SemanticFilter[] {
  return [{ ref: "calendar.is_future", op: "=", value: 1 }]
}

/** The search-param shape the period control reads and writes. */
export function periodSearchParams(period: ResolvedPeriod): Record<string, string> {
  const out: Record<string, string> = { period: period.id }
  if (period.id === "custom") {
    if (period.from) out.from = period.from
    if (period.to) out.to = period.to
  }
  return out
}

function shift(value: string | null, days: number): string | null {
  const d = parseIsoDate(value)
  if (!d) return null
  return iso(new Date(d.getTime() + days * 86_400_000))
}

/**
 * The immediately preceding window of the same length, for a period-on-period delta.
 *
 * Returns null for "all history", which has no predecessor.
 */
export function priorPeriod(period: ResolvedPeriod): ResolvedPeriod | null {
  if (!period.from || !period.to) return null
  const from = parseIsoDate(period.from)!
  const to = parseIsoDate(period.to)!
  const lengthDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
  const prevTo = shift(period.from, -1)!
  const prevFrom = shift(prevTo, -(lengthDays - 1))!
  return {
    id: "custom",
    label: "Prior period",
    from: prevFrom,
    to: prevTo,
    asOf: period.asOf,
    description: `${prevFrom} to ${prevTo}`,
  }
}

/** The same window one year earlier, for a year-on-year delta. */
export function yearAgoPeriod(period: ResolvedPeriod): ResolvedPeriod | null {
  if (!period.from || !period.to) return null
  const back = (v: string) => {
    const d = parseIsoDate(v)!
    return iso(new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())))
  }
  const from = back(period.from)
  const to = back(period.to)
  return {
    id: "custom",
    label: "Same period last year",
    from,
    to,
    asOf: period.asOf,
    description: `${from} to ${to}`,
  }
}

/**
 * A trailing window of complete months, used for trend charts.
 *
 * Trends are always drawn over a fixed trailing window rather than over the selected period: a
 * one-month selection has no trend to show, and a chart that silently changes its own time base
 * when the KPI period changes is harder to read, not easier.
 */
export function trendPeriod(period: ResolvedPeriod, months = 12): ResolvedPeriod {
  const asOfDate = parseIsoDate(period.asOf) ?? new Date()
  const thisMonth = startOfMonth(asOfDate)
  const to = new Date(thisMonth.getTime() - 86_400_000)
  const from = addMonths(thisMonth, -months)
  return {
    id: "custom",
    label: `Trailing ${months} months`,
    from: iso(from),
    to: iso(to),
    asOf: period.asOf,
    description: `${iso(from)} to ${iso(to)}`,
  }
}
