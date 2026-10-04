/**
 * Cortex Analyst cross-check.
 *
 * POST /api/ask/analyst  { question: string }
 *
 * The registry engine (/api/ask) is the default answer path. This route asks the same question of
 * Cortex Analyst over the same semantic view and returns Analyst's SQL and result, so the UI can show
 * whether two independent text-to-SQL paths land on the same governed number.
 *
 * GOVERNANCE. Generation and execution are split (sql/25_cortex_analyst_bridge.sql). Analyst must
 * validate the view against base tables personas are deliberately denied, so
 * SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST runs with owner's rights and returns SQL TEXT only — no
 * rows. That SQL is then executed on a connection that has assumed the signed-in persona's role with
 * secondary roles disabled (lib/persona.ts), so grants and the EU row access policy decide what the
 * persona sees, exactly as they do for the registry engine.
 *
 * The generated SQL is executed only if it is a single read-only SELECT over SEMANTIC_VIEW(...):
 * the answer must come from governed metric definitions, never from raw columns.
 */

import { querySnowflake, getMetricRegistry } from "@/lib/sc"
import { runRowsAsRole } from "@/lib/persona"
import { currentSession, unmappedCallerResponse } from "@/lib/session"
import { ONTOLOGY_VIEW } from "@/lib/constants"
import { governedStatement, referencedMetrics, isDecisionQuestion } from "@/lib/sql-guard"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BRIDGE = "SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST"

interface AnalystContent {
  type: string
  text?: string
  statement?: string
  suggestions?: string[]
  confidence?: { verified_query_used?: { name?: string; question?: string } | null }
}

async function run(role: string | null, sql: string, binds: unknown[] = []) {
  if (!role) return { rows: await querySnowflake(sql, { binds: binds as any }) }
  const out = await runRowsAsRole(role, [{ key: "q", sql, binds }])
  return out.q
}

export async function POST(req: Request) {
  const startedAt = Date.now()
  try {
    const body = (await req.json().catch(() => ({}))) as { question?: string }
    const question = (body.question ?? "").trim()
    if (!question) return Response.json({ error: "A question is required" }, { status: 400 })
    if (question.length > 500) return Response.json({ error: "Question is too long" }, { status: 400 })

    if (isDecisionQuestion(question)) {
      return Response.json({
        engine: "cortex-analyst",
        answerable: false,
        rejected: "This asks for a decision, not a measurement. Governed metrics can inform it, but the answer is not computed.",
        latencyMs: Date.now() - startedAt,
      })
    }

    // The signed-in account decides the role, exactly as in /api/ask. Inside SPCS the caller is
    // mapped to a persona via GOVERNANCE.PERSONA_USER_MAP; an unmapped caller is refused.
    const session = await currentSession()
    const role = session?.personaRole ?? null

    const bridge = await run(role, `CALL ${BRIDGE}(?, ?)`, [question, ONTOLOGY_VIEW])
    if (bridge.error) {
      return Response.json({ error: `Cortex Analyst call failed: ${bridge.error}` }, { status: 502 })
    }
    const raw = Object.values(bridge.rows[0] ?? {})[0]
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!payload || payload.status !== 200) {
      return Response.json(
        { error: `Cortex Analyst returned status ${payload?.status ?? "unknown"}` },
        { status: 502 },
      )
    }

    const content: AnalystContent[] = payload.response?.message?.content ?? []
    const interpretation = content.find((c) => c.type === "text")?.text ?? null
    const sqlBlock = content.find((c) => c.type === "sql")
    const suggestions = content.find((c) => c.type === "suggestions")?.suggestions ?? []
    const meta = payload.response?.response_metadata ?? {}

    const base = {
      engine: "cortex-analyst",
      semanticView: ONTOLOGY_VIEW,
      executedAs: role ?? "application role",
      interpretation,
      suggestions,
      verifiedQueryUsed: sqlBlock?.confidence?.verified_query_used?.name ?? null,
      models: meta.model_names ?? [],
      questionCategory: meta.question_category ?? null,
      requestId: payload.response?.request_id ?? null,
    }

    if (!sqlBlock?.statement) {
      return Response.json({ ...base, answerable: false, latencyMs: Date.now() - startedAt })
    }

    const statement = governedStatement(sqlBlock.statement)
    if (!statement) {
      return Response.json({
        ...base,
        answerable: false,
        rejected: "Analyst SQL was not a single read-only SEMANTIC_VIEW query, so it was not executed.",
        sql: sqlBlock.statement,
        latencyMs: Date.now() - startedAt,
      })
    }

    // Domain scope, exactly as /api/ask: a metric is permitted only if the persona is granted a
    // DOMAIN view that serves it. The cross-domain view alone must not widen access (eval Q53).
    if (role) {
      const [registry, access] = await Promise.all([
        getMetricRegistry(),
        querySnowflake(
          `SELECT semantic_view FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS WHERE role_name = ?`,
          { binds: [role] },
        ),
      ])
      const granted = new Set(access.map((r: any) => String(r.SEMANTIC_VIEW)))
      const denied = referencedMetrics(statement).filter((name) => {
        const def = registry.find((m) => m.metricId.toLowerCase() === name)
        return (
          !!def &&
          !def.bindings.some((b) => b.semanticView !== "SC_ONTOLOGY_360" && granted.has(b.semanticView))
        )
      })
      if (denied.length > 0) {
        return Response.json({
          ...base,
          answerable: false,
          rejected: `${role} is not granted the domain that serves ${denied.join(", ")}, so the query was not executed.`,
          sql: statement,
          latencyMs: Date.now() - startedAt,
        })
      }
    }

    const result = await run(role, `SELECT * FROM (${statement}) LIMIT 200`)
    if (result.error) {
      return Response.json({ ...base, answerable: false, sql: statement, error: result.error }, { status: 200 })
    }

    return Response.json({
      ...base,
      answerable: true,
      sql: statement,
      rows: result.rows,
      rowCount: result.rows.length,
      latencyMs: Date.now() - startedAt,
    })
  } catch (e) {
    const denied = unmappedCallerResponse(e)
    if (denied) return denied
    const ref = crypto.randomUUID().slice(0, 8)
    console.error(new Date().toISOString(), `[ask/analyst] ref=${ref} cross-check failed`, e)
    return Response.json({ error: `Cortex Analyst cross-check failed (ref ${ref}).` }, { status: 500 })
  }
}
