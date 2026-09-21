/**
 * Narration for an answer that has already been computed.
 *
 * POST /api/ask/narrate  { question, metrics[], rows[], dimensionColumn, period, persona }
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE ENDPOINT
 *
 * Two reasons, and the second is the one that actually forced it.
 *
 *   1. The number must exist before the prose does. /api/ask resolves the question against the
 *      registry and executes governed SQL; this route is handed the result and may only describe
 *      it. Splitting them makes it structurally impossible for narration to influence which metric
 *      was chosen or what it evaluated to.
 *   2. LATENCY. lib/env.ts documents a 10 second serverless function limit on the deployment
 *      target. Resolution is ~5s and narration is ~3s; run sequentially in one handler they exceed
 *      the budget and the user gets a timeout instead of an answer. As two calls the chat renders
 *      the number and the chart as soon as resolution returns, then fills the prose in behind it,
 *      and neither call is near the limit. The visible result is also better: the governed number
 *      appears first, and the commentary arrives second.
 *
 * ---------------------------------------------------------------------------------------------
 * THE GUARDRAIL: NO NUMBER THE PAYLOAD DOES NOT CONTAIN
 *
 * A language model asked to summarise 12 rows will, occasionally, produce a fluent sentence
 * containing a figure that is not in those rows — a rounded total it computed itself, a percentage
 * gap it inferred, a plausible-looking average. In a governed metrics product that is the single
 * worst failure available: the prose sits directly beneath a number carrying full provenance, and
 * inherits its credibility.
 *
 * So every numeric token in the generated prose is checked against the numbers actually present in
 * the payload, in every form the narrator might reasonably render them (raw, rounded, as a
 * percentage, abbreviated to millions or billions). Prose containing an unverifiable figure is
 * DISCARDED ENTIRELY and replaced by a deterministic template built from the same rows.
 *
 * Rejecting the whole response rather than patching it is deliberate. A model that invented one
 * figure has demonstrated it was willing to compute, and the remaining sentences are no longer
 * trustworthy just because their numbers happen to check out.
 *
 * The fallback is not an error state. It is a correct, if plainer, answer — which is why the
 * response reports `narrationSource` so the UI can be honest about which one the reader is seeing.
 */

import { querySnowflake } from "@/lib/sc"
import { RESOLVER_MODEL } from "@/lib/constants"
import { formatMetricValue } from "@/lib/format"

export const dynamic = "force-dynamic"

/** A single Cortex call over a small payload; ~3s observed. */
export const maxDuration = 30

interface NarrateMetric {
  metricId: string
  businessName: string
  column: string
  unit: string | null
  target: number | null
  direction: string | null
  definition?: string | null
  asOfScope?: string | null
}

/** Rows beyond this add nothing to a four-sentence summary and cost latency. */
const MAX_ROWS_TO_NARRATE = 24

/**
 * Every numeric rendering of `n` a narrator might plausibly produce.
 *
 * Deliberately generous. The guardrail's job is to catch a FABRICATED figure, not to police
 * rounding, so a value of 0.885475 legitimately appears as 0.885475, 0.89, 88.5%, 88.55% or 89%.
 * Being strict here would reject correct prose constantly, the fallback would fire on almost every
 * turn, and the feature would be useless — which is a worse outcome than tolerating a rounding
 * variant, because it trains the reader to ignore the distinction entirely.
 */
function allowedRenderings(n: number): Set<string> {
  const out = new Set<string>()
  const add = (s: string) => {
    const cleaned = s.replace(/,/g, "")
    if (cleaned && cleaned !== "-") out.add(cleaned)
  }

  const abs = Math.abs(n)
  add(String(n))
  add(String(abs))
  for (const d of [0, 1, 2, 3, 4, 6]) {
    add(abs.toFixed(d))
    // Trailing-zero-stripped form: 88.50 also reads as 88.5.
    add(String(Number(abs.toFixed(d))))
  }

  // Percentage forms, for ratio metrics and for any derived share.
  const pct = abs * 100
  for (const d of [0, 1, 2, 3]) {
    add(pct.toFixed(d))
    add(String(Number(pct.toFixed(d))))
  }

  // Abbreviated magnitudes, how large dollar figures are normally written.
  for (const [div, _label] of [
    [1e3, "k"],
    [1e6, "M"],
    [1e9, "B"],
  ] as const) {
    if (abs >= div) {
      for (const d of [0, 1, 2]) {
        add((abs / div).toFixed(d))
        add(String(Number((abs / div).toFixed(d))))
      }
    }
  }

  return out
}

/**
 * Numeric tokens in the prose that the payload cannot account for.
 *
 * Ordinals, small counts and years are ignored: "the top 3 families", "all 12 regions" and "2026"
 * are structural, not claims about a metric, and treating them as fabrication would make the
 * guardrail fire on well-formed sentences.
 */
export function findUnverifiableNumbers(prose: string, allowed: Set<string>): string[] {
  const tokens = prose.match(/\d[\d,]*(?:\.\d+)?/g) ?? []
  const bad: string[] = []

  for (const raw of tokens) {
    const cleaned = raw.replace(/,/g, "")
    if (allowed.has(cleaned)) continue

    const n = Number(cleaned)
    if (!Number.isFinite(n)) continue
    // A small integer is a count or an ordinal, not a metric value.
    if (Number.isInteger(n) && Math.abs(n) <= 100) continue
    // A four-digit year.
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue

    bad.push(raw)
  }
  return bad
}

/**
 * Deterministic summary, used when the model is unavailable or its prose failed the guardrail.
 *
 * Built only from values present in the payload, so it cannot fail the same check. Plainer than the
 * generated version and never wrong.
 */
export function templateNarration(input: {
  metrics: NarrateMetric[]
  rows: Record<string, any>[]
  dimensionColumn: string | null
  periodLabel: string
}): string {
  const { metrics, rows, dimensionColumn, periodLabel } = input
  if (metrics.length === 0 || rows.length === 0) return "No governed rows were returned for that question."

  const sentences: string[] = []

  if (!dimensionColumn) {
    const parts = metrics.map((m) => {
      const value = formatMetricValue(rows[0]?.[m.column], m.unit)
      if (m.target === null) return `${m.businessName} is ${value}`
      const target = formatMetricValue(m.target, m.unit)
      const v = Number(rows[0]?.[m.column])
      if (!Number.isFinite(v)) return `${m.businessName} is ${value} against a target of ${target}`
      const meets = m.direction === "LOWER" ? v <= m.target : v >= m.target
      return `${m.businessName} is ${value} against a target of ${target}, which it ${meets ? "meets" : "misses"}`
    })
    sentences.push(`For ${periodLabel}, ${parts.join("; ")}.`)
  } else {
    const primary = metrics[0]
    const ranked = rows
      .filter((r) => Number.isFinite(Number(r[primary.column])))
      .sort((a, b) => Number(b[primary.column]) - Number(a[primary.column]))

    if (ranked.length === 0) {
      sentences.push(`No ${primary.businessName} values were returned for ${periodLabel}.`)
    } else {
      const top = ranked[0]
      const bottom = ranked[ranked.length - 1]
      sentences.push(
        `For ${periodLabel}, ${primary.businessName} ranges from ${formatMetricValue(bottom[primary.column], primary.unit)} (${bottom[dimensionColumn]}) to ${formatMetricValue(top[primary.column], primary.unit)} (${top[dimensionColumn]}) across ${rows.length} ${rows.length === 1 ? "category" : "categories"}.`,
      )
      if (primary.target !== null) {
        const missing = ranked.filter((r) =>
          primary.direction === "LOWER"
            ? Number(r[primary.column]) > (primary.target as number)
            : Number(r[primary.column]) < (primary.target as number),
        )
        sentences.push(
          missing.length === 0
            ? `Every category meets the governed target of ${formatMetricValue(primary.target, primary.unit)}.`
            : `${missing.length} of ${ranked.length} miss the governed target of ${formatMetricValue(primary.target, primary.unit)}.`,
        )
      }
    }
  }

  return sentences.join(" ")
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      question?: string
      metrics?: NarrateMetric[]
      rows?: Record<string, any>[]
      dimensionColumn?: string | null
      periodLabel?: string
      personaLabel?: string | null
      snapshotDate?: string | null
    }

    const question = (body.question ?? "").trim().slice(0, 500)
    const metrics = Array.isArray(body.metrics) ? body.metrics.slice(0, 4) : []
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS_TO_NARRATE) : []
    const dimensionColumn = body.dimensionColumn ?? null
    const periodLabel = (body.periodLabel ?? "the reporting period").slice(0, 120)

    if (metrics.length === 0 || rows.length === 0) {
      return Response.json({ error: "metrics and rows are required" }, { status: 400 })
    }

    const fallback = templateNarration({ metrics, rows, dimensionColumn, periodLabel })

    /**
     * Everything the prose is allowed to say, numerically.
     *
     * Collected from the metric values, their governed targets and thresholds, and the row count —
     * so "3 of 8 miss target" passes, because both 3 and 8 are derivable from the payload.
     */
    const allowed = new Set<string>()
    const permit = (v: unknown) => {
      const n = Number(v)
      if (Number.isFinite(n)) for (const s of allowedRenderings(n)) allowed.add(s)
    }
    permit(rows.length)
    for (const m of metrics) {
      permit(m.target)
      for (const r of rows) permit(r[m.column])
    }

    // Render the payload for the prompt with the same formatter the UI uses, so the model is shown
    // "88.55%" rather than "0.885475" and is not tempted to convert it itself.
    const metricLines = metrics
      .map((m) => {
        const t = m.target === null ? "no governed target" : `target ${formatMetricValue(m.target, m.unit)}`
        const dir = m.direction === "LOWER" ? "lower is better" : m.direction === "HIGHER" ? "higher is better" : "no direction"
        return `- ${m.businessName} (${m.metricId}): ${t}, ${dir}${m.asOfScope ? `, ${m.asOfScope} scope` : ""}`
      })
      .join("\n")

    const dataLines = rows
      .map((r) => {
        const label = dimensionColumn ? `${r[dimensionColumn]}: ` : ""
        const vals = metrics.map((m) => `${m.businessName} ${formatMetricValue(r[m.column], m.unit)}`).join(", ")
        return `- ${label}${vals}`
      })
      .join("\n")

    const prompt = `You are writing a short commentary on supply-chain figures that have ALREADY been computed from a governed metric registry.

QUESTION ASKED: ${question || "(none given)"}
REPORTING PERIOD: ${periodLabel}${body.personaLabel ? `\nAUDIENCE: ${body.personaLabel}` : ""}${body.snapshotDate ? `\nSNAPSHOT DATE: ${body.snapshotDate}` : ""}

METRICS:
${metricLines}

RESULT:
${dataLines}

Write 2 to 4 sentences of plain commentary.

ABSOLUTE RULES:
- Use ONLY the numbers shown above. Do NOT compute, total, average, or infer any figure that is not written above. Do not calculate gaps or differences.
- Quote numbers exactly as they are written above, including the % or $ symbol.
- Say what the figures show and, where a target is given, whether it is met. Name the notable categories.
- ${dimensionColumn ? "Point out the extremes and any obvious grouping." : "This is a single overall figure; do not invent a breakdown."}
- Do not recommend actions. Do not speculate about causes you cannot see in the data.
- No preamble, no headings, no bullet points. Plain sentences only.`

    let prose = ""
    try {
      const out = await querySnowflake(`SELECT AI_COMPLETE(?, ?) AS NARRATION`, {
        binds: [RESOLVER_MODEL, prompt],
      })
      prose = String(out[0]?.NARRATION ?? "").trim()
    } catch (e) {
      console.error(new Date().toISOString(), "[narrate] model call failed", e)
      return Response.json({
        narration: fallback,
        narrationSource: "template",
        rejectedNumbers: [],
        note: "The narrator was unavailable, so this summary is generated directly from the governed rows.",
      })
    }

    // Strip any markdown the model added despite being asked not to.
    prose = prose.replace(/^[#>*\-\s]+/gm, "").replace(/\*\*/g, "").trim()

    if (!prose) {
      return Response.json({
        narration: fallback,
        narrationSource: "template",
        rejectedNumbers: [],
        note: "The narrator returned nothing, so this summary is generated directly from the governed rows.",
      })
    }

    const bad = findUnverifiableNumbers(prose, allowed)
    if (bad.length > 0) {
      console.warn(
        new Date().toISOString(),
        "[narrate] discarded prose containing unverifiable figures",
        bad.slice(0, 8),
      )
      return Response.json({
        narration: fallback,
        narrationSource: "template",
        rejectedNumbers: bad.slice(0, 8),
        note: `The generated summary contained ${bad.length === 1 ? "a figure" : "figures"} not present in the governed result, so it was discarded and replaced with one built directly from the rows.`,
      })
    }

    return Response.json({
      narration: prose,
      narrationSource: "model",
      rejectedNumbers: [],
      note: null,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[narrate] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to narrate the answer" },
      { status: 500 },
    )
  }
}
