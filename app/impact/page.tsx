import { Suspense } from "react"
import { PageShell, StatTile, Tag, Provenance, Section, SectionSkeleton } from "@/components/ui-kit"
import {
  getImpactScorecard,
  getContractImpact,
  getContractExtractionAccuracy,
  getContractBreaches,
  getRefusalMix,
  getOntologyDemand,
} from "@/lib/sc"
import { formatPercent } from "@/lib/format"

export const dynamic = "force-dynamic"

const usd = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const six = (v: number | null) => (v === null ? "—" : v.toFixed(6))

/** The sentence of the contract that carries the service level - the evidence behind the flag. */
function serviceClause(text: string) {
  const s = text.split(/(?<=\.)\s+|\n/).find((x) => /on[- ]time|promised date|delivery date/i.test(x))
  return s?.trim() ?? text.slice(0, 180)
}

async function ScorecardBody() {
  const rows = await getImpactScorecard()
  return (
    <>
      <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
        Every figure below is read from a governed object at page load and carries its source. Exactly one input is an
        assumption: how long a disputed cross-team metric takes to settle by hand. It is labelled, and the one row derived
        from it says so.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/80">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Pillar</th>
              <th className="px-3 py-2 font-medium">Measure</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="px-3 py-2 font-medium">Basis</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ord} className="border-t border-border align-top">
                <td className="px-3 py-2 whitespace-nowrap font-medium">{r.pillar}</td>
                <td className="px-3 py-2 text-xs">{r.measure}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{r.value}</td>
                <td className="px-3 py-2">
                  <Tag title={r.basis === "ASSUMPTION" ? "Not measured - replace with your own figure" : "Computed on read"}>
                    {r.basis}
                  </Tag>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{r.sourceObject}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Provenance label="How the scorecard is assembled">
        {`SELECT ord, pillar, measure, value, basis, source_object
  FROM SUPPLY_CHAIN.GOVERNANCE.V_IMPACT_SCORECARD
 ORDER BY ord;
-- sql/17_impact_scorecard.sql. Nothing is stored; every row is recomputed on read.`}
      </Provenance>
    </>
  )
}

async function ContractsBody() {
  const [impact, accuracy, breaches] = await Promise.all([
    getContractImpact(),
    getContractExtractionAccuracy(),
    getContractBreaches(12),
  ])
  if (!impact) return <p className="u-meta">Contract layer not built. Run sql/16_supplier_contracts.sql.</p>

  return (
    <>
      <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
        Supplier agreements are free text, one per supplier. AI_EXTRACT reads the on-time commitment, how it is measured,
        and the penalty terms into <span className="font-mono">CANONICAL.DIM_SUPPLIER_CONTRACT</span>, and each term is
        scored against the generator&apos;s ground truth. The governed supplier OTD is then held against the signed
        commitment, and the legacy average-of-averages is held against it too.
      </p>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Extraction accuracy"
          value={impact.extractionAccuracy === null ? "—" : formatPercent(impact.extractionAccuracy, 1)}
          tone={impact.extractionAccuracy !== null && impact.extractionAccuracy >= 0.95 ? "good" : "warn"}
          sub={`${impact.contracts} contracts, ${accuracy.length} fields each, scored`}
        />
        <StatTile
          label="Claimable penalties"
          value={usd(impact.penaltyExposureUsd)}
          sub={`${impact.breachesGoverned} suppliers below their signed commitment`}
        />
        <StatTile
          label="Hidden by legacy metric"
          value={usd(impact.penaltyMissedByLegacyUsd)}
          tone="bad"
          sub={`${impact.hiddenBreaches} breaches the legacy dashboard shows as compliant`}
        />
        <StatTile
          label="Definition conflicts"
          value={String(impact.definitionConflicts)}
          tone="warn"
          sub="Contracts that measure OTD as a monthly average - renegotiate"
        />
      </section>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/80">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Supplier</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Commitment</th>
              <th className="px-3 py-2 font-medium text-right">Governed OTD</th>
              <th className="px-3 py-2 font-medium text-right">Legacy OTD</th>
              <th className="px-3 py-2 font-medium text-right">Penalty</th>
              <th className="px-3 py-2 font-medium">What the contract says</th>
            </tr>
          </thead>
          <tbody>
            {breaches.map((b) => (
              <tr key={b.contractNumber} className="border-t border-border align-top">
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="font-medium">{b.supplierName}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {b.contractNumber} · {b.supplierRegion}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Tag
                    title={
                      b.status === "HIDDEN_BREACH"
                        ? "Below commitment on the governed metric, above it on the legacy one"
                        : "Below commitment on both definitions"
                    }
                  >
                    {b.status}
                  </Tag>
                  {b.otdBasis === "MONTHLY_AVERAGE" && (
                    <div className="mt-1">
                      <Tag title="The contract itself encodes the non-governed definition">DEFINITION_CONFLICT</Tag>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[12px]">{b.otdCommitment?.toFixed(2)}</td>
                <td className="px-3 py-2 text-right font-mono text-[12px]">{six(b.governedOtd)}</td>
                <td className="px-3 py-2 text-right font-mono text-[12px]">{six(b.legacyOtd)}</td>
                <td className="px-3 py-2 text-right font-mono text-[12px] whitespace-nowrap">{usd(b.penaltyExposureUsd)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground max-w-md italic">&ldquo;{serviceClause(b.contractText)}&rdquo;</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Provenance label="Extraction and compliance SQL">
        {`-- Terms read from free text (sql/16_supplier_contracts.sql)
AI_EXTRACT(text => contract_text, responseFormat => {
  'otd_commitment': 'What minimum percentage of order lines must be delivered on time?',
  'otd_basis':      'Is on-time performance measured per line, or as an average of monthly rates?',
  'penalty_pct':    'What percentage of the value of late lines is owed as a penalty?', ... })

-- Per-field accuracy against ground truth
${accuracy.map((a) => `--   ${a.field.padEnd(16)} ${a.correct}/${a.documents}`).join("\n")}

-- Both OTD figures come from GOVERNANCE.V_SUPPLIER_OTD_VERDICT, never re-derived.
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE WHERE breach_governed;`}
      </Provenance>
    </>
  )
}

export default async function ImpactPage() {
  return (
    <PageShell
      title="Impact"
      description="What governed definitions are worth, measured: consistency, accuracy, decisions, money and time, each with its source."
    >
      <Suspense fallback={<SectionSkeleton title="Impact scorecard" rows={3} />}>
        <Section title="Impact scorecard">{() => ScorecardBody()}</Section>
      </Suspense>
      <Suspense fallback={<SectionSkeleton title="Supplier contracts: the unstructured source" rows={4} />}>
        <Section title="Supplier contracts: the unstructured source">{() => ContractsBody()}</Section>
      </Suspense>
      <Suspense fallback={<SectionSkeleton title="What teams asked for: the ontology roadmap" rows={3} />}>
        <Section title="What teams asked for: the ontology roadmap">{() => DemandBody()}</Section>
      </Suspense>
    </PageShell>
  )
}

const CLASS_NOTE: Record<string, string> = {
  ACCESS_DENIED: "Metric exists; persona not granted it. The grant model working.",
  GUARDRAIL: "Unsafe as asked (ambiguous, snapshot summed, future-dated). The rules working.",
  UNREGISTERED_METRIC: "Measure exists in a semantic view but is not governed. Cheap to close.",
  OUT_OF_SCOPE: "Data not in the ontology (margin, carbon, HR). A sourcing decision.",
}

async function DemandBody() {
  const [mix, demand] = await Promise.all([getRefusalMix(), getOntologyDemand()])
  if (mix.length === 0) return <p className="u-meta">Demand log not classified yet. Run sql/21_ontology_demand.sql.</p>
  const wanted = demand.filter((d) => d.refusedQuestions > 0)
  const total = mix.reduce((n, m) => n + m.timesAsked, 0)
  const working = mix.filter((m) => m.governanceWorking).reduce((n, m) => n + m.timesAsked, 0)

  return (
    <>
      <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
        Every question the conversational layer declines is logged. Read together, refusals are the roadmap: AI_CLASSIFY
        sorts each one by why it was refused, and matches the gaps against measures that already exist in a semantic view
        but are not yet governed. Classification is AI-assisted - review before promoting a metric.
      </p>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {mix.map((m) => (
          <StatTile
            key={m.refusalClass}
            label={m.refusalClass.replace(/_/g, " ").toLowerCase()}
            value={`${m.timesAsked}`}
            tone={m.governanceWorking ? "good" : m.refusalClass === "UNREGISTERED_METRIC" ? "warn" : "default"}
            sub={`${m.distinctQuestions} distinct question${m.distinctQuestions === 1 ? "" : "s"}. ${CLASS_NOTE[m.refusalClass] ?? ""}`}
          />
        ))}
      </section>
      <p className="u-meta">
        {Math.round((working / Math.max(total, 1)) * 100)}% of refusals were governance doing its job; the rest is demand.
      </p>
      {wanted.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/80">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Promote next</th>
                <th className="px-3 py-2 font-medium text-right">Asks</th>
                <th className="px-3 py-2 font-medium">Already in</th>
                <th className="px-3 py-2 font-medium">What people asked</th>
              </tr>
            </thead>
            <tbody>
              {wanted.map((d) => (
                <tr key={d.metricReference} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap">{d.metricReference}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{d.timesAsked}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{d.semanticViews.join(", ")}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground italic">&ldquo;{d.sampleQuestions[0]}&rdquo;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Provenance label="How demand is classified">
        {`-- sql/21_ontology_demand.sql, refreshed weekly by CLASSIFY_QUESTION_DEMAND_WEEKLY
AI_CLASSIFY('Question: ' || question || ' | Refusal reason: ' || refusal_reason,
            ['ACCESS_DENIED', 'GUARDRAIL', 'UNREGISTERED_METRIC', 'OUT_OF_SCOPE'])
-- candidates: measures in INFORMATION_SCHEMA.SEMANTIC_METRICS with no METRIC_BINDING
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_ONTOLOGY_DEMAND ORDER BY times_asked DESC;`}
      </Provenance>
    </>
  )
}
