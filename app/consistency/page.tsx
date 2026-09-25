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
import {
  getMetricRegistry,
  getPersonas,
  getDriftBaseline,
  getNegativeControl,
  getLatestDrift,
  getDivergenceImpact,
  getMisclassifiedSuppliers,
  getLatestEvalRun,
  getEvalByCategory,
  getEvalFailures,
  getAgentParity,
} from "@/lib/sc"
import { formatMetric, formatPercent } from "@/lib/format"
import { ConsistencyRunner } from "@/components/consistency-runner"

export const dynamic = "force-dynamic"

/**
 * Full precision, deliberately.
 *
 * The parity table exists to show differences in the fourth decimal place, so the usual
 * unit-aware formatter is the wrong tool here: rounding to two decimals would render 0.973944 and
 * 0.973633 as the same number and erase the finding.
 */
const six = (v: number | null) => (v === null ? "—" : v.toFixed(6))

async function ConsistencyBody() {
  const [
    registry,
    personas,
    baseline,
    negative,
    drift,
    impact,
    misclassified,
    evalRun,
    evalByCategory,
    evalFailures,
    parity,
  ] = await Promise.all([
    getMetricRegistry(),
    getPersonas(),
    getDriftBaseline(),
    getNegativeControl(),
    getLatestDrift(),
    getDivergenceImpact(),
    getMisclassifiedSuppliers(),
    getLatestEvalRun(),
    getEvalByCategory(),
    getEvalFailures(),
    getAgentParity(),
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

      {/* What the divergence costs, measured rather than asserted. */}
      {impact && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">What that spread actually costs</h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
              Two thirds of a percentage point sounds like rounding. It is not, because nobody acts on the number —
              they act on the verdict. Both definitions were replayed over the same{" "}
              {impact.receiptLines.toLocaleString()} receipt lines and scored against the registry target of{" "}
              {formatPercent(impact.target)}.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Genuinely at target"
              value={String(impact.atTargetGoverned)}
              sub={`of ${impact.suppliers} suppliers, governed definition`}
            />
            <StatTile
              label="Reported at target"
              value={String(impact.atTargetLegacy)}
              tone="bad"
              sub="by the legacy average-of-averages"
            />
            <StatTile
              label="Compliant list inflated"
              value={formatPercent(impact.compliantListInflation)}
              tone="bad"
              sub={`${impact.falsePasses} suppliers cleared without earning it`}
            />
            <StatTile
              label="Wrongly escalated"
              value={String(impact.falseFails)}
              tone={impact.falseFails === 0 ? "bad" : "good"}
              sub="The error only ever runs one way"
            />
          </div>
          <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
            The last tile is the one that matters. A defect that wrongly escalates a supplier is found within a week,
            because the supplier disputes it and somebody rechecks the arithmetic. A defect that wrongly{" "}
            <em>clears</em> a supplier generates no complaint from anyone, so it survives indefinitely. The cost of an
            ungoverned metric is not a wrong dashboard — it is a review that never happens.
          </p>

          {misclassified.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-secondary/80 backdrop-blur">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Supplier</th>
                    <th className="px-3 py-2 font-medium">Region</th>
                    <th className="px-3 py-2 font-medium text-right">Receipt lines</th>
                    <th className="px-3 py-2 font-medium text-right">Governed</th>
                    <th className="px-3 py-2 font-medium text-right">Legacy</th>
                    <th className="px-3 py-2 font-medium text-right">Overstated by</th>
                  </tr>
                </thead>
                <tbody>
                  {misclassified.map((s) => (
                    <tr key={s.supplierName} className="border-t border-border">
                      <td className="px-3 py-2 font-medium whitespace-nowrap">{s.supplierName}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{s.supplierRegion}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {s.receiptLines.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(s.governedOtd)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-500">
                        {formatPercent(s.legacyOtd)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        +{((s.overstatement ?? 0) * 100).toFixed(2)} pp
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Provenance label="How the consequence is counted">
            {`-- Nothing here is stored. The target is read from the registry and both
-- definitions are replayed over the same population on every page load, so a
-- change to the target recomputes the verdict rather than stranding a sentence.

SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_DIVERGENCE_IMPACT;

SELECT supplier_name, receipt_lines, governed_otd, legacy_otd, verdict_class
  FROM SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_OTD_VERDICT
 WHERE misclassified
 ORDER BY overstatement DESC;`}
          </Provenance>
        </section>
      )}

      {/* Conversational accuracy, measured on the same terms as the metrics. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Conversational accuracy, scored</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
            Every governed metric here is drift-tested rather than asserted. For a long time the conversational layer
            was the exception — 60 golden questions existed and nothing ran them. This is the run. Each question is
            asked over HTTP as its own persona, so what is scored is the whole governed path, not the prompt.
          </p>
        </div>

        {!evalRun ? (
          <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground leading-relaxed">
            Not yet measured on this deployment. Run <code className="font-mono">npm run eval</code> to score the
            60-question set. Deliberately not shown as 0% — “never run” and “ran and scored nothing” are opposite facts.
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Resolution accuracy"
                value={formatPercent(evalRun.accuracy)}
                tone={(evalRun.accuracy ?? 0) >= 0.9 ? "good" : "bad"}
                sub={`${evalRun.passed}/${evalRun.questions} questions`}
              />
              <StatTile
                label="Refused correctly"
                value={`${evalRun.refusalsCorrect ?? 0}/${evalRun.refusalsExpected ?? 0}`}
                tone={evalRun.refusalsCorrect === evalRun.refusalsExpected ? "good" : "bad"}
                sub="Declining is a pass, not an absence of one"
              />
              <StatTile
                label="Traps avoided"
                value={String(evalRun.trapsCorrect ?? 0)}
                sub="Snapshot summing, averaged rates, inbound/outbound"
              />
              <StatTile
                label="Latency"
                value={`${((evalRun.meanLatencyMs ?? 0) / 1000).toFixed(1)}s`}
                sub={`mean; p95 ${((evalRun.p95LatencyMs ?? 0) / 1000).toFixed(1)}s`}
              />
            </div>

            {evalByCategory.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/80 backdrop-blur">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium text-right">Passed</th>
                      <th className="px-3 py-2 font-medium text-right">Accuracy</th>
                      <th className="px-3 py-2 font-medium text-right">Mean latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evalByCategory.map((c) => (
                      <tr key={c.category} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{c.category}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.passed}/{c.questions}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            (c.accuracy ?? 0) < 1 ? "text-red-500" : ""
                          }`}
                        >
                          {formatPercent(c.accuracy)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {((c.meanLatencyMs ?? 0) / 1000).toFixed(1)}s
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {evalFailures.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold">What it got wrong ({evalFailures.length})</h3>
                <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
                  Published rather than trimmed. An accuracy figure without the failures behind it is a scoreboard, not
                  a diagnostic — and a question set tuned until it is green has stopped being a test.
                </p>
                {evalFailures.map((f) => (
                  <div key={f.questionId} className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold">{f.questionId}</span>
                      <Tag>{f.category}</Tag>
                      {f.personaRole && <span className="text-[11px] font-mono text-muted-foreground">{f.personaRole}</span>}
                    </div>
                    <div className="text-sm">{f.question}</div>
                    <div className="text-[11px] text-muted-foreground font-mono break-words">{f.failureMode}</div>
                  </div>
                ))}
              </div>
            )}

            <Provenance label="How a run is scored">
              {`-- Scored ${evalRun.runAt?.slice(0, 19).replace("T", " ")} UTC against ${evalRun.targetBase}
-- Resolver: ${evalRun.resolverModel}
--
--   should_answer = FALSE        pass when the layer declines
--   expected_metric_ids IS NULL  pass when it asks instead of guessing (ambiguous)
--   otherwise                    pass when resolved ids == expected, order-insensitive

npm run eval

SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_AGENT_EVAL_LATEST;
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_AGENT_EVAL_FAILURE;`}
            </Provenance>
          </>
        )}
      </section>

      {/* Two engines, one definition. */}
      {parity.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Two engines, one definition</h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
              The Cortex Agent and this application answer the same question by different means — the agent picks a
              domain view and writes its own SQL, the application resolves registered metric ids and assembles the
              query from the registry against the cross-domain view, under the persona&apos;s role. A third number,
              the metric&apos;s <code className="font-mono">CANONICAL_SQL</code>, breaks the tie.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/80 backdrop-blur">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 font-medium">Agent SQL</th>
                  <th className="px-3 py-2 font-medium text-right">Agent</th>
                  <th className="px-3 py-2 font-medium text-right">App</th>
                  <th className="px-3 py-2 font-medium text-right">Canonical</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {parity.map((p) => (
                  <tr key={p.metricId} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{p.metricId}</td>
                    <td className="px-3 py-2">
                      <Tag>{p.agentVerifiedQuery ? "verified query" : "derived"}</Tag>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">{six(p.agentValue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">{six(p.appValue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                      {six(p.canonicalValue)}
                    </td>
                    <td className="px-3 py-2">
                      {/* AS_OF_GAP is a pass: the agent matched CANONICAL_SQL exactly and the
                          residual is the governed as-of rule, not a definition difference. */}
                      <StatusPill
                        status={p.status === "DIVERGE" || p.status === "ERROR" ? "FAIL" : "PASS"}
                        label={p.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1.5">
            {parity.map((p) => (
              <p key={p.metricId} className="text-[11px] text-muted-foreground leading-relaxed">
                <span className="font-mono">{p.metricId}</span> — {p.detail}
              </p>
            ))}
          </div>
          <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
            The result splits cleanly on one variable. Where the agent reused a <strong>verified query</strong> it
            matched the canonical definition exactly. Where it <strong>derived its own SQL</strong> it returned a number
            matching neither the registry nor its own previous run — customer fill rate came back 0.973944 on one run
            and 0.973633 on the next. Free-text to SQL is non-deterministic at the third decimal place, which is
            invisible on a dashboard and decisive in a review. The application never writes SQL, so it cannot do this.
          </p>
          <Provenance label="How parity is run">
            {`-- Recorded out of band, not on page load: a full agent turn routinely exceeds
-- the serverless budget, and the page that argues the system is trustworthy
-- should not be the page most likely to time out.

npm run parity

SELECT metric_id, status, agent_value, app_value, canonical_value, agent_verified_query
  FROM SUPPLY_CHAIN.GOVERNANCE.V_AGENT_PARITY_LATEST;`}
          </Provenance>
        </section>
      )}
    </>
  )
}

export default async function ConsistencyPage() {
  return (
    <PageShell
      title="Cross-Persona Consistency"
      description="Compare governed metrics across real Snowflake roles and row scopes."
    >
      <Suspense fallback={<SectionSkeleton title="Cross-persona consistency" rows={4} />}>
        <Section title="Cross-persona consistency">{() => ConsistencyBody()}</Section>
      </Suspense>
    </PageShell>
  )
}
