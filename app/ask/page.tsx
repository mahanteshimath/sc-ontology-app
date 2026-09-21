import { Suspense } from "react"
import { PageShell, Provenance, Section, SectionSkeleton } from "@/components/ui-kit"
import { PeriodControl } from "@/components/period-control"
import { getPersonas, getMetricRegistry } from "@/lib/sc"
import { resolvePeriod, type ResolvedPeriod } from "@/lib/period"
import { currentSession } from "@/lib/session"
import { AskChat } from "@/components/ask-chat"
import { AGENT_FQN } from "@/lib/constants"

export const dynamic = "force-dynamic"

/** The chat needs the persona catalogue and the metric count, so it loads in its own section. */
async function AskBody({ period }: { period: ResolvedPeriod }) {
  const [personas, registry] = await Promise.all([getPersonas(), getMetricRegistry()])
  const session = await currentSession()

  /**
   * The persona list is scoped to the signed-in account.
   *
   * A demo account names one persona role, and that is the role its queries run as. Offering a
   * picker over all personas would invite the user to select one they are not, and either the query
   * would fail or — worse — succeed and imply an access level they do not have. Where no session
   * exists (inside SPCS, where the platform authenticates instead), the full list is offered so the
   * cross-persona comparison is still demonstrable.
   */
  const analystPersonas = personas.filter((p) => p.roleName !== "SC_ONTOLOGY_STEWARD")
  const offered = session
    ? analystPersonas.filter((p) => p.roleName === session.personaRole)
    : analystPersonas

  return (
    <AskChat
      personas={offered.map((p) => ({
        roleName: p.roleName,
        personaLabel: p.personaLabel,
        focus: p.focus,
        rowScope: p.rowScope,
      }))}
      metricCount={registry.length}
      period={{
        id: period.id,
        from: period.from,
        to: period.to,
        asOf: period.asOf,
        label: period.label,
        description: period.description,
      }}
    />
  )
}

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)) ?? null
  const period = resolvePeriod({ id: one("period"), from: one("from"), to: one("to"), asOf: one("asOf") })

  return (
    <PageShell
      title="Ask the Ontology"
      description="Ask a cross-domain question in plain language, then follow up on the answer — “and by region?” keeps the metric and changes the breakdown. The resolver may only choose from metrics registered in the governed catalogue and never writes its own SQL, so the same question always resolves to the same definition, and every turn shows which metric, which semantic view and which Snowflake role produced it."
      actions={<PeriodControl asOf={period.asOf} description={period.description} />}
    >
      <Suspense fallback={<SectionSkeleton title="Conversation" rows={1} />}>
        <Section title="Conversation">{() => AskBody({ period })}</Section>
      </Suspense>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm font-semibold">How a question becomes a governed answer</h2>
          <ol className="text-xs text-muted-foreground space-y-1.5 leading-relaxed list-decimal list-inside">
            <li>The registry supplies the complete list of legal metrics and dimensions.</li>
            <li>
              A Cortex model maps the question onto that list and returns metric ids only — it is never asked to write
              SQL. On a follow-up it also sees the last few turns, so a reference like &ldquo;and by region?&rdquo;
              resolves; those remembered ids are re-validated against the registry every turn.
            </li>
            <li>Every returned id is validated against the registry; anything unrecognised is discarded.</li>
            <li>
              The SQL is assembled from the registry as a <code className="font-mono">SEMANTIC_VIEW(…)</code> query, so the
              metric arithmetic comes from the semantic view, not from the model.
            </li>
            <li>
              The chart is chosen from the result shape by code, not by the model, and metrics with different units are
              drawn on separate axes.
            </li>
            <li>
              A second call writes the summary prose. Every number in it is checked against the rows that were actually
              returned; prose containing a figure the result cannot account for is discarded and replaced with a
              deterministic one.
            </li>
          </ol>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm font-semibold">Also available as a Cortex Agent</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            The same governed semantic views are exposed to Snowflake Intelligence as a Cortex Agent with eight Cortex
            Analyst tools and 38 verified queries. Its instructions forbid inventing a metric, require a prediction to be
            labelled as one and quoted with its backtested accuracy, and forbid aggregating a snapshot balance across
            dates.
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            This page does not route through it. An agent resolves permissions from the user&apos;s default role rather
            than the session role, so a row-scoped persona would silently receive all-region numbers — which is the
            distinction this project exists to demonstrate.
          </p>
          <Provenance label="Agent">
            {`${AGENT_FQN}

Tools:
  Ontology_360_Analyst    -> SC_ONTOLOGY_360   (cross-domain)
  Supplier_Analyst        -> SC_SUPPLIER
  Fulfillment_Analyst     -> SC_FULFILLMENT
  Inventory_Analyst       -> SC_INVENTORY
  Landed_Cost_Analyst     -> SC_LANDED_COST
  Demand_Analyst          -> SC_DEMAND
  Manufacturing_Analyst   -> SC_MANUFACTURING
  Metric_Outlook          -> SC_OUTLOOK        (predictions)
  data_to_chart           -> built-in`}
          </Provenance>
        </div>
      </section>
    </PageShell>
  )
}
