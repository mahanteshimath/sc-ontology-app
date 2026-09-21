/**
 * Governed filter construction and identifier validation.
 *
 * These are the tests that matter most for safety: querySemanticView interpolates metric and
 * dimension *names* directly into SQL (Snowflake does not accept binds for them), so the only thing
 * standing between a request and injected SQL is the identifier pattern plus the check against the
 * deployed view's dimension list. Filter *values* are bound and are asserted to be bound here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const querySnowflake = vi.fn()
const querySnowflakeLongRunning = vi.fn()

vi.mock("../../lib/snowflake", () => ({
  querySnowflake: (...args: unknown[]) => querySnowflake(...args),
  querySnowflakeLongRunning: (...args: unknown[]) => querySnowflakeLongRunning(...args),
}))

const DIMENSION_ROWS = [
  { REF: "calendar.cal_date" },
  { REF: "calendar.cal_period" },
  { REF: "calendar.is_future" },
  { REF: "part.product_family" },
  { REF: "supplier.supplier_region" },
]

async function loadSc() {
  const sc = await import("../../lib/sc")
  sc.resetDimensionRefCache()
  sc.resetMetadataCache()
  return sc
}

beforeEach(() => {
  querySnowflake.mockReset()
  querySnowflakeLongRunning.mockReset()
  // Any INFORMATION_SCHEMA dimension lookup returns the fixture; everything else returns no rows.
  querySnowflake.mockImplementation((sql: string) => {
    if (sql.includes("SEMANTIC_DIMENSIONS")) return Promise.resolve(DIMENSION_ROWS)
    return Promise.resolve([])
  })
})

afterEach(() => {
  vi.resetModules()
})

describe("querySemanticView", () => {
  it("binds filter values instead of interpolating them", async () => {
    const { querySemanticView } = await loadSc()
    await querySemanticView({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["order_fulfillment.otd_pct"],
      filters: [
        { ref: "calendar.cal_date", op: ">=", value: "2026-08-01" },
        { ref: "calendar.is_future", op: "=", value: 0 },
      ],
    })

    const call = querySnowflake.mock.calls.find(([sql]) => String(sql).includes("SEMANTIC_VIEW"))
    expect(call).toBeDefined()
    const [sql, options] = call!
    expect(sql).toContain("WHERE calendar.cal_date >= ? AND calendar.is_future = ?")
    // The literal must not appear in the SQL text at all.
    expect(sql).not.toContain("2026-08-01")
    expect(options.binds).toEqual(["2026-08-01", 0])
  })

  it("renders IN with one placeholder per value", async () => {
    const { querySemanticView } = await loadSc()
    await querySemanticView({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["order_fulfillment.otd_pct"],
      filters: [{ ref: "part.product_family", op: "IN", value: ["Tapes", "Films"] }],
    })
    const [sql, options] = querySnowflake.mock.calls.find(([s]) => String(s).includes("SEMANTIC_VIEW"))!
    expect(sql).toContain("part.product_family IN (?, ?)")
    expect(options.binds).toEqual(["Tapes", "Films"])
  })

  it("rejects a filter on a dimension the view does not expose", async () => {
    const { querySemanticView } = await loadSc()
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["order_fulfillment.otd_pct"],
        filters: [{ ref: "customer.credit_limit", op: "=", value: 1 }],
      }),
    ).rejects.toThrow(/Unknown filter dimension/)
  })

  it.each([
    ["calendar.cal_date; DROP TABLE x", "semicolon"],
    ["calendar.cal_date OR 1=1", "boolean tautology"],
    ["(SELECT 1)", "subquery"],
    ["calendar.cal_date--", "comment"],
    ["cal date", "whitespace"],
  ])("rejects %s as a filter dimension (%s)", async (ref) => {
    const { querySemanticView } = await loadSc()
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["order_fulfillment.otd_pct"],
        filters: [{ ref, op: "=", value: 1 }],
      }),
    ).rejects.toThrow(/Invalid filter dimension|Unknown filter dimension/)
  })

  it.each([
    ["otd_pct; DELETE FROM t", "semicolon"],
    ["otd_pct, (SELECT 1)", "extra expression"],
    ["*", "wildcard"],
  ])("rejects %s as a metric reference (%s)", async (metric) => {
    const { querySemanticView } = await loadSc()
    await expect(
      querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: [metric] }),
    ).rejects.toThrow(/Invalid metric/)
  })

  it("rejects an unsupported operator", async () => {
    const { querySemanticView } = await loadSc()
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["order_fulfillment.otd_pct"],
        // Deliberately outside the allowed set; cast because the type already forbids it.
        filters: [{ ref: "calendar.cal_date", op: "LIKE" as never, value: "%x%" }],
      }),
    ).rejects.toThrow(/Unsupported filter operator/)
  })

  it("requires at least one metric", async () => {
    const { querySemanticView } = await loadSc()
    await expect(querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: [] })).rejects.toThrow(
      /At least one metric/,
    )
  })

  it("rejects a list value for a scalar operator", async () => {
    const { querySemanticView } = await loadSc()
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["order_fulfillment.otd_pct"],
        filters: [{ ref: "calendar.cal_date", op: ">=", value: ["a", "b"] }],
      }),
    ).rejects.toThrow(/takes a single value/)
  })

  it("emits no WHERE clause when there are no filters", async () => {
    const { querySemanticView } = await loadSc()
    await querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: ["order_fulfillment.otd_pct"] })
    const [sql] = querySnowflake.mock.calls.find(([s]) => String(s).includes("SEMANTIC_VIEW"))!
    expect(sql).not.toContain("WHERE")
  })
})

describe("semanticViewSql", () => {
  it("shows the same predicates as the executed query, with values inlined for display", async () => {
    const { semanticViewSql } = await loadSc()
    const sql = semanticViewSql({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["order_fulfillment.otd_pct"],
      dimensions: ["part.product_family"],
      filters: [
        { ref: "calendar.cal_date", op: ">=", value: "2026-08-01" },
        { ref: "calendar.is_future", op: "=", value: 0 },
      ],
    })
    expect(sql).toContain("DIMENSIONS part.product_family")
    expect(sql).toContain("METRICS order_fulfillment.otd_pct")
    expect(sql).toContain("calendar.cal_date >= '2026-08-01'")
    expect(sql).toContain("calendar.is_future = 0")
  })

  it("escapes quotes so a displayed value cannot break out of the string literal", async () => {
    const { semanticViewSql } = await loadSc()
    const sql = semanticViewSql({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["order_fulfillment.otd_pct"],
      filters: [{ ref: "part.product_family", op: "=", value: "O'Brien" }],
    })
    expect(sql).toContain("'O''Brien'")
  })
})

describe("partitionByAsOfScope", () => {
  it("separates snapshot balances from event metrics", async () => {
    const { partitionByAsOfScope } = await loadSc()
    const registry = new Map([
      ["otd_pct", { asOfScope: "REALIZED" }],
      ["days_of_inventory", { asOfScope: "SNAPSHOT" }],
      ["unregistered", { asOfScope: null }],
    ] as never)
    const { realized, snapshot } = partitionByAsOfScope(
      [{ metricId: "otd_pct" }, { metricId: "days_of_inventory" }, { metricId: "unregistered" }],
      registry as never,
    )
    expect(realized.map((r) => r.metricId)).toEqual(["otd_pct", "unregistered"])
    expect(snapshot.map((r) => r.metricId)).toEqual(["days_of_inventory"])
  })
})

describe("dimension reference cache", () => {
  it("reads INFORMATION_SCHEMA once per semantic view", async () => {
    const { querySemanticView } = await loadSc()
    const filters = [{ ref: "calendar.is_future" as const, op: "=" as const, value: 0 }]
    await querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: ["a.b"], filters })
    await querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: ["a.c"], filters })
    const dimLookups = querySnowflake.mock.calls.filter(([sql]) =>
      String(sql).includes("SEMANTIC_DIMENSIONS"),
    )
    expect(dimLookups).toHaveLength(1)
  })
})
