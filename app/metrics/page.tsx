import { Suspense } from "react"
import type React from "react"
import Link from "next/link"
import {
  PageShell,
  StatTile,
  StatusPill,
  Tag,
  Provenance,
  Section,
  SectionHeading,
  SectionSkeleton,
} from "@/components/ui-kit"
import {
  getMetricRegistry,
  getLatestDrift,
  getDriftHistory,
  getMetricOutlook,
  type MetricDefinition,
  type MetricOutlook,
} from "@/lib/sc"
import { formatMetric } from "@/lib/format"
import { assessTarget } from "@/lib/target"
import { canRunDriftTest } from "@/lib/env"
import { cn } from "@/lib/utils"
import { DriftRunner } from "@/components/drift-runner"
import { DriftHistory } from "@/components/drift-history"

export const dynamic = "force-dynamic"

const DIRECTION_LABEL: Record<string, string> = {
  higher: "higher is better",
  lower: "lower is better",
  "to zero": "closer to zero is better",
}

/**
 * The drift control's track record.
 *
 * Its own section so a slow or failing history query cannot take the registry down with it: the
 * registry is the more important of the two and must render regardless.
 */
async function DriftHistorySection() {
  const [history, drift] = await Promise.all([getDriftHistory(30), getLatestDrift()])
  return (
    <section className="space-y-4">
      <SectionHeading note="Runs daily at 06:00 UTC via task GOVERNANCE.METRIC_DRIFT_TEST_DAILY">
        Drift test history
      </SectionHeading>
      <div className="u-card p-5 space-y-4">
        <DriftHistory runs={history} />
        {/*
          The runner lives with the history rather than in the page header: it needs the last run
          time, and reading that above the Suspense boundary would put a query back on the
          critical path and re-serialise the whole page.
        */}
        <div className="flex justify-end border-t border-border pt-3">
          <DriftRunner canRun={canRunDriftTest()} lastRunAt={drift[0]?.runAt ?? null} />
        </div>
      </div>
    </section>
  )
}

/** Shared column template, so the header row and every metric row align on one grid. */
const ROW_GRID =
  "grid gap-x-4 gap-y-1 md:grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)]"

/**
 * One metric as a disclosure row.
 *
 * A native `<details>` rather than a client component: it needs no JavaScript, it is keyboard
 * accessible and announced correctly for free, and it keeps this page a Server Component.
 */
function MetricRow({ m, outlooks = [] }: { m: MetricDefinition; outlooks?: MetricOutlook[] }) {
  const assessment = assessTarget({
    value: m.canonicalValue,
    target: m.target,
    warnThreshold: m.warnThreshold,
    failThreshold: m.failThreshold,
    direction: m.direction,
  })

  return (
    <details className="group border-b border-border last:border-0">
      <summary className="list-none cursor-pointer px-4 py-3 hover:bg-secondary/40 transition-colors [&::-webkit-details-marker]:hidden">
        <div className={cn(ROW_GRID, "items-baseline")}>
          <div className="min-w-0 flex items-baseline gap-2">
            {/* Rotates to point down when open — the only affordance this row needs. */}
            <span
              aria-hidden
              className="u-meta shrink-0 transition-transform duration-200 group-open:rotate-90 select-none"
            >
              &rsaquo;
            </span>
            <span className="min-w-0">
              <span className="u-subhead block truncate">{m.businessName}</span>
              <span className="u-mono text-muted-foreground flex items-center gap-2">
                {m.metricId}
                {outlooks.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-[var(--brand-primary)]/15 text-[var(--link)] border border-[var(--brand-primary)]/30">
                    Forecast
                  </span>
                )}
              </span>
            </span>
          </div>

          <div className="md:text-right">
            <span className="text-[length:var(--fs-title)] font-semibold tabular-nums">
              {formatMetric(m.canonicalValue, m.unit)}
            </span>
            <span className="u-label block md:text-right">all history</span>
          </div>

          <div className="flex flex-col gap-1 md:items-start">
            {m.target === null ? (
              <span className="u-meta">no target by design</span>
            ) : (
              <>
                <StatusPill kind="target" status={assessment.state} label={assessment.label} />
                <span className="u-mono text-muted-foreground">
                  target {formatMetric(m.target, m.unit)}
                </span>
              </>
            )}
          </div>

          <div>
            <Tag title={m.asOfRule ?? undefined}>{m.asOfScope ?? "not set"}</Tag>
          </div>

          <div className="flex flex-col items-start md:items-end gap-1">
            <StatusPill status={m.driftStatus} />
            <span className="u-meta">
              {m.bindings.length} view{m.bindings.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </summary>

      {/* Everything the scannable row omits. No information was removed, only deferred. */}
      <div className="px-4 pb-5 pt-1 space-y-5 bg-secondary/25">
        <p className="u-body u-prose text-muted-foreground">
          {m.definition}
          {m.direction && <span className="u-meta"> · {DIRECTION_LABEL[m.direction] ?? m.direction}</span>}
        </p>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Numerator" mono>
            {m.numerator ?? "—"}
          </Field>
          <Field label="Denominator" mono>
            {m.denominator ?? "— (additive measure)"}
          </Field>
          <Field label="Grain" mono>
            {m.grain}
          </Field>
          <Field label="Canonical fact" mono>
            {m.canonicalFact}
          </Field>
          <Field label="Owner" mono>
            {m.ownerRole ?? "—"}
          </Field>
          <Field label="Version" mono>
            v{m.version} from {m.effectiveFrom}
          </Field>
        </dl>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <div className="u-label">Target</div>
            {m.target === null ? (
              <p className="u-meta leading-relaxed">{m.targetSource}</p>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap u-mono">
                  <span>target {formatMetric(m.target, m.unit)}</span>
                  {m.warnThreshold !== null && (
                    <span className="text-muted-foreground">amber {formatMetric(m.warnThreshold, m.unit)}</span>
                  )}
                  {m.failThreshold !== null && (
                    <span className="text-muted-foreground">red {formatMetric(m.failThreshold, m.unit)}</span>
                  )}
                </div>
                <p className="u-meta leading-relaxed">{m.targetSource}</p>
              </>
            )}
          </div>
          <div className="space-y-2">
            <div className="u-label">Reporting scope</div>
            <p className="u-meta leading-relaxed">{m.asOfRule}</p>
          </div>
        </div>

        {outlooks.length > 0 && (
          <div className="p-4 rounded-lg border border-border bg-card/70 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" />
                <span className="u-subhead">Governed Forward Outlook</span>
                <Tag>{outlooks[0]?.method}</Tag>
                {outlooks[0]?.backtestAccuracy !== null && (
                  <span className="u-meta text-muted-foreground">
                    Backtest accuracy: {(Number(outlooks[0]?.backtestAccuracy) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <Link href="/outlook" className="u-meta text-[var(--link)] hover:text-foreground">
                Interactive simulator &rsaquo;
              </Link>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {outlooks.map((o) => (
                <div key={`${o.grainValue}-${o.horizonPeriod}`} className="p-2.5 rounded bg-secondary/40 border border-border/60 text-xs space-y-1">
                  <div className="flex items-center justify-between font-medium">
                    <span>{o.grainValue ?? o.horizonPeriod}</span>
                    <span className="u-mono">{formatMetric(o.predictedValue, o.unit)}</span>
                  </div>
                  {o.breachProbability !== null && (
                    <div className="flex items-center justify-between text-muted-foreground u-meta">
                      <span>Breach probability</span>
                      <span className="u-mono">{(o.breachProbability * 100).toFixed(1)}% ({o.verdict})</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="u-meta text-muted-foreground italic">
              Basis: {outlooks[0]?.basis}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <div className="u-label">
            Served by {m.bindings.length} semantic view{m.bindings.length === 1 ? "" : "s"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {m.bindings.map((b) => (
              <span
                key={b.semanticView}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 u-mono"
              >
                <span className="font-semibold">{b.semanticView}</span>
                <span className="text-muted-foreground">{b.metricReference}</span>
              </span>
            ))}
          </div>
        </div>

        <Provenance label="Canonical SQL">
          {`SELECT ${m.canonicalSql}\n  FROM SUPPLY_CHAIN.${m.canonicalFact};`}
        </Provenance>
      </div>
    </details>
  )
}

/** A label/value pair inside the disclosure. */
function Field({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="space-y-1 min-w-0">
      <dt className="u-label">{label}</dt>
      <dd className={cn("break-words", mono ? "u-mono text-foreground/90" : "u-meta")}>{children}</dd>
    </div>
  )
}

/** The registry itself: definitions, targets, reporting scope and bindings. */
async function RegistrySection() {
  const [registry, drift, outlook] = await Promise.all([
    getMetricRegistry(),
    getLatestDrift(),
    getMetricOutlook(),
  ])

  const outlookByMetric = new Map<string, MetricOutlook[]>()
  for (const o of outlook) {
    const list = outlookByMetric.get(o.metricId) ?? []
    list.push(o)
    outlookByMetric.set(o.metricId, list)
  }

  const failing = drift.filter((d) => d.status !== "PASS")
  const domains = [...new Set(registry.map((m) => m.domain))]
  const multiView = registry.filter((m) => m.bindings.length > 1)
  const withTarget = registry.filter((m) => m.target !== null)

  return (
    <>
      {/* Five tiles on a five-column grid: a four-column grid wrapped the fifth onto its own row. */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Registered metrics" value={String(registry.length)} sub={domains.join(" · ")} />
        <StatTile
          label="Served by 2+ views"
          value={String(multiView.length)}
          sub="Each must return an identical value from every view"
        />
        <StatTile
          label="With a governed target"
          value={`${withTarget.length} of ${registry.length}`}
          sub="The rest are absolute-dollar amounts, deliberately untargeted"
        />
        <StatTile
          label="Drift status"
          value={failing.length === 0 ? "ALL PASS" : `${failing.length} FAIL`}
          tone={failing.length === 0 ? "good" : "bad"}
          sub={drift[0]?.runAt ? `Last run ${drift[0].runAt.slice(0, 19).replace("T", " ")}` : "Not yet run"}
        />
        <StatTile
          label="Max spread"
          value={drift.length ? Math.max(...drift.map((d) => d.valueSpread ?? 0)).toExponential(1) : "—"}
          tone={failing.length === 0 ? "good" : "bad"}
          sub="Largest difference between any two views serving one metric"
        />
      </section>

      {domains.map((domain) => {
        const metrics = registry.filter((m) => m.domain === domain)
        return (
          <section key={domain} className="space-y-4">
            <SectionHeading note={`${metrics.length} metric${metrics.length === 1 ? "" : "s"}`}>
              {domain}
            </SectionHeading>

            <div className="u-card overflow-hidden">
              {/*
                A registry is a list to scan, not 14 essays to scroll. This page was 7,390px of
                identical fully-expanded cards, three bordered boxes deep, with the same
                no-target rationale repeated verbatim on every untargeted metric. The row now
                carries what you compare across metrics; everything else opens on demand.
              */}
              <div
                className={cn(
                  ROW_GRID,
                  "hidden md:grid px-4 py-2 border-b border-border bg-secondary/50 items-end",
                )}
              >
                <div className="u-label">Metric</div>
                <div className="u-label md:text-right">Canonical value</div>
                <div className="u-label">Against target</div>
                <div className="u-label">Scope</div>
                <div className="u-label md:text-right">Definition agreement</div>
              </div>

              {metrics.map((m) => (
                <MetricRow key={m.metricId} m={m} outlooks={outlookByMetric.get(m.metricId) ?? []} />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

export default async function MetricsPage() {
  return (
    <PageShell
      title="Governed Metric Registry"
      description="Every metric a team can ask about, with its canonical definition, numerator, denominator, grain, target and accountable owner. A metric that is not in this registry is not answerable by the conversational layer — that is what makes the answers governed rather than merely generated."
    >
      <Suspense fallback={<SectionSkeleton title="Drift test history" rows={1} />}>
        <Section title="Drift test history">{() => DriftHistorySection()}</Section>
      </Suspense>

      <Suspense fallback={<SectionSkeleton title="Governed metric registry" rows={6} />}>
        <Section title="Governed metric registry">{() => RegistrySection()}</Section>
      </Suspense>
    </PageShell>
  )
}
