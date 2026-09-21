import type React from "react"
import { cn } from "@/lib/utils"
import { ragChipClass, ragDotClass, type RagState } from "@/lib/target"

/**
 * Page shell: consistent width, heading and description across all routes.
 *
 * `space-y-10` between sections is the deliberate major interval. Previously this was `space-y-6`
 * while groups inside a section were also ~12px apart, so section boundaries were invisible and
 * every page had to be read linearly instead of skimmed.
 */
export function PageShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main className="w-full max-w-[1400px] mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-10">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="space-y-2 min-w-0">
          <h1 className="text-[length:var(--fs-page)] font-semibold tracking-tight leading-tight">{title}</h1>
          {description && <p className="u-body u-prose text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>
      {children}
    </main>
  )
}

/**
 * Section heading with an optional right-hand note.
 *
 * Extracted because every page was hand-rolling this pair at a size smaller than the numbers inside
 * the section, so headings did not register as headings.
 */
export function SectionHeading({
  children,
  note,
  id,
}: {
  children: React.ReactNode
  note?: React.ReactNode
  id?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 flex-wrap border-b border-border pb-2">
      <h2 id={id} className="text-[length:var(--fs-title)] font-semibold tracking-tight">
        {children}
      </h2>
      {note && <span className="u-meta">{note}</span>}
    </div>
  )
}

/** A labelled value tile. */
export function StatTile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string
  value: string
  sub?: string
  tone?: "default" | "good" | "bad" | "warn"
}) {
  const toneVar =
    tone === "good"
      ? "var(--status-good)"
      : tone === "bad"
        ? "var(--status-bad)"
        : tone === "warn"
          ? "var(--status-warn)"
          : undefined
  return (
    <div className="u-card p-4 flex flex-col gap-1.5">
      <div className="u-label">{label}</div>
      <div className="u-value" style={toneVar ? { color: toneVar } : undefined}>
        {value}
      </div>
      {sub && <div className="u-meta mt-auto pt-0.5">{sub}</div>}
    </div>
  )
}

/** Monospace provenance block: shows the exact SQL or definition behind a number. */
export function Provenance({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3">
      <div className="u-label mb-2">{label}</div>
      <pre className="u-mono leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
        {children}
      </pre>
    </div>
  )
}

/**
 * PASS / FAIL pill for drift status, or a target-aware RAG pill.
 *
 * The two are deliberately different things and must not be confused: drift status says whether
 * every semantic view agrees on the *definition*, while the target state says whether the resulting
 * *number* is acceptable. A metric can be green on drift and red against target — that is the
 * normal, healthy case for a business that is missing a goal but measuring it correctly. Rendering
 * them with the same component but different `kind` keeps the visual language consistent while the
 * label makes the distinction explicit.
 */
export function StatusPill({
  status,
  kind = "drift",
  label,
}: {
  status: string | null
  kind?: "drift" | "target"
  label?: string
}) {
  if (!status) {
    return <span className="u-meta">{kind === "target" ? "no target" : "not tested"}</span>
  }

  if (kind === "target") {
    const state = status as RagState
    return (
      <span
        title="Against target — separate from drift status, which is about definitional agreement"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[length:var(--fs-label)] font-medium border whitespace-nowrap",
          ragChipClass(state),
        )}
      >
        <span className={cn("size-1.5 rounded-full shrink-0", ragDotClass(state))} />
        {label ?? state}
      </span>
    )
  }

  const pass = status === "PASS"
  return (
    <span
      title="Drift status — whether every semantic view serving this metric returns an identical value"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[length:var(--fs-label)] font-medium border whitespace-nowrap",
        pass
          ? "u-chip-good"
          : "u-chip-bad",
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", pass ? "u-dot-good" : "u-dot-bad")} />
      {label ?? status}
    </span>
  )
}

/** Small neutral tag. */
export function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded border border-border bg-secondary/70 px-1.5 py-0.5 u-mono text-muted-foreground"
    >
      {children}
    </span>
  )
}

/** Inline error surface — used when a governed query fails. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border p-3 u-body"
      style={{
        borderColor: "color-mix(in oklab, var(--status-bad) 35%, transparent)",
        background: "color-mix(in oklab, var(--status-bad) 9%, transparent)",
        color: "var(--status-bad)",
      }}
    >
      {message}
    </div>
  )
}

/**
 * Render an async section, or an error in its place.
 *
 * Every page used to wrap all of its queries in one try/catch, so a single slow or failing
 * semantic-view query blanked the whole screen — the ontology diagram disappeared because a
 * freight metric timed out. This confines a failure to the section that caused it, and names the
 * section so the message is diagnosable rather than just red.
 *
 * Used with Suspense (see SectionSkeleton) so sections stream in independently rather than the page
 * waiting on its slowest query.
 */
export async function Section({
  title,
  children,
}: {
  title: string
  children: () => Promise<React.ReactNode>
}) {
  try {
    return await children()
  } catch (e) {
    return (
      <section className="space-y-3">
        <SectionHeading>{title}</SectionHeading>
        <ErrorNote message={`${title} could not be loaded: ${e instanceof Error ? e.message : String(e)}`} />
      </section>
    )
  }
}

/** Placeholder shown while a section's queries are still running. */
export function SectionSkeleton({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <section className="space-y-3" aria-busy="true" aria-live="polite">
      <SectionHeading note="loading…">{title}</SectionHeading>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="u-card p-4 space-y-2.5">
            {/* Shapes match the real card's layout, so the page does not reflow when data lands. */}
            <div className="h-3 w-1/2 rounded bg-secondary animate-pulse" />
            <div className="h-7 w-2/3 rounded bg-secondary animate-pulse" />
            <div className="h-2 w-full rounded bg-secondary/70 animate-pulse" />
            <div className="h-2 w-4/5 rounded bg-secondary/70 animate-pulse" />
          </div>
        ))}
      </div>
    </section>
  )
}
