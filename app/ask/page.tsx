import { Suspense } from "react"
import Link from "next/link"
import { RefreshCw, ShieldCheck } from "lucide-react"
import { PageShell, Section, SectionSkeleton } from "@/components/ui-kit"
import { PeriodControl } from "@/components/period-control"
import { getPersonas, getMetricRegistry } from "@/lib/sc"
import { resolvePeriod, type ResolvedPeriod } from "@/lib/period"
import { currentSession } from "@/lib/session"
import { AskChat } from "@/components/ask-chat"

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
   * cross-persona comparison is still demonstrable — minus SC_ONTOLOGY_STEWARD, which is the
   * all-access administrative role rather than an analyst persona to compare.
   *
   * A signed-in STEWARD session is scoped to itself first, so a demo account that names STEWARD
   * (the app owner's own login) still gets a populated picker instead of an empty one.
   */
  const offered = session
    ? personas.filter((p) => p.roleName === session.personaRole)
    : personas.filter((p) => p.roleName !== "SC_ONTOLOGY_STEWARD")

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

async function AskWorkspace({ period }: { period: ResolvedPeriod }) {
  try {
    return await AskBody({ period })
  } catch (error) {
    const message = error instanceof Error ? error.message : "The governed analytics service is unavailable."
    return (
      <section className="u-card overflow-hidden">
        <div className="border-b border-border bg-secondary/35 px-5 py-4">
          <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-md bg-[color-mix(in_oklab,var(--status-bad)_12%,transparent)] text-[var(--status-bad)]"><ShieldCheck className="h-4 w-4" aria-hidden /></span><div><h2 className="u-subhead">Analyst workspace unavailable</h2><p className="u-meta">No question has been sent.</p></div></div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <p className="u-body text-muted-foreground">The workspace could not load its governed metric catalogue. Check the Snowflake connection, then retry.</p>
          <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 u-mono text-muted-foreground">{message}</div>
          <Link href="/ask" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"><RefreshCw className="h-4 w-4" aria-hidden />Retry workspace</Link>
        </div>
      </section>
    )
  }
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
      <Suspense fallback={<SectionSkeleton title="Analyst workspace" rows={1} />}>
        <Section title="Analyst workspace">{() => AskWorkspace({ period })}</Section>
      </Suspense>
    </PageShell>
  )
}
