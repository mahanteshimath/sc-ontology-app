"use client"

/**
 * Conversational governed analytics.
 *
 * Replaces the single-shot panel this page used to carry, which answered one question at a time,
 * discarded the previous answer, and rendered every dimensional result as a table. The change that
 * matters is not the transcript — it is that a follow-up can now say "and by region?" and be
 * understood, which is how people actually interrogate a number.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT CHAT-LIKE
 *
 * A chat interface invites the assumption that the assistant is reasoning freely. Here it is not,
 * and the UI keeps saying so rather than hiding it:
 *   - every turn still shows the role it executed as, the generated SQL, and the governed source of
 *     each metric. Provenance is collapsed per turn so the transcript stays readable, not removed.
 *   - the persona and period in force are recorded ON each turn. In a scrolling transcript the
 *     controls at the top no longer describe what is on screen, so a figure captured under one
 *     persona would otherwise sit above a figure captured under another with nothing to tell them
 *     apart.
 *   - prose is labelled when it came from the deterministic template instead of the narrator, so a
 *     reader is never left guessing which they are looking at.
 *
 * TWO REQUESTS PER TURN, ON PURPOSE. /api/ask returns the governed number and the chart spec;
 * /api/ask/narrate then describes them. The number and chart render as soon as the first call
 * returns and the prose arrives behind it, which keeps each request inside the 10s serverless limit
 * documented in lib/env.ts and shows the governed figure before any commentary about it.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useMutation } from "@tanstack/react-query"
import { ArrowUp, BotMessageSquare, RefreshCw, RotateCcw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusPill, Tag } from "@/components/ui-kit"
import { DrilldownButton } from "@/components/drilldown"
import { AskCharts } from "@/components/ask-charts"
import { formatMetricValue } from "@/lib/format"
import { assessTarget, ragTextClass } from "@/lib/target"
import { type MetricOutlook } from "@/lib/sc"
import type { ChartSpec } from "@/lib/chart"

interface PersonaOption {
  roleName: string
  personaLabel: string
  focus: string
  rowScope: string
}

interface MetricMeta {
  metricId: string
  businessName: string
  reference: string
  unit: string | null
  definition: string
  grain: string
  ownerRole: string | null
  driftStatus: string | null
  asOfScope: string | null
  target: number | null
  warnThreshold: number | null
  failThreshold: number | null
  direction: string | null
  servedBy: string[]
  column: string
}

interface AskResponse {
  answerable: boolean
  reason: string
  semanticView?: string
  dimension?: string | null
  dimensionColumn?: string | null
  period?: { label: string; description: string }
  persona?: { roleName: string; personaLabel: string; rowScope: string } | null
  executedAs?: string
  personaError?: string | null
  predictions?: MetricOutlook[]
  metrics?: MetricMeta[]
  chart?: ChartSpec
  chartRows?: Record<string, any>[]
  rows?: Record<string, any>[]
  rowCount?: number
  snapshotDate?: string | null
  sql?: string
  suggestions?: string[]
  error?: string
}

interface NarrateResponse {
  narration?: string
  narrationSource?: "model" | "template"
  rejectedNumbers?: string[]
  note?: string | null
  error?: string
}

/** One exchange in the transcript. */
interface Turn {
  id: string
  question: string
  /** Persona and period as they were when this turn was asked, not as they are now. */
  askedAsRole: string
  askedAsLabel: string
  periodLabel: string
  answer: AskResponse | null
  error: string | null
  narration: NarrateResponse | null
  narrating: boolean
}

const STARTERS = [
  { label: "Supplier reliability", question: "What is our supplier on-time delivery?" },
  { label: "Service comparison", question: "How does supplier on-time delivery compare with the on-time delivery we give customers?" },
  { label: "Product-family view", question: "Show fill rate, days of inventory and landed cost per unit by product family" },
  { label: "Target risk", question: "Which product families will miss their on-time delivery target next month?" },
]

/**
 * Follow-ups offered after an answer.
 *
 * These exist to make the multi-turn behaviour discoverable. A user shown a plain text box assumes
 * every question must be self-contained, and never finds out that "and by region?" works.
 */
const FOLLOW_UPS = [
  "And by supplier region?",
  "Break that down by product family",
  "Same thing by carrier",
  "How does that compare to inventory cover?",
  "Which are missing target?",
]

/** Turns replayed to the resolver so a follow-up can be interpreted. */
const HISTORY_WINDOW = 6

export function AskChat({
  personas,
  metricCount,
  period,
}: {
  personas: PersonaOption[]
  metricCount: number
  period: { id: string; from: string | null; to: string | null; asOf: string; label: string; description: string }
}) {
  const [question, setQuestion] = useState("")
  const [persona, setPersona] = useState(personas[0]?.roleName ?? "")
  const [turns, setTurns] = useState<Turn[]>([])
  const endRef = useRef<HTMLDivElement | null>(null)

  const selected = personas.find((p) => p.roleName === persona)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns])

  const narrate = useCallback(async (turnId: string, answer: AskResponse) => {
    try {
      const res = await fetch("/api/ask/narrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: turns.find((t) => t.id === turnId)?.question ?? "",
          metrics: answer.metrics,
          rows: answer.chartRows?.length ? answer.chartRows : answer.rows,
          dimensionColumn: answer.dimensionColumn ?? null,
          periodLabel: answer.period?.label ?? period.label,
          personaLabel: answer.persona?.personaLabel ?? null,
          snapshotDate: answer.snapshotDate ?? null,
        }),
      })
      const json = (await res.json()) as NarrateResponse
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, narration: res.ok ? json : null, narrating: false } : t)),
      )
    } catch {
      // Narration is commentary on a number that is already on screen. Losing it degrades the turn;
      // it does not invalidate it, so the failure is silent rather than shown as an error.
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, narrating: false } : t)))
    }
  }, [turns, period.label])

  const mutation = useMutation<{ turnId: string; answer: AskResponse }, Error, { turnId: string; q: string }>({
    mutationFn: async ({ turnId, q }) => {
      /**
       * Only answered, non-refused turns are replayed.
       *
       * A refusal establishes nothing for a follow-up to refer back to, and feeding it to the
       * resolver as context invites it to treat the rejected metric as though it were available.
       */
      const history = turns
        .filter((t) => t.answer?.answerable && t.answer.metrics?.length)
        .slice(-HISTORY_WINDOW)
        .map((t) => ({
          question: t.question,
          metricIds: t.answer!.metrics!.map((m) => m.metricId),
          dimension: t.answer!.dimension ?? null,
        }))

      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: q,
          persona,
          period: period.id,
          from: period.from,
          to: period.to,
          asOf: period.asOf,
          history,
        }),
      })
      const json = (await res.json()) as AskResponse
      if (!res.ok) throw new Error(json.error ?? "Failed to answer")
      return { turnId, answer: json }
    },
    onSuccess: ({ turnId, answer }) => {
      const shouldNarrate = answer.answerable && (answer.rows?.length ?? 0) > 0
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, answer, narrating: shouldNarrate } : t)),
      )
      if (shouldNarrate) void narrate(turnId, answer)
    },
    onError: (err, { turnId }) => {
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: err.message } : t)))
    },
  })

  const ask = useCallback(
    (q: string) => {
      const trimmed = q.trim()
      if (!trimmed || mutation.isPending) return
      const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          question: trimmed,
          askedAsRole: persona,
          askedAsLabel: selected?.personaLabel ?? persona,
          periodLabel: period.label,
          answer: null,
          error: null,
          narration: null,
          narrating: false,
        },
      ])
      setQuestion("")
      mutation.mutate({ turnId, q: trimmed })
    },
    [mutation, persona, selected?.personaLabel, period.label],
  )

  const lastAnswered = [...turns].reverse().find((t) => t.answer?.answerable)

  return (
    <div className="space-y-5">
      {/* Context applies to the next turn; each completed turn retains its own context. */}
      <section className="u-card overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-border bg-secondary/35 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-[color-mix(in_oklab,var(--brand-primary)_15%,transparent)] text-[var(--link)]">
              <BotMessageSquare className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <div className="u-subhead">Analyst session</div>
              <div className="u-meta">{turns.length === 0 ? "Start with a governed question" : `${turns.length} turn${turns.length === 1 ? "" : "s"} in this session`}</div>
            </div>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => setTurns([])}
              disabled={mutation.isPending}
              title="Clear conversation"
              className="grid h-8 w-8 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Clear conversation</span>
            </button>
          )}
        </div>
        <div className="flex items-end gap-3 flex-wrap px-4 py-4 sm:px-5">
          <label className="flex flex-col gap-1.5">
            <span className="u-label">Query role</span>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              disabled={personas.length <= 1 || mutation.isPending}
              className="h-9 min-w-[210px] rounded-md border border-border bg-background px-2.5 text-sm shadow-sm"
            >
              {personas.map((p) => (
                <option key={p.roleName} value={p.roleName}>
                  {p.personaLabel}
                </option>
              ))}
            </select>
          </label>
          <div className="u-meta max-w-xl pb-1.5">
            <span className="font-medium text-foreground">{metricCount} governed metrics</span> · {selected?.focus ?? "Governed analytics"} · {selected?.rowScope ?? "row scope unknown"}
          </div>
        </div>
        <div className="border-t border-border px-4 py-2.5 sm:px-5"><span className="u-mono text-muted-foreground">Period · {period.label} · {period.description}</span></div>

        {turns.length === 0 && (
          <div className="border-t border-border px-4 py-4 sm:px-5">
            <div className="mb-2 flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-[var(--link)]" aria-hidden /><span className="u-label">Start with a governed question</span></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  onClick={() => ask(starter.question)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:border-[color-mix(in_oklab,var(--brand-primary)_35%,var(--border))] hover:bg-secondary/60"
                >
                  <span className="block text-xs font-medium text-foreground">{starter.label}</span>
                  <span className="mt-0.5 block truncate u-meta">{starter.question}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Transcript */}
      {turns.map((turn) => (
        <article key={turn.id} className="space-y-3">
          {/* The question, with the persona and period THAT TURN ran under. */}
          <div className="flex justify-end">
            <div className="max-w-[88%] rounded-xl rounded-br-sm border border-border bg-secondary/70 px-4 py-3 space-y-1 shadow-sm sm:max-w-[78%]">
              <p className="text-sm leading-relaxed">{turn.question}</p>
              <p className="u-mono text-muted-foreground">
                as {turn.askedAsLabel} · {turn.periodLabel}
              </p>
            </div>
          </div>

          {turn.error && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border u-chip-bad p-3">
              <span className="u-body">{turn.error}</span>
              <button type="button" onClick={() => ask(turn.question)} disabled={mutation.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-current/30 px-2.5 py-1 text-xs font-medium hover:bg-current/10 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" aria-hidden />Retry</button>
            </div>
          )}

          {!turn.answer && !turn.error && (
            <div aria-live="polite" className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              Resolving against the governed registry…
            </div>
          )}

          {/* Refusal */}
          {turn.answer && !turn.answer.answerable && (
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/[0.06] p-4 space-y-3">
              <div className="text-sm font-semibold u-warn">No governed match</div>
              <p className="u-body text-muted-foreground">{turn.answer.reason}</p>
              {turn.answer.suggestions && turn.answer.suggestions.length > 0 && (
                <div className="pt-1">
                  <div className="u-label mb-1.5">Try instead</div>
                  <div className="flex flex-wrap gap-1.5">
                    {turn.answer.suggestions.map((s) => (
                      <button key={s} onClick={() => ask(`What is our ${s}?`)}>
                        <Tag>{s}</Tag>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Answer */}
          {turn.answer?.answerable && <Answer turn={turn} answer={turn.answer} period={period} />}
        </article>
      ))}

      {/* Follow-ups, shown once there is something to follow up on. */}
      {lastAnswered && !mutation.isPending && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3">
          <div className="u-label mb-2">Continue the analysis</div>
          <div className="flex flex-wrap gap-1.5">
          {FOLLOW_UPS.map((f) => (
            <button
              key={f}
              onClick={() => ask(f)}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {f}
            </button>
          ))}
          </div>
        </div>
      )}

      <div ref={endRef} />

      {/* Composer, pinned below the transcript. */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask(question)
        }}
        className="sticky bottom-3 z-20 flex items-end gap-2 rounded-xl border border-border bg-card/95 p-2 shadow-[var(--shadow-raised)] backdrop-blur"
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              ask(question)
            }
          }}
          placeholder={
            turns.length === 0
              ? "Ask a cross-domain supply chain question…"
              : "Ask a follow-up — “and by region?” keeps the metric"
          }
          rows={1}
          className="min-h-10 max-h-28 flex-1 resize-y rounded-lg border border-transparent bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)] focus:bg-background"
        />
        <Button type="submit" size="icon" title="Send question" disabled={mutation.isPending || !question.trim()}>
          <ArrowUp className="h-4 w-4" aria-hidden />
          <span className="sr-only">{mutation.isPending ? "Resolving" : "Send question"}</span>
        </Button>
      </form>
      <p className="-mt-3 text-center u-meta">Enter to send · Shift + Enter for a new line</p>
    </div>
  )
}

/**
 * One answered turn.
 *
 * Kept as its own component so the transcript's state handling stays legible, and so provenance can
 * be collapsed per turn without every turn's disclosure state living in the parent.
 */
function Answer({
  turn,
  answer,
  period,
}: {
  turn: Turn
  answer: AskResponse
  period: { id: string; from: string | null; to: string | null; asOf: string }
}) {
  const metrics = answer.metrics ?? []
  const rows = answer.rows ?? []
  const isScalar = !answer.dimensionColumn && rows.length === 1
  const chartRows = answer.chartRows?.length ? answer.chartRows : rows

  return (
    <section className="u-card space-y-4 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div><div className="u-label text-[var(--link)]">Governed answer</div><p className="mt-0.5 u-meta">{answer.reason}</p></div>
        <span className="u-mono text-muted-foreground">{answer.rowCount ?? rows.length} row{(answer.rowCount ?? rows.length) === 1 ? "" : "s"}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Tag title="The Snowflake role the query actually ran under">executed as {answer.executedAs}</Tag>
        {answer.period && <Tag title={answer.period.description}>{answer.period.label}</Tag>}
        {answer.snapshotDate && (
          <Tag title="Balance metrics are read at a single snapshot, never summed across months">
            snapshot {String(answer.snapshotDate).slice(0, 10)}
          </Tag>
        )}
        {answer.personaError && (
          <span className="u-warn">
            Could not run as {answer.persona?.roleName}: {answer.personaError}. The figures below were
            produced with the application&apos;s own role, so they are not persona-scoped.
          </span>
        )}
      </div>

      {/* The narration. Shown under the provenance chips and above the figures it describes. */}
      {turn.narrating && (
        <p className="u-meta italic">Summarising governed result…</p>
      )}
      {turn.narration?.narration && (
        <div className="space-y-1.5">
          <p className="u-body leading-relaxed">{turn.narration.narration}</p>
          {turn.narration.narrationSource === "template" && (
            <p className="text-[11px] text-muted-foreground">
              {turn.narration.note ??
                "Generated directly from the governed rows rather than by the narrator."}
              {turn.narration.rejectedNumbers && turn.narration.rejectedNumbers.length > 0 && (
                <>
                  {" "}
                  Discarded {turn.narration.rejectedNumbers.length === 1 ? "figure" : "figures"}:{" "}
                  <span className="font-mono">{turn.narration.rejectedNumbers.join(", ")}</span>.
                </>
              )}
            </p>
          )}
        </div>
      )}

      {isScalar && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((m) => {
            /**
             * Two pills, because they answer two different questions.
             *
             * The drift pill says whether the metric AGREES WITH ITS OWN DEFINITION across every
             * semantic view that serves it. Shown alone, its "PASS" was read as "this number is
             * healthy" — sitting directly above 87.17% against a 90% target, which it misses. Both
             * states are legitimate and common: a business can miss a goal while measuring it
             * perfectly. Labelling the drift pill and adding an explicit target pill makes each
             * claim say what it actually means.
             */
            const assessment = assessTarget({
              value: Number(rows[0][m.column]),
              target: m.target,
              warnThreshold: m.warnThreshold,
              failThreshold: m.failThreshold,
              direction: m.direction,
            })
            return (
              <div key={m.metricId} className="relative overflow-hidden rounded-lg border border-border bg-background p-4 space-y-1.5">
                <div className="absolute inset-x-0 top-0 h-0.5 bg-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]" />
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium">{m.businessName}</span>
                  <StatusPill status={m.driftStatus} label={m.driftStatus ? `drift ${m.driftStatus}` : undefined} />
                </div>
                <div className="text-3xl font-semibold tabular-nums">
                  {formatMetricValue(rows[0][m.column], m.unit)}
                </div>
                {m.target === null ? (
                  <p className="text-[11px] text-muted-foreground">
                    no governed target — this metric scales with volume, so its level alone is not good or bad
                  </p>
                ) : (
                  <p className={`text-[11px] ${ragTextClass(assessment.state)}`}>
                    target {formatMetricValue(m.target, m.unit)} · {assessment.label}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground leading-relaxed">{m.definition}</p>
                <DrilldownButton
                  metricId={m.metricId}
                  period={period.id}
                  from={period.from ?? undefined}
                  to={period.to ?? undefined}
                  asOf={period.asOf}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* Chart. Type, ordering and panel split were all decided on the server. */}
      {answer.chart && <AskCharts spec={answer.chart} rows={chartRows} />}

      {!isScalar && rows.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Table · {answer.rowCount} row{answer.rowCount === 1 ? "" : "s"}
          </summary>
          <div className="overflow-auto max-h-[22rem] border-t border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/80 backdrop-blur sticky top-0 z-10">
                <tr className="text-left">
                  {answer.dimensionColumn && <th className="px-3 py-2 font-medium">{answer.dimensionColumn}</th>}
                  {metrics.map((m) => (
                    <th key={m.metricId} className="px-3 py-2 font-medium text-right whitespace-nowrap">
                      {m.businessName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {answer.dimensionColumn && (
                      <td className="px-3 py-2 font-medium whitespace-nowrap">
                        {String(row[answer.dimensionColumn] ?? "—")}
                      </td>
                    )}
                    {metrics.map((m) => (
                      <td key={m.metricId} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {formatMetricValue(row[m.column], m.unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Governed prediction outlook, when the registry has one for these metrics. */}
      {answer.predictions && answer.predictions.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" />
              <span className="text-sm font-semibold">Governed Forward Outlook (as_of_scope: PREDICTED)</span>
              <Tag>{answer.predictions[0]?.method}</Tag>
              {answer.predictions[0]?.backtestAccuracy !== null && (
                <span className="text-xs text-muted-foreground">
                  Accuracy on held-out data:{" "}
                  {(Number(answer.predictions[0]?.backtestAccuracy) * 100).toFixed(1)}%
                </span>
              )}
            </div>
            <Link href="/outlook" className="text-xs text-[var(--link)] hover:text-foreground">
              Interactive simulation &rsaquo;
            </Link>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {answer.predictions.map((p) => (
              <div
                key={`${p.metricId}-${p.grainValue}-${p.horizonPeriod}`}
                className="p-3 rounded-md bg-secondary/40 border border-border/70 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between font-medium">
                  <span>{p.grainValue ?? p.horizonPeriod}</span>
                  <span className="font-mono">{formatMetricValue(p.predictedValue, p.unit)}</span>
                </div>
                {p.breachProbability !== null && (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Breach probability</span>
                    <span className="font-mono font-medium">
                      {(p.breachProbability * 100).toFixed(1)}% ({p.verdict})
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground italic">{answer.predictions[0]?.basis}</p>
        </div>
      )}

      {/*
        Provenance, collapsed. Still one click away on every turn: the claim this project makes is
        that any number can be traced to a governed definition and the SQL that produced it, and a
        transcript that dropped that for brevity would be making a weaker claim.
      */}
      <details className="rounded-lg border border-border bg-muted/40">
        <summary className="cursor-pointer px-4 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          Provenance · {metrics.length} metric{metrics.length === 1 ? "" : "s"} · generated SQL
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-3">
          {!isScalar && metrics.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {metrics.map((m) => (
                <DrilldownButton
                  key={m.metricId}
                  metricId={m.metricId}
                  label={`Rows behind ${m.businessName}`}
                  period={period.id}
                  from={period.from ?? undefined}
                  to={period.to ?? undefined}
                  asOf={period.asOf}
                />
              ))}
            </div>
          )}
          <div className="space-y-2">
            {metrics.map((m) => (
              <div key={m.metricId} className="text-[11px] font-mono leading-relaxed">
                <span className="text-foreground/90">
                  Source: {answer.semanticView?.split(".").pop()}.{m.reference}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  | grain: {m.grain} | owner: {m.ownerRole} | also served by:{" "}
                  {m.servedBy.filter((v) => v !== "SC_ONTOLOGY_360").join(", ") || "this view only"}
                </span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Generated SQL ({answer.rowCount} row{answer.rowCount === 1 ? "" : "s"})
            </div>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/90">
              {answer.sql}
            </pre>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Resolver rationale: <span className="italic">{answer.reason}</span>
          </div>
        </div>
      </details>
    </section>
  )
}
