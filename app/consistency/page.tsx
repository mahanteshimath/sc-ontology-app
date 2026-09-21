import { Suspense } from "react"
import {
  PageShell,
  StatTile,
  StatusPill,
  Tag,
  Provenance,
  Section,
  SectionSkeleton,
} from "@/components/ui-kit"
import { getMetricRegistry, getPersonas, getDriftBaseline, getNegativeControl, getLatestDrift } from "@/lib/sc"
import { formatMetric, formatPercent } from "@/lib/format"
import { ConsistencyRunner } from "@/components/consistency-runner"

export const dynamic = "force-dynamic"

async function ConsistencyBody() {
  const [registry, personas, baseline, negative, drift] = await Promise.all([
    getMetricRegistry(),
    getPersonas(),
    getDriftBaseline(),
    getNegativeControl(),
    getLatestDrift(),
  ])

  const analystPersonas = personas.filter((p) => p.roleName !== "SC_ONTOLOGY_STEWARD")
  const multiView = registry.filter((m) => m.bindings.length > 1)
  const failing = drift.filter((d) => d.status !== "PASS")

  const canonical = baseline.find((b) => b.semanticView.startsWith("CANONICAL"))
  const before = baseline.filter((b) => !b.semanticView.startsWith("CANONICAL"))
  const spread =
    before.length === 2 && before[0].observedValue !== null && before[1].observedValue !== null
      ? Math.abs(before[0].observedValue - before[1].observedValue)
      : null

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Personas"
          value={String(analystPersonas.length)}
          sub="Real roles, enforced by Snowflake RBAC"
        />
        <StatTile
          label="Shared metrics"
          value={String(multiView.length)}
          sub="Served by more than one semantic view"
        />
        <StatTile
          label="Current agreement"
          value={failing.length === 0 ? "EXACT" : `${failing.length} DIVERGENT`}
          tone={failing.length === 0 ? "good" : "bad"}
          sub="Zero spread across all bindings"
        />
        <StatTile
          label="Divergence before fix"
          value={spread !== null ? formatPercent(spread) : "—"}
          tone="bad"
          sub="Supplier OTD, same question, two answers"
        />
      </section>

      {/* Live cross-persona execution */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Live cross-persona execution</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
            Pick a governed metric. The app re-executes it once per persona role, through each semantic view that persona
            can reach, using that role&apos;s own grants. Identical values mean the definition — not the team — decides the
            answer.
          </p>
        </div>
        <ConsistencyRunner
          metrics={multiView.map((m) => ({
            metricId: m.metricId,
            businessName: m.businessName,
            unit: m.unit,
            definition: m.definition,
          }))}
        />
      </section>

      {/* Persona access model */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Persona access model</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/80 backdrop-blur sticky top-0 z-10">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Persona</th>
                <th className="px-3 py-2 font-medium">Snowflake role</th>
                <th className="px-3 py-2 font-medium">Focus</th>
                <th className="px-3 py-2 font-medium">Row scope</th>
                <th className="px-3 py-2 font-medium">Semantic views</th>
              </tr>
            </thead>
            <tbody>
              {personas.map((p) => (
                <tr key={p.roleName} className="border-t border-border">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{p.personaLabel}</td>
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">{p.roleName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.focus}</td>
                  <td className="px-3 py-2">
                    <Tag>{p.rowScope}</Tag>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {p.accessibleSemanticViews}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
          Row scope and metric definition are deliberately separate concerns. The EU-scoped logistics role sees fewer rows
          because of a row access policy, but it computes on-time delivery with exactly the same definition as every other
          persona. Narrowing <em>which rows</em> a team can see must never change <em>what a metric means</em>.
        </p>
      </section>

      {/* The recorded divergence */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">The divergence we found and fixed</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
            Captured from the live system before remediation and stored permanently, so this is a measurement rather than
            a claim. Both views intended to report the same metric, and both carried a comment saying so.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {baseline.map((b) => {
            const isCanonical = b.semanticView.startsWith("CANONICAL")
            const isDefect = b.rootCause?.startsWith("DEFECT")
            return (
              <div
                key={b.semanticView}
                className={`rounded-lg border p-4 space-y-2 ${
                  isDefect
                    ? "border-red-500/40 bg-red-500/5"
                    : isCanonical
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-border bg-card"
                }`}
              >
                {/*
                  The chip row keeps its height whether or not this card has a chip. The one card
                  without one (the agreeing view) otherwise pulled its heading and its value ~3px
                  above the other two — misaligning the three numbers the reader is being asked to
                  compare, which is the whole point of the row.
                */}
                <div className="flex items-center justify-between gap-2 min-h-[1.5rem]">
                  <span className="text-xs font-mono font-semibold">{b.semanticView}</span>
                  {isDefect && <Tag>defect</Tag>}
                  {isCanonical && <Tag>truth</Tag>}
                </div>
                <div className="u-value">{formatPercent(b.observedValue)}</div>
                <div className="u-mono text-muted-foreground break-words">{b.metricReference}</div>
                <p className="u-meta leading-relaxed">{b.rootCause}</p>
              </div>
            )
          })}
        </div>
        <Provenance label="Why the numbers differed">
          {`-- SC_SUPPLIER read a view that was ALREADY aggregated:
SELECT supplier_id, tier, family, DATE_TRUNC('month', receipt_date) AS period,
       AVG(IFF(receipt_date <= promised_date, 1, 0)) AS supplier_otd_pct   -- rate per supplier-month
  FROM purchase_order ... GROUP BY 1,2,3,4;

-- then averaged those rates again:
SUPPLIER_OTD_PCT = AVG(supplier.otd)      -- average of averages

-- A supplier with 3 receipts counted as much as one with 30,000.
-- The fix: define the metric once, over atomic purchase-order lines:
SUPPLIER_OTD_PCT = AVG(is_on_time)        -- 420,000 PO lines, proportionally weighted`}
        </Provenance>
      </section>

      {/* Negative control */}
      {negative && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Proof the test can fail</h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
              A drift test that always passes proves nothing. The defective definition was deliberately re-bound to the
              metric and the test was re-run; it failed, as it must. The binding was then removed and this result kept as
              evidence.
            </p>
          </div>
          <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill status={negative.status} />
              <span className="text-sm font-mono">{negative.metricId}</span>
              <span className="text-xs text-muted-foreground">
                spread {negative.valueSpread?.toFixed(8)} · detected at{" "}
                {negative.runAt?.slice(0, 19).replace("T", " ")}
              </span>
            </div>
            <div className="text-[11px] font-mono text-muted-foreground break-words">{negative.detail}</div>
          </div>
        </section>
      )}
    </>
  )
}

export default async function ConsistencyPage() {
  return (
    <PageShell
      title="Cross-Persona Consistency"
      description="The claim this project stands on: planning, procurement and logistics ask the same question and get the same number. This page executes a governed metric as each real Snowflake role and shows the results side by side, alongside the divergence that existed before remediation."
    >
      <Suspense fallback={<SectionSkeleton title="Cross-persona consistency" rows={4} />}>
        <Section title="Cross-persona consistency">{() => ConsistencyBody()}</Section>
      </Suspense>
    </PageShell>
  )
}
