/**
 * Route-handler tests for the exception drill-down.
 *
 * This route builds SQL from two sources: governance metadata (trusted, admin-owned) and the
 * request body (untrusted). The tests below cover the boundary between them — that request values
 * are bound, that a dimension is only used if it exists on the fact, and that a stale or
 * inconsistent rule fails loudly rather than producing rows that do not reconcile to the metric.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const querySnowflake = vi.fn()
const getMetricRegistry = vi.fn()

vi.mock("../../lib/sc", () => ({
  querySnowflake: (...a: unknown[]) => querySnowflake(...a),
  getMetricRegistry: () => getMetricRegistry(),
  toIso: (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)),
}))

const FACT = "CANONICAL.FCT_SUPPLIER_DELIVERY_LINE"

const METRIC = {
  metricId: "supplier_otd_pct",
  businessName: "Supplier On-Time Delivery",
  canonicalFact: FACT,
  asOfScope: "REALIZED",
}

const RULE = {
  METRIC_ID: "supplier_otd_pct",
  CANONICAL_FACT: FACT,
  DATE_COLUMN: "RECEIPT_DATE",
  EXCEPTION_WHERE: "IS_ON_TIME = 0",
  DISPLAY_COLUMNS: "PO_ID,SUPPLIER_REGION,RECEIPT_DATE,DROPPED_COLUMN",
  ORDER_BY: "RECEIPT_VARIANCE_DAYS DESC",
  DESCRIPTION: "Purchase-order lines received after the promised date.",
}

const FACT_COLUMNS = [
  "PO_ID",
  "SUPPLIER_REGION",
  "RECEIPT_DATE",
  "IS_ON_TIME",
  "RECEIPT_VARIANCE_DAYS",
  "PRODUCT_FAMILY",
]

function setupQueries(overrides: { rule?: Record<string, unknown> | null } = {}) {
  querySnowflake.mockImplementation((sql: string) => {
    const s = String(sql)
    if (s.includes("METRIC_EXCEPTION_RULE")) {
      const rule = overrides.rule === undefined ? RULE : overrides.rule
      return Promise.resolve(rule ? [rule] : [])
    }
    if (s.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return Promise.resolve(FACT_COLUMNS.map((c) => ({ COLUMN_NAME: c })))
    }
    if (s.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ N: 612 }])
    return Promise.resolve([{ PO_ID: "PO1", SUPPLIER_REGION: "EU", RECEIPT_DATE: new Date("2026-08-14") }])
  })
}

function request(body: unknown) {
  return new Request("http://localhost/api/drilldown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  querySnowflake.mockReset()
  getMetricRegistry.mockReset()
  getMetricRegistry.mockResolvedValue([METRIC])
  setupQueries()
})

afterEach(() => vi.resetModules())

describe("POST /api/drilldown", () => {
  it("requires a metricId", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    expect((await POST(request({}))).status).toBe(400)
  })

  it("rejects an unregistered metric", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    expect((await POST(request({ metricId: "invented" }))).status).toBe(404)
  })

  it("reports that a metric has no exception rule rather than returning nothing", async () => {
    setupQueries({ rule: null })
    const { POST } = await import("../../app/api/drilldown/route")
    const res = await POST(request({ metricId: "supplier_otd_pct" }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/No exception rule is registered/)
  })

  it("refuses a rule that reads a different fact than the metric is defined over", async () => {
    setupQueries({ rule: { ...RULE, CANONICAL_FACT: "CANONICAL.SOME_OTHER_FACT" } })
    const { POST } = await import("../../app/api/drilldown/route")
    const res = await POST(request({ metricId: "supplier_otd_pct" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/but the metric is defined over/)
  })

  it("drops display columns that no longer exist on the fact", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct", period: "all" }))).json()
    expect(body.columns).toEqual(["PO_ID", "SUPPLIER_REGION", "RECEIPT_DATE"])
    expect(body.columns).not.toContain("DROPPED_COLUMN")
  })

  it("binds the dimension value instead of interpolating it", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (
      await POST(
        request({
          metricId: "supplier_otd_pct",
          period: "all",
          dimension: "supplier.supplier_region",
          dimensionValue: "EU' OR 1=1 --",
        }),
      )
    ).json()

    expect(body.sql).toContain("SUPPLIER_REGION = ?")
    expect(body.sql).not.toContain("OR 1=1")
    const dataCall = querySnowflake.mock.calls.find(([sql]) => String(sql).startsWith("SELECT PO_ID"))!
    expect(dataCall[1].binds).toContain("EU' OR 1=1 --")
  })

  it("ignores a dimension that has no column on the fact rather than guessing one", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (
      await POST(
        request({
          metricId: "supplier_otd_pct",
          period: "all",
          dimension: "customer.customer_region",
          dimensionValue: "EU",
        }),
      )
    ).json()
    expect(body.dimension).toBeNull()
    expect(body.sql).not.toContain("CUSTOMER_REGION")
  })

  it("applies the as-of rule so future-dated rows are not reported as late", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct", period: "all" }))).json()
    expect(body.sql).toContain("RECEIPT_DATE <= CURRENT_DATE()")
  })

  it("reports the full exception count alongside the truncated row set", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct", period: "all", limit: 1 }))).json()
    expect(body.total).toBe(612)
    expect(body.shown).toBe(1)
    expect(body.sql).toContain("LIMIT 1")
  })

  it("caps the limit so a client cannot request an unbounded scan", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct", period: "all", limit: 100000 }))).json()
    expect(body.sql).toContain("LIMIT 200")
  })

  it("normalises Date columns to ISO dates", async () => {
    const { POST } = await import("../../app/api/drilldown/route")
    const body = await (await POST(request({ metricId: "supplier_otd_pct", period: "all" }))).json()
    expect(body.rows[0].RECEIPT_DATE).toBe("2026-08-14")
  })
})
