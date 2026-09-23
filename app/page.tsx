import Link from "next/link"
import { Suspense } from "react"
import {
  PageShell,
  StatTile,
  StatusPill,
  Provenance,
  ErrorNote,
  Tag,
  Section,
  SectionHeading,
  SectionSkeleton,
} from "@/components/ui-kit"
import { PeriodControl } from "@/components/period-control"
import { MetricTrend, type TrendPoint } from "@/components/metric-trend"
import { DrilldownButton } from "@/components/drilldown"
import {
  getMetricRegistry,
  getLatestDrift,
  getOntologyEntities,
  getOntologyRelationships,
  getPersonas,
  getMetricOutlook,
  getDatabaseScale,
  querySemanticView,
  semanticViewSql,
  num,
  partitionByAsOfScope,
  getLatestSnapshotDate,
  type MetricDefinition,
  type MetricOutlook,
} from "@/lib/sc"
import {
  resolvePeriod,
  periodFilters,
  snapshotFilters,
  openBacklogFilters,
  priorPeriod,
  yearAgoPeriod,
  trendPeriod,
  type ResolvedPeriod,
} from "@/lib/period"
import { assessTarget, ragChipClass, ragTextClass } from "@/lib/target"
import { formatMetric, formatNumber } from "@/lib/format"

export const dynamic = "force-dynamic"

const HEADLINE = [
  { ref: "purchase_order.supplier_otd_pct", metricId: "supplier_otd_pct" },
  { ref: "order_fulfillment.otd_pct", metricId: "otd_pct" },
  { ref: "order_fulfillment.fill_rate_pct", metricId: "fill_rate_pct" },
  { ref: "inventory.days_of_inventory", metricId: "days_of_inventory" },
  { ref: "landed_cost.landed_cost_per_unit", metricId: "landed_cost_per_unit" },
  { ref: "landed_cost.freight_bill_variance_usd", metricId: "freight_bill_variance_usd" },
]

const VIEW = "SC_ONTOLOGY_360"
const TREND_DIM = "calendar.cal_period"

function col(ref: string): string {
  return ref.split(".")[1].toUpperCase()
}

/** Compact row count for a brag-line stat, e.g. 7792217 -> "7.79M". */
function compactRows(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/**
 * Format a period-on-period change in the metric's own unit.
 *
 * Percent metrics are reported in percentage points, not as a percentage of a percentage — a move
 * from 84% to 86% is "+2.0pp", not "+2.4%", which is the kind of ambiguity that starts arguments.
 */
function formatDelta(current: number | null, previous: number | null, unit: string | null): string | null {
  if (current === null || previous === null) return null
  const d = current - previous
  const sign = d > 0 ? "+" : ""
  if (unit === "percent") return `${sign}${(d * 100).toFixed(2)}pp`
  if (unit === "days") return `${sign}${d.toFixed(1)}d`
  if (unit === "USD per unit") return `${sign}$${d.toFixed(2)}`
  if (unit === "USD") return `${sign}${formatMetric(d, "USD")}`
  return `${sign}${d.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

/** Is this change in the direction the metric wants to go? */
function deltaTone(current: number | null, previous: number | null, direction: string | null) {
  if (current === null || previous === null) return "text-muted-foreground"
  const d = current - previous
  if (Math.abs(d) < 1e-12) return "text-muted-foreground"
  if (direction === "to zero") {
    return Math.abs(current) < Math.abs(previous)
      ? "u-good"
      : "u-bad"
  }
  const good = direction === "lower" ? d < 0 : d > 0
  return good ? "u-good" : "u-bad"
}

// ---------------------------------------------------------------------------
// Governance headline
// ---------------------------------------------------------------------------

async function GovernanceHeadline({ period }: { period: ResolvedPeriod }) {
  const [registry, drift, entities, relationships, personas, scale, backlog] = await Promise.all([
    getMetricRegistry(),
    getLatestDrift(),
    getOntologyEntities(),
    getOntologyRelationships(),
    getPersonas(),
    getDatabaseScale(),
    /**
     * What the as-of rule excluded.
     *
     * Every realized metric on this page filters out future-dated rows, which is correct — they are
     * promised activity, not measured performance. Dropping tens of thousands of rows without
     * saying so would be its own kind of dishonesty, so the excluded population is surfaced here as
     * open commitment, explicitly separate from the performance figures below.
     */
    querySemanticView({
      semanticView: VIEW,
      metrics: ["order_fulfillment.order_line_count", "purchase_order.po_line_count"],
      filters: openBacklogFilters(),
    }),
  ])

  const failing = drift.filter((d) => d.status !== "PASS")
  const facts = entities.filter((e) => e.entityRole === "FACT")
  const dims = entities.filter((e) => e.entityRole === "DIMENSION")
  const targeted = registry.filter((m) => HEADLINE.some((h) => h.metricId === m.metricId) && m.target !== null)

  const openOrderLines = num(backlog[0]?.ORDER_LINE_COUNT) ?? 0
  const openPoLines = num(backlog[0]?.PO_LINE_COUNT) ?? 0
  const scaleBreakdown = scale.bySchema.map((s) => `${s.schema} ${compactRows(s.rows)}`).join(" + ")

  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="Governed metrics"
        value={String(registry.length)}
        sub={`${targeted.length} of the ${HEADLINE.length} headline metrics carry a target`}
      />
      <StatTile
        label="Drift test"
        value={failing.length === 0 ? "ALL PASS" : `${failing.length} FAIL`}
        tone={failing.length === 0 ? "good" : "bad"}
        sub={`${drift.length} metrics checked across every view that serves them`}
      />
      <StatTile
        label="Ontology"
        value={`${entities.length} entities`}
        sub={`${dims.length} conformed dimensions, ${facts.length} facts, ${relationships.length} relationships`}
      />
      <StatTile label="Personas" value={String(personas.length)} sub="Real Snowflake roles with enforced grants" />
      <StatTile
        label="Database scale"
        value={`~${compactRows(scale.totalRows)} rows`}
        sub={`${scale.baseTables} base tables, ${scale.views} views, ${scale.semanticViews} semantic views across ${scale.schemaCount} schemas (${scaleBreakdown})`}
      />
      <StatTile
        label="Open commitment"
        value={formatNumber(openOrderLines)}
        sub={`Future-dated order lines excluded from every figure below, plus ${formatNumber(
          openPoLines,
        )} inbound PO lines. Promised, not yet delivered — not performance.`}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Canonical metric values
// ---------------------------------------------------------------------------

async function CanonicalMetrics({ period }: { period: ResolvedPeriod }) {
  const prior = priorPeriod(period)
  const yoy = yearAgoPeriod(period)
  const trend = trendPeriod(period, 12)

  const [registry, outlook] = await Promise.all([getMetricRegistry(), getMetricOutlook()])
  const reg = new Map(registry.map((m) => [m.metricId, m]))
  const outlookByMetric = new Map<string, MetricOutlook[]>()
  for (const o of outlook) {
    const list = outlookByMetric.get(o.metricId) ?? []
    list.push(o)
    outlookByMetric.set(o.metricId, list)
  }
  const split = partitionByAsOfScope(HEADLINE, reg)
  const realRefs = split.realized.map((h) => h.ref)
  const snapRefs = split.snapshot.map((h) => h.ref)
  const refs = HEADLINE.map((h) => h.ref)

  /**
   * One aggregate per scope per period.
   *
   * A period aggregate is never derived from the monthly trend rows: most of these metrics are
   * ratios, and averaging twelve monthly rates would reproduce exactly the average-of-averages
   * defect this project exists to fix. Each scope gets its own aggregate from the semantic view,
   * and SNAPSHOT balances are pinned to a single snapshot rather than summed across the range.
   */
  const aggregate = async (p: ResolvedPeriod | null): Promise<Record<string, any>> => {
    if (!p) return {}
    const [real, snap] = await Promise.all([
      realRefs.length
        ? querySemanticView({ semanticView: VIEW, metrics: realRefs, filters: periodFilters(p) })
        : Promise.resolve([]),
      snapRefs.length
        ? getLatestSnapshotDate(p.to ?? p.asOf).then((d) =>
            d
              ? querySemanticView({ semanticView: VIEW, metrics: snapRefs, filters: snapshotFilters(d) })
              : [],
          )
        : Promise.resolve([]),
    ])
    return { ...(real[0] ?? {}), ...(snap[0] ?? {}) }
  }

  const [current, previous, lastYear, trendRows, snapshotDate] = await Promise.all([
    aggregate(period),
    aggregate(prior),
    aggregate(yoy),
    // Safe to group monthly for both scopes: there is exactly one inventory snapshot per month, so
    // a monthly snapshot value is a single snapshot rather than an average of several.
    querySemanticView({
      semanticView: VIEW,
      metrics: refs,
      dimensions: [TREND_DIM],
      filters: periodFilters(trend),
    }),
    snapRefs.length ? getLatestSnapshotDate(period.to ?? period.asOf) : Promise.resolve(null),
  ])

  const months = [...new Set(trendRows.map((r) => String(r.CAL_PERIOD)))].sort()
  const trendByRef = new Map<string, TrendPoint[]>(
    refs.map((ref) => {
      const c = col(ref)
      const byMonth = new Map(trendRows.map((r) => [String(r.CAL_PERIOD), num(r[c])]))
      return [ref, months.map((m) => ({ period: m, value: byMonth.get(m) ?? null }))]
    }),
  )

  const cards = HEADLINE.map((h) => {
    const def = reg.get(h.metricId)
    if (!def) return null
    const c = col(h.ref)
    const value = num(current[c])
    const metricOutlooks = outlookByMetric.get(h.metricId) ?? []
    return {
      def,
      value,
      prior: num(previous[c]),
      yoy: num(lastYear[c]),
      trend: trendByRef.get(h.ref) ?? [],
      outlooks: metricOutlooks,
      assessment: assessTarget({
        value,
        target: def.target,
        warnThreshold: def.warnThreshold,
        failThreshold: def.failThreshold,
        direction: def.direction,
      }),
    }
  }).filter((c): c is NonNullable<typeof c> => c !== null)

  return (
    <section className="space-y-4">
      <SectionHeading note={`${period.label} · ${period.description} · future-dated rows excluded`}>
        Canonical metric values
      </SectionHeading>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const priorDelta = formatDelta(c.value, c.prior, c.def.unit)
          const yoyDelta = formatDelta(c.value, c.yoy, c.def.unit)
          return (
            <div key={c.def.metricId} className="u-card u-card-interactive p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="u-subhead">{c.def.businessName}</div>
                  <div className="u-mono text-muted-foreground">{c.def.metricId}</div>
                </div>
                {/*
                  Two independent judgements, and only two: does the definition agree across views,
                  and is the number acceptable. The target's own value moved down beside the figure
                  as plain text — rendering it as a second coloured chip meant one card showed the
                  same verdict twice in two different words.
                */}
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <StatusPill status={c.def.driftStatus} />
                  {c.def.target !== null && (
                    <StatusPill kind="target" status={c.assessment.state} label={c.assessment.label} />
                  )}
                </div>
              </div>

              <div className="flex items-baseline gap-2.5 flex-wrap">
                <div className={`u-value ${ragTextClass(c.assessment.state)}`}>
                  {formatMetric(c.value, c.def.unit)}
                </div>
                <span className="u-mono text-muted-foreground" title={c.def.targetSource ?? undefined}>
                  {c.def.target !== null ? `target ${formatMetric(c.def.target, c.def.unit)}` : "no target"}
                </span>
              </div>

              {c.outlooks.length > 0 && (
                <div className="p-2.5 rounded-md bg-secondary/50 border border-border/80 flex flex-col gap-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="u-label flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)]" />
                      Forward Outlook
                    </span>
                    <Link href="/outlook" className="u-meta hover:text-foreground text-[var(--link)]">
                      Details &rsaquo;
                    </Link>
                  </div>
                  <div className="u-meta text-foreground/90 leading-tight">
                    {c.def.metricId === "otd_pct" && "95% target unreachable across all families (16–34σ breach risk)"}
                    {c.def.metricId === "fill_rate_pct" && "Films at risk (30% breach probability); 4 families on track"}
                    {c.def.metricId !== "otd_pct" && c.def.metricId !== "fill_rate_pct" && `${c.outlooks.length} governed predictions`}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 u-mono">
                {priorDelta && (
                  <span className={deltaTone(c.value, c.prior, c.def.direction)} title="vs the prior period">
                    {priorDelta} PoP
                  </span>
                )}
                {yoyDelta && (
                  <span className={deltaTone(c.value, c.yoy, c.def.direction)} title="vs the same period last year">
                    {yoyDelta} YoY
                  </span>
                )}
              </div>

              <MetricTrend
                data={c.trend}
                unit={c.def.unit}
                target={c.def.target}
                state={c.assessment.state}
              />

              <p className="u-meta leading-relaxed line-clamp-2">{c.def.definition}</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Tag title={c.def.asOfRule ?? undefined}>{c.def.asOfScope ?? "scope not set"}</Tag>
                <Tag title="Semantic views that must return an identical value">
                  {c.def.bindings.length} view{c.def.bindings.length === 1 ? "" : "s"}
                </Tag>
              </div>
              <div className="mt-auto pt-1 border-t border-border">
                <DrilldownButton
                  metricId={c.def.metricId}
                  period={period.id}
                  from={period.from ?? undefined}
                  to={period.to ?? undefined}
                  asOf={period.asOf}
                />
              </div>
            </div>
          )
        })}
      </div>
      <Provenance label="SQL behind every number above">
        {[
          realRefs.length > 0 && semanticViewSql({ semanticView: VIEW, metrics: realRefs, filters: periodFilters(period) }),
          snapRefs.length > 0 &&
            `-- SNAPSHOT metrics are pinned to one snapshot, not aggregated across the period\n` +
              semanticViewSql({ semanticView: VIEW, metrics: snapRefs, filters: snapshotFilters(snapshotDate) }),
        ]
          .filter(Boolean)
          .join("\n\n")}
      </Provenance>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Forward Outlook & Governed Risk Summary
// ---------------------------------------------------------------------------

async function ForwardOutlookSummary() {
  const outlook = await getMetricOutlook()
  const breach = outlook.filter((o) => o.method === "TARGET_BREACH")
  const forecast = outlook.filter((o) => o.method === "ML_FORECAST")
  const willBreach = breach.filter((o) => (o.breachProbability ?? 0) >= 0.95)
  const atRisk = breach.filter((o) => (o.breachProbability ?? 0) >= 0.2 && (o.breachProbability ?? 0) < 0.95)
  const accuracy = breach.find((o) => o.backtestAccuracy !== null)?.backtestAccuracy ?? null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <SectionHeading note="Governed forward-looking risk & ML volume forecasts (as_of_scope: PREDICTED)">
          Governed Outlook & Forward Risk
        </SectionHeading>
        <Link
          href="/outlook"
          className="u-meta text-[var(--link)] hover:text-foreground font-medium flex items-center gap-1"
        >
          View full outlook &amp; simulation &rsaquo;
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="u-card p-4 flex flex-col justify-between gap-2">
          <div className="flex items-start justify-between">
            <span className="u-label">Target Breach Risk</span>
            <StatusPill kind="target" status={willBreach.length > 0 ? "off-target" : "on-target"} label={`${willBreach.length} will breach`} />
          </div>
          <div className="u-subhead">On-Time Delivery (95% Target)</div>
          <p className="u-meta leading-relaxed">
            All 5 product families sit 16–34 standard deviations below target. Unreachable without process redesign.
          </p>
        </div>

        <div className="u-card p-4 flex flex-col justify-between gap-2">
          <div className="flex items-start justify-between">
            <span className="u-label">Fill Rate Risk</span>
            <StatusPill kind="target" status={atRisk.length > 0 ? "warn" : "on-target"} label={`${atRisk.length} at risk`} />
          </div>
          <div className="u-subhead">Fill Rate (98% Target)</div>
          <p className="u-meta leading-relaxed">
            Films at 30% risk of missing target. Abrasives, Respiratory, Adhesives, and Tapes on track.
          </p>
        </div>

        <div className="u-card p-4 flex flex-col justify-between gap-2">
          <div className="flex items-start justify-between">
            <span className="u-label">Volume Forecast</span>
            <Tag>ML.FORECAST</Tag>
          </div>
          <div className="u-value">{forecast.length ? `${formatNumber(Math.round(forecast[0]?.predictedValue ?? 0))}` : "—"}</div>
          <p className="u-meta leading-relaxed">
            Projected order lines for {forecast[0]?.horizonPeriod ?? "next month"} (95% CI: {formatNumber(Math.round(forecast[0]?.lowerBound ?? 0))}–{formatNumber(Math.round(forecast[0]?.upperBound ?? 0))}).
          </p>
        </div>

        <div className="u-card p-4 flex flex-col justify-between gap-2">
          <div className="flex items-start justify-between">
            <span className="u-label">Backtested Confidence</span>
            <Tag>Canonical Metric</Tag>
          </div>
          <div className="u-value">{accuracy === null ? "—" : `${(accuracy * 100).toFixed(1)}%`}</div>
          <p className="u-meta leading-relaxed">
            Scored on held-out months using the exact <span className="u-mono">FORECAST_ACCURACY</span> definition.
          </p>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)) ?? null
  const period = resolvePeriod({ id: one("period"), from: one("from"), to: one("to"), asOf: one("asOf") })

  return (
    <PageShell
      title="Supply Chain Ontology and Governed Conversational Analytics"
      description={
        <>
          Supply chain data lives in ERP, logistics, supplier and IoT systems with inconsistent definitions, so the same
          question returns different answers to different teams. This builds one industry ontology, expresses it as
          governed Snowflake semantic views, and proves that every persona resolves a metric to the same number.
        </>
      }
      actions={<PeriodControl asOf={period.asOf} description={period.description} />}
    >
      {/*
        Each section streams independently and fails independently. Previously one try/catch wrapped
        every query on the page, so a single slow metric blanked the whole screen.
      */}
      <Suspense fallback={<SectionSkeleton title="Governance" rows={5} />}>
        {/*
          The child is invoked as a function, not written as <GovernanceHeadline />. That matters:
          creating an element does not run the component, so a try/catch around JSX would never see
          the error. Calling it returns the promise Section can actually await and catch.
        */}
        <Section title="Governance headline">{() => GovernanceHeadline({ period })}</Section>
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Canonical metric values" rows={6} />}>
        <Section title="Canonical metric values">{() => CanonicalMetrics({ period })}</Section>
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Governed Outlook" rows={3} />}>
        <Section title="Governed Outlook">{() => ForwardOutlookSummary()}</Section>
      </Suspense>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            href: "/ontology",
            title: "Ontology",
            body: "Entities, relationships and hierarchies, read live from the deployed semantic views.",
          },
          {
            href: "/metrics",
            title: "Metric Registry",
            body: "Canonical definition, numerator, denominator, grain, target and owner for every governed metric.",
          },
          {
            href: "/consistency",
            title: "Consistency",
            body: "The same metric executed as each persona role, plus the recorded divergence we fixed.",
          },
          {
            href: "/ask",
            title: "Ask",
            body: "Natural language questions resolved to a registered metric, with provenance on every answer.",
          },
        ].map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-border bg-card p-4 hover:bg-secondary/40 transition-colors"
          >
            <div className="text-sm font-medium">{c.title}</div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{c.body}</p>
          </Link>
        ))}
      </section>
    </PageShell>
  )
}
