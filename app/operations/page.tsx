import { Suspense } from "react"
import { PageShell, Provenance, Tag, Section, SectionSkeleton } from "@/components/ui-kit"
import { PeriodControl } from "@/components/period-control"
import {
  querySemanticView,
  semanticViewSql,
  getMetricRegistry,
  getLatestSnapshotDate,
  num,
  type MetricDefinition,
} from "@/lib/sc"
import { resolvePeriod, periodFilters, snapshotFilters, type ResolvedPeriod } from "@/lib/period"
import { formatMetric } from "@/lib/format"
import { OperationsCharts } from "@/components/operations-charts"
import { DrilldownButton } from "@/components/drilldown"

export const dynamic = "force-dynamic"

/** Each panel is one cross-domain view of the ontology, grouped by one dimension. */
const PANELS = [
  {
    id: "family",
    title: "Service and cost by product family",
    dimension: "part.product_family",
    metrics: [
      { ref: "order_fulfillment.otd_pct", metricId: "otd_pct", label: "On-Time Delivery", unit: "percent" },
      { ref: "order_fulfillment.fill_rate_pct", metricId: "fill_rate_pct", label: "Fill Rate", unit: "percent" },
      { ref: "inventory.days_of_inventory", metricId: "days_of_inventory", label: "Days of Inventory", unit: "days" },
      {
        ref: "landed_cost.landed_cost_per_unit",
        metricId: "landed_cost_per_unit",
        label: "Landed Cost / Unit",
        unit: "USD per unit",
      },
    ],
    chart: { metric: "order_fulfillment.otd_pct", metricId: "otd_pct", label: "On-Time Delivery", unit: "percent" },
  },
  {
    id: "supplier-region",
    title: "Inbound supplier reliability by region",
    dimension: "supplier.supplier_region",
    metrics: [
      { ref: "purchase_order.supplier_otd_pct", metricId: "supplier_otd_pct", label: "Supplier OTD", unit: "percent" },
      {
        ref: "purchase_order.supplier_fill_rate",
        metricId: "supplier_fill_rate",
        label: "Supplier Fill Rate",
        unit: "percent",
      },
      { ref: "purchase_order.ppv", metricId: "ppv", label: "Price Variance", unit: "USD" },
      { ref: "purchase_order.po_line_count", metricId: "po_line_count", label: "PO Lines", unit: null },
    ],
    chart: {
      metric: "purchase_order.supplier_otd_pct",
      metricId: "supplier_otd_pct",
      label: "Supplier OTD",
      unit: "percent",
    },
  },
  {
    id: "carrier",
    title: "Freight billing accuracy by carrier",
    dimension: "order_fulfillment.carrier",
    metrics: [
      { ref: "landed_cost.freight_cost_usd", metricId: "freight_cost_usd", label: "Freight Accrued", unit: "USD" },
      {
        ref: "landed_cost.freight_invoiced_usd",
        metricId: "freight_invoiced_usd",
        label: "Freight Invoiced",
        unit: "USD",
      },
      {
        ref: "landed_cost.freight_bill_variance_usd",
        metricId: "freight_bill_variance_usd",
        label: "Bill Variance",
        unit: "USD",
      },
    ],
    chart: {
      metric: "landed_cost.freight_bill_variance_usd",
      metricId: "freight_bill_variance_usd",
      label: "Freight Bill Variance",
      unit: "USD",
    },
  },
  {
    id: "region",
    title: "Outbound service by destination region",
    dimension: "order_fulfillment.ship_region",
    metrics: [
      { ref: "order_fulfillment.otd_pct", metricId: "otd_pct", label: "On-Time Delivery", unit: "percent" },
      { ref: "order_fulfillment.otif_pct", metricId: "otif_pct", label: "OTIF", unit: "percent" },
      { ref: "order_fulfillment.fill_rate_pct", metricId: "fill_rate_pct", label: "Fill Rate", unit: "percent" },
      {
        ref: "order_fulfillment.order_line_count",
        metricId: "order_line_count",
        label: "Order Lines",
        unit: null,
      },
    ],
    chart: { metric: "order_fulfillment.otif_pct", metricId: "otif_pct", label: "OTIF", unit: "percent" },
  },
]

function col(ref: string): string {
  return ref.split(".")[1].toUpperCase()
}

type Panel = (typeof PANELS)[number]

/**
 * One operational panel: a table, a chart and its provenance.
 *
 * Each panel loads on its own so the page streams in as results arrive, and a panel whose query
 * fails shows an error in its own place instead of taking the other three down with it.
 */
async function OperationsPanel({ panel, period }: { panel: Panel; period: ResolvedPeriod }) {
  const registry: MetricDefinition[] = await getMetricRegistry()
  const scopeOf = new Map(registry.map((m) => [m.metricId, m.asOfScope]))

  // A panel can mix event metrics and snapshot balances. They cannot share one query: spanning the
  // period is correct for an event rate and wrong for a balance, which would be counted once per
  // snapshot in range. Each scope is queried on its own terms and joined on the shared dimension.
  const realRefs = panel.metrics.filter((m) => scopeOf.get(m.metricId) !== "SNAPSHOT").map((m) => m.ref)
  const snapRefs = panel.metrics.filter((m) => scopeOf.get(m.metricId) === "SNAPSHOT").map((m) => m.ref)
  const snapshotDate = snapRefs.length > 0 ? await getLatestSnapshotDate(period.to ?? period.asOf) : null

  const [realRows, snapRows] = await Promise.all([
    realRefs.length
      ? querySemanticView({
          semanticView: "SC_ONTOLOGY_360",
          dimensions: [panel.dimension],
          metrics: realRefs,
          filters: periodFilters(period),
        })
      : Promise.resolve([]),
    snapRefs.length && snapshotDate
      ? querySemanticView({
          semanticView: "SC_ONTOLOGY_360",
          dimensions: [panel.dimension],
          metrics: snapRefs,
          filters: snapshotFilters(snapshotDate),
        })
      : Promise.resolve([]),
  ])

  const dimCol = col(panel.dimension)
  const merged = new Map<string, Record<string, any>>()
  for (const r of realRows) merged.set(String(r[dimCol] ?? "—"), { ...r })
  for (const r of snapRows) {
    const key = String(r[dimCol] ?? "—")
    merged.set(key, { ...(merged.get(key) ?? { [dimCol]: r[dimCol] }), ...r })
  }
  const rows = [...merged.values()]

  const chartCol = col(panel.chart.metric)
  const chartData = rows
    .map((r) => ({ label: String(r[dimCol] ?? "—"), value: num(r[chartCol]) }))
    .filter((d) => d.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold">{panel.title}</h2>
        <div className="flex items-center gap-1.5">
          <Tag>grouped by {panel.dimension}</Tag>
          <Tag title={period.description}>{period.label}</Tag>
          {snapRefs.length > 0 && snapshotDate && (
            <Tag title="Snapshot balances are pinned to a single date, not aggregated over the period">
              snapshot {snapshotDate}
            </Tag>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <div className="lg:col-span-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/80 backdrop-blur sticky top-0 z-10">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium whitespace-nowrap">{dimCol.replace(/_/g, " ")}</th>
                {panel.metrics.map((m) => (
                  <th key={m.ref} className="px-3 py-2 font-medium text-right">
                    {m.label}
                  </th>
                ))}
                <th
                  className="px-3 py-2 font-medium"
                  title={`Atomic rows behind ${panel.chart.label}`}
                >
                  {panel.chart.label} exceptions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={panel.metrics.length + 2}
                    className="px-3 py-4 text-xs text-muted-foreground text-center"
                  >
                    No rows in {period.label.toLowerCase()}.
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{String(r[dimCol] ?? "—")}</td>
                  {panel.metrics.map((m) => (
                    <td key={m.ref} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {formatMetric(num(r[col(m.ref)]), m.unit)}
                    </td>
                  ))}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <DrilldownButton
                      metricId={panel.chart.metricId}
                      label="rows"
                      dimension={panel.dimension}
                      dimensionValue={String(r[dimCol] ?? "")}
                      period={period.id}
                      from={period.from ?? undefined}
                      to={period.to ?? undefined}
                      asOf={period.asOf}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="lg:col-span-2 rounded-lg border border-border bg-card p-3">
          <OperationsCharts
            title={panel.chart.label}
            unit={panel.chart.unit}
            data={chartData as { label: string; value: number }[]}
          />
        </div>
      </div>

      <Provenance label="Query">
        {[
          realRefs.length > 0 &&
            semanticViewSql({
              semanticView: "SC_ONTOLOGY_360",
              dimensions: [panel.dimension],
              metrics: realRefs,
              filters: periodFilters(period),
            }),
          snapRefs.length > 0 &&
            `-- SNAPSHOT balance: pinned to one snapshot, not aggregated across the period\n` +
              semanticViewSql({
                semanticView: "SC_ONTOLOGY_360",
                dimensions: [panel.dimension],
                metrics: snapRefs,
                filters: snapshotFilters(snapshotDate),
              }),
        ]
          .filter(Boolean)
          .join("\n\n")}
      </Provenance>
    </section>
  )
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)) ?? null
  const period = resolvePeriod({ id: one("period"), from: one("from"), to: one("to"), asOf: one("asOf") })

  return (
    <PageShell
      title="Operations"
      description="Cross-domain operating views built from the same governed metrics used in Ask."
      actions={<PeriodControl asOf={period.asOf} description={period.description} />}
    >
      {PANELS.map((panel) => (
        <Suspense key={panel.id} fallback={<SectionSkeleton title={panel.title} rows={2} />}>
          {/* Invoked as a function so Section can await and catch it — see the note in app/page.tsx. */}
          <Section title={panel.title}>{() => OperationsPanel({ panel, period })}</Section>
        </Suspense>
      ))}
    </PageShell>
  )
}
