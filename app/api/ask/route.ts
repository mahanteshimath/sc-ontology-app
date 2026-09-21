/**
 * Governed conversational analytics.
 *
 * POST /api/ask  { question: string, persona?: string, period?: string, from?, to?, asOf? }
 *
 * The resolver is deliberately constrained: an LLM chooses only from the metrics and dimensions
 * that are registered in GOVERNANCE.METRIC_DEFINITION and present in the semantic view. It never
 * writes SQL. The SQL is assembled from the registry, so the answer is reproducible and every
 * number carries provenance back to a governed definition.
 *
 * If the question cannot be mapped onto a registered metric, the route refuses and names the
 * closest governed alternatives rather than inventing a definition.
 *
 * THE PERSONA IS ENFORCED, NOT COSMETIC.
 * Previously this route accepted a `persona` and ignored it, while the UI claimed the persona
 * "changes the phrasing, never the definition" — it changed nothing at all. Now the persona does
 * two things, both of which are real:
 *   1. It narrows the offered metric catalogue to the semantic views that role is granted
 *      (GOVERNANCE.PERSONA_VIEW_ACCESS), so a persona cannot be answered from a view it has no
 *      access to.
 *   2. The final query executes under that role with secondary roles disabled, so row access
 *      policies apply. The EU-scoped logistics persona therefore sees fewer rows than its
 *      unrestricted counterpart while computing the metric from the identical definition — which
 *      is the distinction the whole project rests on.
 * Where the role cannot be assumed, the route says so instead of silently answering as the
 * service identity.
 *
 * ---------------------------------------------------------------------------------------------
 * MULTI-TURN, WITHOUT LETTING THE CONVERSATION BECOME THE AUTHORITY
 *
 * `history` carries the last few turns so a follow-up like "and by region?" or "what about
 * inventory instead" resolves against what was just asked. It is used ONLY to interpret the new
 * question. Every metric id and dimension in the history is re-validated against the registry and
 * the persona's grants on each turn before it is shown to the resolver, and the resolver's answer
 * is re-validated again afterwards.
 *
 * That double validation is the point. A conversation is client-supplied state, so treating a
 * remembered metric id as already-approved would let a caller widen their own access by editing a
 * previous turn — and a persona whose grants changed between turns would keep answering from a view
 * it is no longer allowed to read.
 *
 * WHY THIS ROUTE DOES NOT CALL THE CORTEX AGENT
 * SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT exists (sql/10_agent.sql) and is the better
 * tool for open-ended exploration. It is deliberately not on this path:
 *   - An agent resolves permissions from the user's DEFAULT role, not the session role, so the
 *     per-request USE ROLE guarantee above would not hold and SC_LOGISTICS_EU would silently
 *     receive all-region numbers.
 *   - A full agent run routinely exceeds the 10s serverless limit documented in lib/env.ts.
 *   - The claim that the model never writes SQL would stop being true.
 *
 * CHART SELECTION IS NOT THE MODEL'S JOB
 * lib/chart.ts derives the visualisation from the result shape, so the same question always renders
 * the same way, and metrics with different units are split into separate panels rather than being
 * plotted on a shared axis they cannot honestly share.
 */

import {
  querySnowflake,
  getMetricRegistry,
  getMetricOutlook,
  querySemanticView,
  semanticViewSql,
  getPersonas,
  getLatestSnapshotDate,
  num,
  type SemanticFilter,
  type MetricOutlook,
} from "@/lib/sc"
import { runRowsAsRole } from "@/lib/persona"
import { after } from "next/server"
import { resolvePeriod, periodFilters, snapshotFilters } from "@/lib/period"
import { currentSession } from "@/lib/session"
import { RESOLVER_MODEL, ONTOLOGY_VIEW } from "@/lib/constants"
import { buildChart, type ChartSpec } from "@/lib/chart"

export const dynamic = "force-dynamic"

/** A Cortex model call plus a per-role semantic-view query; ~8s observed. */
export const maxDuration = 90

const VIEW = "SC_ONTOLOGY_360"

interface Resolution {
  answerable: boolean
  metricIds: string[]
  dimension: string | null
  reason: string
}

/** One prior turn, as replayed by the client. Never trusted; re-validated every request. */
interface HistoryTurn {
  question: string
  metricIds: string[]
  dimension: string | null
}

/**
 * Enough context to resolve a follow-up, and no more.
 *
 * Six turns is a deliberate cap rather than a token-budget guess. The only thing history is for is
 * resolving a reference in the new question, and a reference that reaches back further than six
 * turns is not a reference any more — it is a new question the user believes they already asked.
 * Keeping the window short also keeps the resolver prompt small enough to stay inside the latency
 * budget the chat UI depends on.
 */
const MAX_HISTORY_TURNS = 6

/**
 * Record the turn for the improvement loop.
 *
 * GOVERNANCE.AGENT_IMPROVEMENT_CANDIDATE reads this log and ranks UNSTABLE_RESOLUTION worst — the
 * same question answered two different ways. That signal only exists if refusals are logged too,
 * so every exit path writes a row, not just the successful ones.
 *
 * RUN AFTER THE RESPONSE, NOT BEFORE IT. Awaiting the INSERT put a full Snowflake round trip on the
 * critical path of every answer, including refusals, for no benefit the user can see. `after()`
 * defers it until the response has been sent, which is what it exists for.
 *
 * Failing to log must never fail the answer: this is observability, and an outage in it is not a
 * reason to deny a governed number to a user. That has to cover the SCHEDULING of the log as well as
 * the write, because `after()` throws `"after was called outside a request scope"` when there is no
 * request context — which is exactly the case under vitest, where it turned every answered turn into
 * a 500 that looked like a resolver bug. So the deferral is attempted and, if it is unavailable,
 * the write simply runs unawaited instead.
 *
 * Both paths swallow their own errors and report to the server console, so a silently broken
 * feedback loop is still discoverable.
 */
function logTurn(entry: {
  personaRole: string | null
  question: string
  metricIds: string[]
  refused: boolean
  refusalReason: string | null
  latencyMs: number
}): void {
  const write = async () => {
    try {
      await querySnowflake(
        `INSERT INTO SUPPLY_CHAIN.GOVERNANCE.AGENT_QUESTION_LOG
         (asked_at, source, persona_role, question, resolved_metric_ids, semantic_view,
          refused, refusal_reason, latency_ms, user_corrected, correction_note)
       SELECT CURRENT_TIMESTAMP(), 'app', ?, ?, ?, ?, ?, ?, ?, FALSE, NULL`,
        {
          binds: [
            entry.personaRole,
            entry.question.slice(0, 500),
            entry.metricIds.length ? entry.metricIds.join("|") : null,
            VIEW,
            entry.refused,
            entry.refusalReason ? entry.refusalReason.slice(0, 500) : null,
            entry.latencyMs,
          ],
        },
      )
    } catch (e) {
      console.error(new Date().toISOString(), "[ask] could not log question", e)
    }
  }

  try {
    after(write)
  } catch {
    void write()
  }
}

/** Dimensions available on the cross-domain ontology view, with their entity prefix. */
async function getOntologyDimensions(): Promise<{ ref: string; comment: string | null }[]> {
  const rows = await querySnowflake(
    `SELECT LOWER(table_name) || '.' || LOWER(name) AS ref, comment
       FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS
      WHERE semantic_view_name = ?
      ORDER BY 1`,
    { binds: [VIEW] },
  )
  return rows.map((r) => ({ ref: r.REF as string, comment: r.COMMENT ? String(r.COMMENT) : null }))
}

/**
 * Combine the REALIZED and SNAPSHOT result sets into one row set.
 *
 * A question that mixes an event metric with a balance is executed as two queries, because a
 * snapshot pinned to one date and a period-spanning event metric cannot share a WHERE clause without
 * one of them being computed on the other's terms. They are stitched back together here on the
 * dimension value so the caller sees a single table.
 *
 * Shared by the persona path and the owner's-rights path. They previously had separate copies and
 * only one of them handled the dimensional case, which is how the persona path came to silently
 * drop breakdowns.
 */
function mergeScopeGroups(parts: Record<string, any>[][], dims: string[]): Record<string, any>[] {
  if (dims.length === 0) {
    return [Object.assign({}, ...parts.map((p) => p[0] ?? {}))]
  }
  const dimCol = dims[0].split(".")[1].toUpperCase()
  const merged = new Map<string, Record<string, any>>()
  for (const p of parts) {
    for (const r of p) {
      const k = String(r[dimCol] ?? "—")
      merged.set(k, { ...(merged.get(k) ?? {}), ...r })
    }
  }
  return [...merged.values()]
}

function extractJson(text: string): Resolution | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<Resolution>
    return {
      answerable: Boolean(parsed.answerable),
      metricIds: Array.isArray(parsed.metricIds) ? parsed.metricIds.map(String) : [],
      dimension: parsed.dimension ? String(parsed.dimension) : null,
      reason: parsed.reason ? String(parsed.reason) : "",
    }
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      question?: string
      persona?: string
      period?: string
      from?: string
      to?: string
      asOf?: string
      history?: HistoryTurn[]
    }
    const startedAt = Date.now()
    const question = (body.question ?? "").trim()
    if (!question) return Response.json({ error: "A question is required" }, { status: 400 })
    if (question.length > 500) return Response.json({ error: "Question is too long" }, { status: 400 })

    const rawHistory = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : []

    const period = resolvePeriod({
      id: body.period ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
      asOf: body.asOf ?? null,
    })

    const [registry, dimensions, personas, accessRows, allOutlooks] = await Promise.all([
      getMetricRegistry(),
      getOntologyDimensions(),
      getPersonas(),
      querySnowflake(`SELECT role_name, semantic_view FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS`),
      getMetricOutlook(),
    ])

    // Validate the requested persona against the catalogue. An unrecognised role is rejected
    // rather than defaulted, so a typo cannot silently widen access.
    const requested = body.persona ? personas.find((p) => p.roleName === body.persona) : null
    if (body.persona && !requested) {
      return Response.json({ error: `"${body.persona}" is not a registered persona.` }, { status: 400 })
    }

    /**
     * The signed-in account decides the persona; the request body cannot override it.
     *
     * The persona controls which Snowflake role the query runs as, so accepting it from the client
     * would let anyone escalate to any persona by editing one JSON field. When a session exists its
     * role wins, and a mismatched request is refused rather than quietly downgraded so the caller
     * is not misled about what ran.
     */
    const session = await currentSession()
    if (session && requested && requested.roleName !== session.personaRole) {
      return Response.json(
        {
          error: `Signed in as ${session.username}, which acts as ${session.personaRole}. Asking as ${requested.roleName} is not permitted.`,
        },
        { status: 403 },
      )
    }
    const persona = session
      ? (personas.find((p) => p.roleName === session.personaRole) ?? null)
      : requested

    const grantedViews = new Set(
      accessRows.filter((r) => r.ROLE_NAME === persona?.roleName).map((r) => String(r.SEMANTIC_VIEW)),
    )

    // Only metrics the cross-domain view can serve are offered — and, when a persona is selected,
    // only if that persona is granted the view.
    const personaCanUseView = !persona || grantedViews.has(VIEW)
    const available = personaCanUseView
      ? registry
          .map((m) => {
            const binding = m.bindings.find((b) => b.semanticView === VIEW)
            return binding ? { metric: m, ref: binding.metricReference } : null
          })
          .filter((x): x is { metric: (typeof registry)[number]; ref: string } => x !== null)
      : []

    if (available.length === 0) {
      const reason = persona
        ? `${persona.personaLabel} is not granted ${VIEW}, so no cross-domain metric can be resolved for that persona.`
        : "No governed metric is available on the cross-domain ontology view."
      logTurn({
        personaRole: persona?.roleName ?? null,
        question,
        metricIds: [],
        refused: true,
        refusalReason: reason,
        latencyMs: Date.now() - startedAt,
      })
      return Response.json({ answerable: false, reason, suggestions: [] })
    }

    const catalogue = available
      .map(
        (a) =>
          `- ${a.metric.metricId}: ${a.metric.businessName}. ${a.metric.definition} (unit: ${a.metric.unit})`,
      )
      .join("\n")
    const dimCatalogue = dimensions.map((d) => `- ${d.ref}${d.comment ? `: ${d.comment}` : ""}`).join("\n")

    /**
     * Re-validate the replayed conversation before it reaches the prompt.
     *
     * Dropping ids that are no longer resolvable rather than rejecting the request is deliberate:
     * the common cause is a persona switch mid-conversation, and the useful behaviour there is to
     * carry forward whatever the new persona can still see and resolve the rest from the question
     * itself. A caller who tampers with a previous turn gains nothing, because anything not in
     * `available` for the CURRENT persona is discarded here.
     */
    const history = rawHistory
      .filter((t) => t && typeof t.question === "string" && t.question.trim().length > 0)
      .map((t) => ({
        question: t.question.trim().slice(0, 500),
        metricIds: (Array.isArray(t.metricIds) ? t.metricIds : [])
          .map(String)
          .filter((id) => available.some((a) => a.metric.metricId === id)),
        dimension:
          t.dimension && dimensions.some((d) => d.ref === t.dimension) ? String(t.dimension) : null,
      }))
      .filter((t) => t.metricIds.length > 0 || t.dimension !== null)

    const conversationBlock =
      history.length === 0
        ? ""
        : `\nCONVERSATION SO FAR (oldest first). These turns were already answered:\n${history
            .map(
              (t, i) =>
                `${i + 1}. asked: "${t.question}" -> metrics: ${t.metricIds.join(", ") || "none"}; breakdown: ${t.dimension ?? "none"}`,
            )
            .join("\n")}\n
Use the conversation ONLY to interpret references in the new question:
- If the new question changes only the breakdown ("and by region?", "split that by carrier"), KEEP the previous metric ids and change the dimension.
- If it changes only the metric ("what about inventory instead"), KEEP the previous dimension and change the metric ids.
- If it names its own metrics and breakdown, ignore the conversation entirely.
- If it refers to something the conversation never established, do not guess: set answerable to false.
`

    const prompt = `You map a business question onto a governed supply-chain metric catalogue.

GOVERNED METRICS (the ONLY metrics you may use):
${catalogue}

AVAILABLE DIMENSIONS (the ONLY dimensions you may use, at most one):
${dimCatalogue}
${conversationBlock}
QUESTION: ${question}

Rules:
- Choose 1 to 4 metric ids that answer the question. Use the exact metric id strings above.
- Optionally choose ONE dimension to break the answer down by, using the exact dimension reference above. Use null if the question asks for a single overall figure.
- The reporting period is already applied by the application (${period.description}). Do NOT choose a calendar dimension just because the question mentions a time range; choose one only if the question genuinely asks for a breakdown over time.
- Supplier On-Time Delivery is INBOUND (did suppliers meet dates promised to us). On-Time Delivery is OUTBOUND (did we meet dates promised to customers). If the question is genuinely ambiguous between them, set answerable to false and say so.
- Freight Cost is accrued; Freight Invoiced is what carriers billed. They are different metrics.
- If no governed metric answers the question, set answerable to false and explain what is missing.

Reply with ONLY a JSON object:
{"answerable": true|false, "metricIds": ["..."], "dimension": "entity.dimension"|null, "reason": "one sentence"}`

    const llmRows = await querySnowflake(`SELECT AI_COMPLETE(?, ?) AS RESOLUTION`, {
      binds: [RESOLVER_MODEL, prompt],
    })
    const resolution = extractJson(String(llmRows[0]?.RESOLUTION ?? ""))

    if (!resolution) {
      const reason = "The resolver did not return a usable mapping. Please rephrase the question."
      logTurn({
        personaRole: persona?.roleName ?? null,
        question,
        metricIds: [],
        refused: true,
        refusalReason: reason,
        latencyMs: Date.now() - startedAt,
      })
      return Response.json({
        answerable: false,
        reason,
        suggestions: available.slice(0, 6).map((a) => a.metric.businessName),
      })
    }

    // Validate every choice against the registry — the LLM's output is never trusted directly.
    const chosen = resolution.metricIds
      .map((id) => available.find((a) => a.metric.metricId === id))
      .filter((x): x is { metric: (typeof registry)[number]; ref: string } => x !== undefined)

    const validDimension =
      resolution.dimension && dimensions.some((d) => d.ref === resolution.dimension)
        ? resolution.dimension
        : null

    if (!resolution.answerable || chosen.length === 0) {
      const reason =
        resolution.reason ||
        "That metric is not in the governed catalogue, so it cannot be answered from the ontology."
      logTurn({
        personaRole: persona?.roleName ?? null,
        question,
        metricIds: [],
        refused: true,
        refusalReason: reason,
        latencyMs: Date.now() - startedAt,
      })
      return Response.json({
        answerable: false,
        reason,
        suggestions: available.slice(0, 6).map((a) => a.metric.businessName),
      })
    }

    // Scope the query the same way the dashboards do: SNAPSHOT balances pin to one snapshot,
    // event metrics span the period with future-dated rows excluded. A question that mixes the two
    // is split into two queries so neither is computed on the other's terms.
    const realized = chosen.filter((c) => c.metric.asOfScope !== "SNAPSHOT")
    const snapshot = chosen.filter((c) => c.metric.asOfScope === "SNAPSHOT")
    const snapshotDate = snapshot.length > 0 ? await getLatestSnapshotDate(period.to ?? period.asOf) : null

    const dims = validDimension ? [validDimension] : []
    const groups: { refs: string[]; filters: SemanticFilter[]; scope: string }[] = []
    if (realized.length) {
      groups.push({ refs: realized.map((c) => c.ref), filters: periodFilters(period), scope: "REALIZED" })
    }
    if (snapshot.length && snapshotDate) {
      groups.push({
        refs: snapshot.map((c) => c.ref),
        filters: snapshotFilters(snapshotDate),
        scope: "SNAPSHOT",
      })
    }

    const sqlByGroup = groups.map((g) =>
      semanticViewSql({ semanticView: VIEW, metrics: g.refs, dimensions: dims, filters: g.filters }),
    )

    /**
     * Execute under the persona's own role when one is selected.
     *
     * runAsRole reports a role it could not assume instead of falling back to the service identity,
     * so a deployment that has not been granted the persona roles produces an honest error rather
     * than an answer that appears persona-scoped and is not.
     */
    let rows: Record<string, any>[] = []
    let executedAs = "the application's own role (owner's rights)"
    let personaError: string | null = null

    if (persona) {
      /**
       * One query per scope group, WITH the dimension, so a persona keeps its breakdown.
       *
       * This used to issue one dimensionless query per metric and reassemble a single row, which
       * discarded the dimensional breakdown entirely: asked as a persona, "on-time delivery by
       * product family" returned one number and no categories, so there was nothing to chart. The
       * row-access policy still applies either way — a row-scoped persona now gets a genuinely
       * shorter list of categories rather than a silently flattened one.
       */
      const perRole = await runRowsAsRole(
        persona.roleName,
        groups.map((g, gi) => ({
          key: String(gi),
          sql: semanticViewSql({
            semanticView: VIEW,
            metrics: g.refs,
            dimensions: dims,
            filters: g.filters,
          }),
        })),
      )
      const firstError = Object.values(perRole).find((v) => v.error)?.error
      if (firstError) {
        personaError = firstError
      } else {
        const parts = groups.map((_, gi) => perRole[String(gi)]?.rows ?? [])
        rows = mergeScopeGroups(parts, dims)
        executedAs = `${persona.roleName} (secondary roles disabled, row scope ${persona.rowScope})`
      }
    }

    if (!persona || personaError) {
      const parts = await Promise.all(
        groups.map((g) =>
          querySemanticView({ semanticView: VIEW, metrics: g.refs, dimensions: dims, filters: g.filters }),
        ),
      )
      rows = mergeScopeGroups(parts, dims)
    }

    // Cap the payload: charts and tables in the UI never need more than this.
    const capped = rows.slice(0, 200)

    // Find matching predictions for the chosen metrics
    const chosenMetricIds = new Set(chosen.map((c) => c.metric.metricId))
    const relevantPredictions = allOutlooks.filter((o) => chosenMetricIds.has(o.metricId))

    const metricPayload = chosen.map((c) => ({
      metricId: c.metric.metricId,
      businessName: c.metric.businessName,
      reference: c.ref,
      unit: c.metric.unit,
      definition: c.metric.definition,
      grain: c.metric.grain,
      ownerRole: c.metric.ownerRole,
      driftStatus: c.metric.driftStatus,
      asOfScope: c.metric.asOfScope,
      target: c.metric.target,
      warnThreshold: c.metric.warnThreshold,
      failThreshold: c.metric.failThreshold,
      direction: c.metric.direction,
      servedBy: c.metric.bindings.map((b) => b.semanticView),
      column: c.ref.split(".")[1].toUpperCase(),
    }))

    const dimensionColumn = validDimension ? validDimension.split(".")[1].toUpperCase() : null

    // Chart type and ordering are derived from the result shape, not chosen by the model, so the
    // same question always renders identically. `chartRows` is the ordered, capped subset the chart
    // draws; `rows` below stays complete so the table can still show everything.
    const { spec: chart, rows: chartRows } = buildChart({
      dimensionRef: validDimension,
      dimensionColumn,
      metrics: metricPayload,
      rows: capped,
    })

    logTurn({
      personaRole: persona?.roleName ?? null,
      question,
      metricIds: chosen.map((c) => c.metric.metricId),
      refused: false,
      refusalReason: null,
      latencyMs: Date.now() - startedAt,
    })

    return Response.json({
      answerable: true,
      reason: resolution.reason,
      semanticView: ONTOLOGY_VIEW,
      dimension: validDimension,
      period: { label: period.label, description: period.description },
      persona: persona
        ? { roleName: persona.roleName, personaLabel: persona.personaLabel, rowScope: persona.rowScope }
        : null,
      executedAs,
      personaError,
      predictions: relevantPredictions,
      metrics: metricPayload,
      dimensionColumn,
      chart,
      chartRows,
      rows: capped,
      rowCount: rows.length,
      snapshotDate,
      sql: sqlByGroup.join("\n\n"),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[ask] governed resolution failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to answer the question" },
      { status: 500 },
    )
  }
}
