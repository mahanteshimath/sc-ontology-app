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
      description="Ask a question or follow up by breakdown. Answers resolve only to registered metrics."
      actions={<PeriodControl asOf={period.asOf} description={period.description} />}
    >
      <Suspense fallback={<SectionSkeleton title="Conversation" rows={1} />}>
        <Section title="Conversation">{() => AskBody({ period })}</Section>
      </Suspense>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="u-card p-4 space-y-2">
          <h2 className="u-subhead">Governed answer path</h2>
          <p className="u-meta">Question → registered metric → validated semantic query → chart and provenance.</p>
        </div>
        <div className="u-card p-4 space-y-2">
          <h2 className="u-subhead">Cortex Agent</h2>
          <p className="u-meta">The same views power the Agent. This screen stays role-scoped through the application resolver.</p>
          <Provenance label="Agent">
            {`${AGENT_FQN}
8 Analyst tools · 38 verified queries`}
          </Provenance>
        </div>
      </section>
    </PageShell>
  )
}
