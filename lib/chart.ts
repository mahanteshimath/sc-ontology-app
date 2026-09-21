/**
 * Chart selection, decided on the server, deterministically.
 *
 * WHY THE MODEL DOES NOT CHOOSE THE CHART. The resolver already picks metrics and a
 * dimension from a closed registry; letting it also pick a visualisation would put a
 * non-reproducible step between a governed number and how the number is read. Chart
 * type is a pure function of the result shape, so it is computed here and the same
 * question always renders the same way.
 *
 * THE ONE RULE THAT MATTERS: METRICS WITH DIFFERENT UNITS NEVER SHARE AN AXIS.
 * Plotting on-time delivery (0.885) beside total landed cost (1.98e9) on one scale
 * renders the percentage as a flat line on the floor — visibly present, unreadable,
 * and quietly implying the two moved together. Series are therefore grouped into one
 * panel per unit and rendered as small multiples.
 */

import { normalizeUnit, unitLabel } from "@/lib/format"

export interface ChartSeries {
  /** Result-set column holding this series' values. */
  column: string
  label: string
  metricId: string
  unit: string | null
  target: number | null
  /** HIGHER or LOWER: which way is good. Used to colour against target. */
  direction: string | null
}

/** One axis. Every series in a panel shares a unit, so they share a scale honestly. */
export interface ChartPanel {
  unit: string | null
  unitLabel: string
  series: ChartSeries[]
}

export interface ChartSpec {
  /**
   * none  — a single figure per metric; render metric cards, not a chart.
   * bar   — categorical breakdown.
   * line  — ordered breakdown over time.
   */
  kind: "none" | "bar" | "line"
  dimensionColumn: string | null
  dimensionLabel: string | null
  panels: ChartPanel[]
  categoryCount: number
  /** True when categories were dropped to keep the chart readable. */
  truncated: boolean
  note: string | null
}

export interface ChartMetricInput {
  metricId: string
  businessName: string
  column: string
  unit: string | null
  target: number | null
  direction: string | null
}

/**
 * A time-ordered dimension gets a line; everything else gets bars.
 *
 * Matching on the dimension reference rather than sniffing the values keeps this
 * deterministic: a column of ISO date strings and a column of region names are both
 * just strings at runtime, and guessing from content would make the chart type depend
 * on which rows came back.
 */
function isTemporal(dimensionRef: string | null): boolean {
  if (!dimensionRef) return false
  return /(^|[._])(cal_)?(date|period|month|quarter|year|week|day)([._]|$)/i.test(dimensionRef)
}

/** Above this, bars stop being comparable and the axis becomes unreadable. */
const MAX_CATEGORIES = 16

/**
 * Build the spec and return rows in the order the chart should show them.
 *
 * Sorting happens here rather than in the component so the table and the chart agree.
 * Temporal breakdowns sort by the dimension ascending, because a time series read out
 * of order is wrong rather than merely ugly; categorical breakdowns sort by the first
 * series descending, which is what makes "which is worst" answerable at a glance.
 */
export function buildChart(input: {
  dimensionRef: string | null
  dimensionColumn: string | null
  metrics: ChartMetricInput[]
  rows: Record<string, any>[]
}): { spec: ChartSpec; rows: Record<string, any>[] } {
  const { dimensionRef, dimensionColumn, metrics, rows } = input

  if (!dimensionColumn || metrics.length === 0 || rows.length === 0) {
    return {
      spec: {
        kind: "none",
        dimensionColumn: null,
        dimensionLabel: null,
        panels: [],
        categoryCount: 0,
        truncated: false,
        note: null,
      },
      rows,
    }
  }

  const temporal = isTemporal(dimensionRef)

  // Group by canonical unit, preserving the order metrics were resolved in so the
  // first panel corresponds to the first thing the question asked about.
  const byUnit = new Map<string, ChartMetricInput[]>()
  for (const m of metrics) {
    const key = normalizeUnit(m.unit)
    const list = byUnit.get(key)
    if (list) list.push(m)
    else byUnit.set(key, [m])
  }

  const panels: ChartPanel[] = [...byUnit.values()].map((group) => ({
    unit: group[0].unit,
    unitLabel: unitLabel(group[0].unit),
    series: group.map((m) => ({
      column: m.column,
      label: m.businessName,
      metricId: m.metricId,
      unit: m.unit,
      target: m.target,
      direction: m.direction,
    })),
  }))

  // Drop rows with no dimension value: a null category is not a category, and it
  // renders as an unlabelled bar that invites being read as a real one.
  let ordered = rows.filter((r) => r[dimensionColumn] !== null && r[dimensionColumn] !== undefined)

  const firstColumn = metrics[0].column
  if (temporal) {
    ordered = [...ordered].sort((a, b) =>
      String(a[dimensionColumn]).localeCompare(String(b[dimensionColumn])),
    )
  } else {
    ordered = [...ordered].sort((a, b) => {
      const av = Number(a[firstColumn])
      const bv = Number(b[firstColumn])
      if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0
      if (!Number.isFinite(av)) return 1
      if (!Number.isFinite(bv)) return -1
      return bv - av
    })
  }

  const total = ordered.length
  const truncated = total > MAX_CATEGORIES
  // Keep the head for a time series (earliest first) and for a ranked bar chart the
  // head is already the most extreme, so slicing the tail is right in both cases.
  const shown = truncated ? ordered.slice(0, MAX_CATEGORIES) : ordered

  return {
    spec: {
      kind: temporal ? "line" : "bar",
      dimensionColumn,
      dimensionLabel: dimensionRef,
      panels,
      categoryCount: shown.length,
      truncated,
      note: truncated
        ? `Showing ${MAX_CATEGORIES} of ${total} ${temporal ? "periods" : "categories"}${temporal ? "" : ", ranked by " + metrics[0].businessName}. The table below has every row.`
        : null,
    },
    rows: shown,
  }
}
