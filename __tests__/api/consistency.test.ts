/**
 * Route-handler tests for the cross-persona consistency check.
 *
 * This is the endpoint behind the project's headline claim, so the assertions that matter most are
 * the ones about *not overstating* the result: an absence of observations is not agreement, a single
 * observation is not agreement, and a row-scoped persona returning a different number is expected
 * rather than a failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const querySnowflake = vi.fn()
const getMetricRegistry = vi.fn()
const getPersonas = vi.fn()
const runAsRole = vi.fn()

vi.mock("../../lib/sc", () => ({
  querySnowflake: (...a: unknown[]) => querySnowflake(...a),
  getMetricRegistry: () => getMetricRegistry(),
  getPersonas: () => getPersonas(),
  semanticViewSql: (o: { semanticView: string; metrics: string[] }) =>
    `SELECT * FROM SEMANTIC_VIEW(${o.semanticView} METRICS ${o.metrics.join(", ")})`,
}))
vi.mock("../../lib/persona", () => ({ runAsRole: (...a: unknown[]) => runAsRole(...a) }))

const METRIC = {
  metricId: "supplier_otd_pct",
  businessName: "Supplier On-Time Delivery",
  unit: "percent",
  definition: "Share of PO lines received on or before the promised date.",
  canonicalValue: 0.849595,
  bindings: [
    { semanticView: "SC_ONTOLOGY_360", metricReference: "purchase_order.supplier_otd_pct" },
    { semanticView: "SC_SUPPLIER", metricReference: "SUPPLIER_OTD_PCT" },
  ],
}

const PERSONAS = [
  { roleName: "SC_PROCUREMENT", personaLabel: "Procurement", rowScope: "ALL REGIONS", focus: "", sortOrder: 1 },
  { roleName: "SC_LOGISTICS", personaLabel: "Logistics", rowScope: "ALL REGIONS", focus: "", sortOrder: 2 },
  { roleName: "SC_LOGISTICS_EU", personaLabel: "Logistics (EU)", rowScope: "EU", focus: "", sortOrder: 3 },
  { roleName: "SC_ONTOLOGY_STEWARD", personaLabel: "Steward", rowScope: "ALL REGIONS", focus: "", sortOrder: 4 },
]

const ACCESS = [
  { ROLE_NAME: "SC_PROCUREMENT", SEMANTIC_VIEW: "SC_ONTOLOGY_360" },
  { ROLE_NAME: "SC_PROCUREMENT", SEMANTIC_VIEW: "SC_SUPPLIER" },
  { ROLE_NAME: "SC_LOGISTICS", SEMANTIC_VIEW: "SC_ONTOLOGY_360" },
  { ROLE_NAME: "SC_LOGISTICS_EU", SEMANTIC_VIEW: "SC_ONTOLOGY_360" },
]

function request(body: unknown) {
  return new Request("http://localhost/api/consistency", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Give every binding the same value, which is the passing case. */
function allAgree(value = 0.849595) {
  runAsRole.mockImplementation((_role: string, queries: { key: string }[]) =>
    Promise.resolve(Object.fromEntries(queries.map((q) => [q.key, { value }]))),
  )
}

beforeEach(() => {
  for (const m of [querySnowflake, getMetricRegistry, getPersonas, runAsRole]) m.mockReset()
  getMetricRegistry.mockResolvedValue([METRIC])
  getPersonas.mockResolvedValue(PERSONAS)
  querySnowflake.mockResolvedValue(ACCESS)
  allAgree()
})

afterEach(() => vi.resetModules())

describe("POST /api/consistency", () => {
  it("requires a metricId", async () => {
    const { POST } = await import("../../app/api/consistency/route")
    expect((await POST(request({}))).status).toBe(400)
  })

  it("rejects a metric that is not in the registry", async () => {
    const { POST } = await import("../../app/api/consistency/route")
    const res = await POST(request({ metricId: "invented_metric" }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not a registered metric/)
  })

  it("reports EXACT when every unscoped persona returns the same value", async () => {
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.agreement).toBe("EXACT")
    expect(body.observations).toBeGreaterThanOrEqual(2)
    expect(body.distinctValues).toBe(1)
    expect(body.unprovenReason).toBeNull()
  })

  it("excludes the steward from the persona comparison", async () => {
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.personas.map((p: { roleName: string }) => p.roleName)).not.toContain("SC_ONTOLOGY_STEWARD")
  })

  it("only asks each persona for views it is actually granted", async () => {
    const { POST } = await import("../../app/api/consistency/route")
    await POST(request({ metricId: "supplier_otd_pct" }))

    const byRole = new Map(runAsRole.mock.calls.map(([role, queries]) => [role, queries]))
    // Procurement has both views; Logistics has only the cross-domain one.
    expect(byRole.get("SC_PROCUREMENT")!.map((q: { key: string }) => q.key).sort()).toEqual([
      "SC_ONTOLOGY_360",
      "SC_SUPPLIER",
    ])
    expect(byRole.get("SC_LOGISTICS")!.map((q: { key: string }) => q.key)).toEqual(["SC_ONTOLOGY_360"])
  })

  it("reports DIVERGENT when two unscoped personas disagree", async () => {
    runAsRole.mockImplementation((role: string, queries: { key: string }[]) =>
      Promise.resolve(
        Object.fromEntries(
          queries.map((q) => [q.key, { value: role === "SC_LOGISTICS" ? 0.86 : 0.849595 }]),
        ),
      ),
    )
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.agreement).toBe("DIVERGENT")
    expect(body.distinctValues).toBeGreaterThan(1)
  })

  it("does NOT count a row-scoped persona's different number as divergence", async () => {
    // A row access policy legitimately changes which rows are in scope without changing the
    // definition, so the EU persona must not be able to turn a passing check into a failure.
    runAsRole.mockImplementation((role: string, queries: { key: string }[]) =>
      Promise.resolve(
        Object.fromEntries(
          queries.map((q) => [q.key, { value: role === "SC_LOGISTICS_EU" ? 0.91 : 0.849595 }]),
        ),
      ),
    )
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.agreement).toBe("EXACT")
    // But the scoped value is still reported, so the difference is visible rather than hidden.
    const eu = body.personas.find((p: { roleName: string }) => p.roleName === "SC_LOGISTICS_EU")
    expect(eu.values[0].value).toBe(0.91)
  })

  it("reports UNPROVEN, not EXACT, when every persona query failed", async () => {
    // The regression this guards: `distinctValues <= 1` alone called an empty result set agreement,
    // which is the most misleading possible output for this endpoint.
    runAsRole.mockImplementation((role: string, queries: { key: string }[]) =>
      Promise.resolve(
        Object.fromEntries(queries.map((q) => [q.key, { value: null, error: `could not run as ${role}` }])),
      ),
    )
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.agreement).toBe("UNPROVEN")
    expect(body.observations).toBe(0)
    expect(body.unprovenReason).toMatch(/could not run as/)
  })

  it("reports SINGLE OBSERVATION when there is nothing to compare against", async () => {
    getPersonas.mockResolvedValue([PERSONAS[1]]) // only SC_LOGISTICS, which has one view
    const { POST } = await import("../../app/api/consistency/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct" }))).json()
    expect(body.agreement).toBe("SINGLE OBSERVATION")
    expect(body.observations).toBe(1)
  })

  it("surfaces a per-binding authorisation denial as a result, not a crash", async () => {
    runAsRole.mockImplementation((_role: string, queries: { key: string }[]) =>
      Promise.resolve(
        Object.fromEntries(
          queries.map((q) => [
            q.key,
            q.key === "SC_SUPPLIER" ? { value: null, error: "not authorised" } : { value: 0.849595 },
          ]),
        ),
      ),
    )
    const { POST } = await import("../../app/api/consistency/route")
    const res = await POST(request({ metricId: "supplier_otd_pct" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.agreement).toBe("EXACT")
    const denied = body.personas
      .flatMap((p: { values: { error?: string }[] }) => p.values)
      .filter((v: { error?: string }) => v.error === "not authorised")
    expect(denied.length).toBeGreaterThan(0)
  })

  it("returns 500 when the access lookup itself fails", async () => {
    querySnowflake.mockRejectedValue(new Error("GOVERNANCE not authorized"))
    const { POST } = await import("../../app/api/consistency/route")
    const res = await POST(request({ metricId: "supplier_otd_pct" }))
    expect(res.status).toBe(500)
  })
})
