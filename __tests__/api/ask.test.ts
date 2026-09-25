/**
 * Route-handler tests for the governed endpoints.
 *
 * The behaviour worth pinning down here is refusal, not success: the resolver must not be able to
 * invent a metric, and a signed-in user must not be able to escalate to another persona by editing
 * the request body. Both are enforced in the route rather than in the database, so both need a test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const querySnowflake = vi.fn()
const getMetricRegistry = vi.fn()
const getPersonas = vi.fn()
const querySemanticView = vi.fn()
const getLatestSnapshotDate = vi.fn()
const getMetricOutlook = vi.fn()
const runAsRole = vi.fn()
const runRowsAsRole = vi.fn()
const currentSession = vi.fn()

vi.mock("../../lib/sc", () => ({
  querySnowflake: (...a: unknown[]) => querySnowflake(...a),
  getMetricRegistry: () => getMetricRegistry(),
  getPersonas: () => getPersonas(),
  querySemanticView: (...a: unknown[]) => querySemanticView(...a),
  getLatestSnapshotDate: (...a: unknown[]) => getLatestSnapshotDate(...a),
  // The route fetches outlooks alongside the registry (route.ts:109-115) so it can
  // attach a prediction to an answered metric. vi.mock replaces the whole module,
  // so omitting this export does not fall through to the real one — every call
  // threw "No getMetricOutlook export" and turned all nine resolver and persona
  // assertions in this file into 500s, which looked like route bugs rather than a
  // mock gap. Defaults to none, so the answer shape is unchanged.
  getMetricOutlook: (...a: unknown[]) => getMetricOutlook(...a),
  semanticViewSql: (o: { metrics: string[] }) => `SELECT ... METRICS ${o.metrics.join(", ")}`,
  num: (v: unknown) => (v === null || v === undefined ? null : Number(v)),
  toIso: (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)),
}))
/**
 * Both per-role entry points are mocked.
 *
 * runRowsAsRole is what /api/ask now calls, so omitting it from this factory made every persona test
 * throw "No 'runRowsAsRole' export is defined on the mock" and fail as a 500 — the same trap that
 * `getMetricOutlook` set when it was left out of the lib/sc factory. vi.mock replaces the WHOLE
 * module, so anything the route imports has to be listed here.
 */
vi.mock("../../lib/persona", () => ({
  runAsRole: (...a: unknown[]) => runAsRole(...a),
  runRowsAsRole: (...a: unknown[]) => runRowsAsRole(...a),
}))
vi.mock("../../lib/session", () => ({ currentSession: () => currentSession() }))

const METRIC = {
  metricId: "otd_pct",
  businessName: "On-Time Delivery",
  definition: "Share of customer order lines delivered on or before the promised date.",
  unit: "percent",
  grain: "sales_order_line",
  ownerRole: "SC_LOGISTICS_ANALYST",
  driftStatus: "PASS",
  asOfScope: "REALIZED",
  canonicalFact: "CANONICAL.FCT_ORDER_LINE_FULFILLMENT",
  target: 0.95,
  warnThreshold: 0.92,
  failThreshold: 0.9,
  direction: "higher",
  // Every governed metric is bound twice: once to its domain view, once to the cross-domain view.
  // The fixture carried only the cross-domain binding, which no metric in the deployed registry
  // actually looks like — and which quietly exempted it from the domain-grant rule below.
  bindings: [
    { semanticView: "SC_ONTOLOGY_360", metricReference: "order_fulfillment.otd_pct" },
    { semanticView: "SC_FULFILLMENT", metricReference: "order_fulfillment.otd_pct" },
  ],
}

const PERSONAS = [
  { roleName: "SC_LOGISTICS", personaLabel: "Logistics", rowScope: "ALL REGIONS", focus: "" },
  { roleName: "SC_LOGISTICS_EU", personaLabel: "Logistics (EU)", rowScope: "EU", focus: "" },
]

function request(body: unknown) {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** The resolver's reply, as the route would receive it from AI_COMPLETE. */
function resolverReturns(json: unknown, grants?: { ROLE_NAME: string; SEMANTIC_VIEW: string }[]) {
  querySnowflake.mockImplementation((sql: string) => {
    if (String(sql).includes("AI_COMPLETE")) {
      return Promise.resolve([{ RESOLUTION: JSON.stringify(json) }])
    }
    if (String(sql).includes("SEMANTIC_DIMENSIONS")) {
      return Promise.resolve([{ REF: "part.product_family", COMMENT: null }])
    }
    if (String(sql).includes("PERSONA_VIEW_ACCESS")) {
      return Promise.resolve(
        grants ?? [
          { ROLE_NAME: "SC_LOGISTICS", SEMANTIC_VIEW: "SC_ONTOLOGY_360" },
          { ROLE_NAME: "SC_LOGISTICS", SEMANTIC_VIEW: "SC_FULFILLMENT" },
          { ROLE_NAME: "SC_LOGISTICS_EU", SEMANTIC_VIEW: "SC_ONTOLOGY_360" },
          { ROLE_NAME: "SC_LOGISTICS_EU", SEMANTIC_VIEW: "SC_FULFILLMENT" },
        ],
      )
    }
    return Promise.resolve([])
  })
}

beforeEach(() => {
  for (const m of [
    querySnowflake,
    getMetricRegistry,
    getPersonas,
    querySemanticView,
    getLatestSnapshotDate,
    runAsRole,
    runRowsAsRole,
    currentSession,
  ]) {
    m.mockReset()
  }
  getMetricRegistry.mockResolvedValue([METRIC])
  getPersonas.mockResolvedValue(PERSONAS)
  querySemanticView.mockResolvedValue([{ OTD_PCT: 0.8791 }])
  getLatestSnapshotDate.mockResolvedValue("2026-08-31")
  getMetricOutlook.mockResolvedValue([])
  runAsRole.mockResolvedValue({ "0:order_fulfillment.otd_pct": { value: 0.8795 } })
  // The rows-returning path is what the route uses; one group, one scalar row.
  runRowsAsRole.mockResolvedValue({ "0": { rows: [{ OTD_PCT: 0.8795 }] } })
  currentSession.mockResolvedValue(null)
})

afterEach(() => vi.resetModules())

describe("POST /api/ask", () => {
  it("requires a question", async () => {
    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({}))
    expect(res.status).toBe(400)
  })

  it("rejects an over-long question rather than sending it to the model", async () => {
    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({ question: "x".repeat(501) }))
    expect(res.status).toBe(400)
    expect(querySnowflake).not.toHaveBeenCalled()
  })

  it("discards a metric id the registry does not contain", async () => {
    // The model is asked for ids only, but it can still hallucinate one. It must not reach SQL.
    resolverReturns({ answerable: true, metricIds: ["customer_satisfaction"], dimension: null, reason: "made up" })
    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({ question: "What is our customer satisfaction?" }))
    const body = await res.json()

    expect(body.answerable).toBe(false)
    expect(body.suggestions).toContain("On-Time Delivery")
    expect(querySemanticView).not.toHaveBeenCalled()
  })

  /**
   * The cross-domain view must not be a bypass of domain scope.
   *
   * Found by AGENT_EVAL_QUESTION Q53, not by review: SC_PROCUREMENT holds SC_SUPPLIER and not
   * SC_LANDED_COST, and was answered on freight bill variance anyway because that metric is also
   * bound to SC_ONTOLOGY_360, which it can read. PERSONA_VIEW_ACCESS said one thing and the
   * conversational layer did another.
   */
  it("refuses a metric the persona holds no domain grant for, even via the cross-domain view", async () => {
    resolverReturns(
      { answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" },
      // Granted the cross-domain view only. The domain view that serves this metric is withheld.
      [{ ROLE_NAME: "SC_LOGISTICS", SEMANTIC_VIEW: "SC_ONTOLOGY_360" }],
    )
    const { POST } = await import("../../app/api/ask/route")
    const body = await (
      await POST(request({ question: "What is our on-time delivery?", persona: "SC_LOGISTICS" }))
    ).json()

    expect(body.answerable).toBe(false)
    expect(runRowsAsRole).not.toHaveBeenCalled()
  })

  it("discards a dimension the view does not expose but still answers the metric", async () => {
    resolverReturns({
      answerable: true,
      metricIds: ["otd_pct"],
      dimension: "customer.made_up_field",
      reason: "ok",
    })
    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "OTD by something invented" }))).json()

    expect(body.answerable).toBe(true)
    expect(body.dimension).toBeNull()
    expect(querySemanticView).toHaveBeenCalledWith(expect.objectContaining({ dimensions: [] }))
  })

  it("refuses when the resolver says the question is unanswerable", async () => {
    resolverReturns({ answerable: false, metricIds: [], dimension: null, reason: "Not a governed metric." })
    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "What is the weather?" }))).json()
    expect(body.answerable).toBe(false)
    expect(body.reason).toBe("Not a governed metric.")
  })

  it("refuses gracefully when the model returns unparseable output", async () => {
    querySnowflake.mockImplementation((sql: string) => {
      if (String(sql).includes("AI_COMPLETE")) return Promise.resolve([{ RESOLUTION: "I cannot help with that." }])
      if (String(sql).includes("SEMANTIC_DIMENSIONS")) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "anything" }))).json()
    expect(body.answerable).toBe(false)
    expect(body.reason).toMatch(/did not return a usable mapping/)
  })

  it("rejects an unregistered persona", async () => {
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" })
    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({ question: "OTD?", persona: "SC_MADE_UP" }))
    expect(res.status).toBe(400)
  })

  it("refuses to run as a persona other than the signed-in account's", async () => {
    currentSession.mockResolvedValue({ username: "logistics-eu", personaRole: "SC_LOGISTICS_EU", exp: 9e9 })
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" })

    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({ question: "OTD?", persona: "SC_LOGISTICS" }))

    expect(res.status).toBe(403)
    expect(runRowsAsRole).not.toHaveBeenCalled()
  })

  it("executes under the signed-in persona's role", async () => {
    currentSession.mockResolvedValue({ username: "logistics-eu", personaRole: "SC_LOGISTICS_EU", exp: 9e9 })
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" })

    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "OTD?", persona: "SC_LOGISTICS_EU" }))).json()

    expect(runRowsAsRole).toHaveBeenCalledWith("SC_LOGISTICS_EU", expect.any(Array))
    expect(body.executedAs).toContain("SC_LOGISTICS_EU")
    expect(body.rows[0].OTD_PCT).toBe(0.8795)
  })

  /**
   * The regression this guards: the persona path used to issue one dimensionless query per metric and
   * rebuild a single row, silently discarding the breakdown. A persona asking for a breakdown got one
   * number and no categories, so there was nothing to chart.
   */
  it("keeps the dimensional breakdown when a persona asks for one", async () => {
    currentSession.mockResolvedValue({ username: "logistics", personaRole: "SC_LOGISTICS", exp: 9e9 })
    runRowsAsRole.mockResolvedValue({
      "0": {
        rows: [
          { PRODUCT_FAMILY: "Castings", OTD_PCT: 0.81 },
          { PRODUCT_FAMILY: "Fasteners", OTD_PCT: 0.93 },
        ],
      },
    })
    resolverReturns({
      answerable: true,
      metricIds: ["otd_pct"],
      dimension: "part.product_family",
      reason: "ok",
    })

    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "OTD by family?", persona: "SC_LOGISTICS" }))).json()

    expect(body.rowCount).toBe(2)
    expect(body.dimensionColumn).toBe("PRODUCT_FAMILY")
    // Ranked descending by the first metric, so the chart and table agree.
    expect(body.chart.kind).toBe("bar")
    expect(body.chartRows.map((r: any) => r.PRODUCT_FAMILY)).toEqual(["Fasteners", "Castings"])
  })

  it("says so when the persona role could not be assumed, instead of passing off the owner's result", async () => {
    currentSession.mockResolvedValue({ username: "logistics", personaRole: "SC_LOGISTICS", exp: 9e9 })
    runRowsAsRole.mockResolvedValue({
      "0": { rows: [], error: "could not run as SC_LOGISTICS: not granted" },
    })
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" })

    const { POST } = await import("../../app/api/ask/route")
    const body = await (await POST(request({ question: "OTD?", persona: "SC_LOGISTICS" }))).json()

    expect(body.personaError).toMatch(/could not run as SC_LOGISTICS/)
    // It still answers, but from the owner's-rights path, and the flag above says so.
    expect(querySemanticView).toHaveBeenCalled()
  })

  /**
   * MULTI-TURN. History is client-supplied, so it is re-validated against the registry every turn.
   * A caller who edits a previous turn to name a metric they cannot reach must gain nothing by it.
   */
  it("passes prior turns to the resolver so a follow-up can be interpreted", async () => {
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: "part.product_family", reason: "ok" })

    const { POST } = await import("../../app/api/ask/route")
    await POST(
      request({
        question: "and by family?",
        history: [{ question: "What is OTD?", metricIds: ["otd_pct"], dimension: null }],
      }),
    )

    const prompt = String(querySnowflake.mock.calls.find((c) => /AI_COMPLETE/.test(String(c[0])))?.[1]?.binds?.[1])
    expect(prompt).toContain("CONVERSATION SO FAR")
    expect(prompt).toContain("What is OTD?")
  })

  it("strips a metric id from history that the registry does not recognise", async () => {
    resolverReturns({ answerable: true, metricIds: ["otd_pct"], dimension: null, reason: "ok" })

    const { POST } = await import("../../app/api/ask/route")
    await POST(
      request({
        question: "and by family?",
        history: [
          { question: "margin please", metricIds: ["gross_margin_pct"], dimension: null },
          { question: "What is OTD?", metricIds: ["otd_pct"], dimension: null },
        ],
      }),
    )

    const prompt = String(querySnowflake.mock.calls.find((c) => /AI_COMPLETE/.test(String(c[0])))?.[1]?.binds?.[1])
    expect(prompt).not.toContain("gross_margin_pct")
    // The turn carried nothing else resolvable, so it is dropped entirely rather than shown empty.
    expect(prompt).not.toContain("margin please")
    expect(prompt).toContain("What is OTD?")
  })

  it("reports a failure as a 500 rather than a partial answer", async () => {
    querySnowflake.mockRejectedValue(new Error("warehouse suspended"))
    const { POST } = await import("../../app/api/ask/route")
    const res = await POST(request({ question: "OTD?" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("warehouse suspended")
  })
})
