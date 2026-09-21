/**
 * Executes one governed metric as every analytic persona, through every semantic view that
 * persona can reach, and reports whether the values agree.
 *
 * POST /api/consistency  { metricId: string }
 *
 * Each persona's query runs on a connection opened with that role and with secondary roles
 * disabled, so the numbers are produced under the persona's own grants rather than the app's.
 */

import { getMetricRegistry, getPersonas, querySnowflake, semanticViewSql } from "@/lib/sc"
import { runAsRole, type RoleQuery } from "@/lib/persona"

export const dynamic = "force-dynamic"

/** Opens one connection per persona role; ~8s observed, but warehouse resume can add to that. */
export const maxDuration = 120

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { metricId?: string }
    const metricId = body.metricId
    if (!metricId) return Response.json({ error: "metricId is required" }, { status: 400 })

    const [registry, personas] = await Promise.all([getMetricRegistry(), getPersonas()])
    const metric = registry.find((m) => m.metricId === metricId)
    if (!metric) {
      return Response.json(
        { error: `"${metricId}" is not a registered metric. Only metrics in GOVERNANCE.METRIC_DEFINITION can be queried.` },
        { status: 404 },
      )
    }

    // Which semantic views is each persona actually granted?
    const accessRows = await querySnowflake(
      `SELECT role_name, semantic_view FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS`,
    )
    const accessByRole = new Map<string, Set<string>>()
    for (const r of accessRows) {
      const role = r.ROLE_NAME as string
      if (!accessByRole.has(role)) accessByRole.set(role, new Set())
      accessByRole.get(role)!.add(r.SEMANTIC_VIEW as string)
    }

    const analystPersonas = personas.filter((p) => p.roleName !== "SC_ONTOLOGY_STEWARD")

    const results = await Promise.all(
      analystPersonas.map(async (p) => {
        const granted = accessByRole.get(p.roleName) ?? new Set<string>()
        const bindings = metric.bindings.filter((b) => granted.has(b.semanticView))

        const queries: RoleQuery[] = bindings.map((b) => ({
          key: b.semanticView,
          sql: semanticViewSql({ semanticView: b.semanticView, metrics: [b.metricReference] }),
        }))

        const values = queries.length > 0 ? await runAsRole(p.roleName, queries) : {}

        return {
          roleName: p.roleName,
          personaLabel: p.personaLabel,
          rowScope: p.rowScope,
          values: bindings.map((b) => ({
            semanticView: b.semanticView,
            metricReference: b.metricReference,
            value: values[b.semanticView]?.value ?? null,
            ...(values[b.semanticView]?.error ? { error: values[b.semanticView].error } : {}),
          })),
        }
      }),
    )

    // Agreement is judged only across personas whose row scope is unrestricted: a row access
    // policy legitimately changes which rows are in scope without changing the definition.
    const unscoped = results.filter((r) => {
      const persona = analystPersonas.find((p) => p.roleName === r.roleName)
      return persona?.rowScope === "ALL REGIONS"
    })
    const observed = unscoped
      .flatMap((r) => r.values.map((v) => v.value))
      .filter((v): v is number => v !== null)
    const distinct = new Set(observed.map((v) => v.toFixed(10)))

    /**
     * An absence of values is not agreement.
     *
     * Judging `distinct.size <= 1` alone reported "EXACT" when every persona query had failed and
     * nothing was observed at all — the most misleading possible output for a page whose entire
     * purpose is to prove the numbers agree. Agreement now requires at least two observations to
     * compare; one observation is reported as such, and none is an explicit failure.
     */
    const errors = results.flatMap((r) => r.values.filter((v) => v.error).map((v) => v.error as string))
    const agreement =
      observed.length === 0
        ? "UNPROVEN"
        : distinct.size > 1
          ? "DIVERGENT"
          : observed.length === 1
            ? "SINGLE OBSERVATION"
            : "EXACT"

    return Response.json({
      metricId: metric.metricId,
      businessName: metric.businessName,
      unit: metric.unit,
      definition: metric.definition,
      canonicalValue: observed.length > 0 ? observed[0] : metric.canonicalValue,
      distinctValues: distinct.size,
      observations: observed.length,
      agreement,
      /** Present when agreement could not be established, so the UI can explain rather than imply. */
      unprovenReason:
        observed.length === 0
          ? errors.length > 0
            ? `No persona returned a value. First error: ${errors[0]}`
            : "No persona is granted a semantic view that serves this metric."
          : null,
      personas: results,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[consistency] per-persona execution failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to run the consistency check" },
      { status: 500 },
    )
  }
}
