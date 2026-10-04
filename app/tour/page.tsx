import Link from "next/link"
import { PageShell } from "@/components/ui-kit"
import { currentSession } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * A three-minute guided path through the judging criteria. Each step names the claim, where to see
 * it, and what proves it — so a judge never has to guess where the evidence lives.
 */
const STEPS: { title: string; href: string; claim: string; look: string }[] = [
  {
    title: "1. The problem, measured",
    href: "/ontology",
    claim: "Source systems answer \u201cwhat is our OTD?\u201d differently; the ontology gives one answer.",
    look: "\u201cMany source systems, one definition\u201d \u2014 TMS, CRM, ERP and supplier portal disagree by up to ~20 points; the governed metric is one value.",
  },
  {
    title: "2. The ontology",
    href: "/ontology",
    claim: "Supplier \u2192 Part \u2192 Plant \u2192 Shipment \u2192 Customer Order \u2192 Customer, as semantic views.",
    look: "\u201cValue chain\u201d \u2014 every link is a declared relationship, and SC_VALUE_CHAIN matches SC_ONTOLOGY_360 exactly on OTD, fill rate and landed cost.",
  },
  {
    title: "3. Canonical metrics",
    href: "/metrics",
    claim: "OTD, fill rate, days of inventory and landed cost are defined once, with owner, target and drift status.",
    look: "Every metric shows its definition, grain and the semantic views that serve it, with drift PASS and zero spread.",
  },
  {
    title: "4. Same metric, every persona",
    href: "/consistency",
    claim: "Planning, procurement and logistics get the identical number, enforced by Snowflake roles.",
    look: "One metric executed as each real role; the deliberately broken legacy view proves the test can fail.",
  },
  {
    title: "5. Ask, and cross-check",
    href: "/ask",
    claim: "Plain-English questions resolve to governed metrics; Cortex Analyst independently agrees.",
    look: "Ask \u201cWhat is our supplier on-time delivery?\u201d, then \u201cAsk Cortex Analyst too\u201d \u2014 both paths, same value, same role.",
  },
  {
    title: "6. Impact",
    href: "/impact",
    claim: "Outcomes are measured, each with its source object and a MEASURED / ASSUMPTION label.",
    look: "Source spread, Analyst accuracy, suppliers wrongly cleared, penalties hidden by the legacy definition.",
  },
]

export default async function TourPage() {
  const session = await currentSession()
  return (
    <PageShell
      title="Guided tour"
      description={`Three minutes through the judging criteria${session ? ` \u00b7 signed in as ${session.username} (${session.personaRole})` : ""}.`}
    >
      <ol className="grid gap-3 md:grid-cols-2">
        {STEPS.map((s) => (
          <li key={s.title} className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{s.title}</span>
              <Link href={s.href} className="text-xs text-[var(--link)] underline underline-offset-4">
                Open {s.href}
              </Link>
            </div>
            <p className="text-sm">{s.claim}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{s.look}</p>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        To see row-level governance, sign out and sign in as <span className="font-mono">logistics-eu</span>: the same
        definition returns EU-only figures, and material cost is masked for logistics personas.
      </p>
    </PageShell>
  )
}
