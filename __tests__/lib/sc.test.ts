import { describe, it, expect } from "vitest"
import { semanticViewSql, querySemanticView, num, toIso } from "../../lib/sc"
import { parseSynonyms, formatMetric } from "../../lib/format"

/**
 * These cover the parts of the governed layer that must not regress silently:
 * identifier validation on generated SQL, and the coercion of Snowflake's loosely
 * typed return values.
 */

describe("semanticViewSql", () => {
  it("emits a metrics-only query when no dimension is given", () => {
    const sql = semanticViewSql({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["purchase_order.supplier_otd_pct"],
    })
    expect(sql).toContain("SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360")
    expect(sql).toContain("METRICS purchase_order.supplier_otd_pct")
    expect(sql).not.toContain("DIMENSIONS")
  })

  it("includes dimensions and ordering when supplied", () => {
    const sql = semanticViewSql({
      semanticView: "SC_ONTOLOGY_360",
      metrics: ["order_fulfillment.otd_pct", "inventory.days_of_inventory"],
      dimensions: ["part.product_family"],
      orderBy: "product_family",
    })
    expect(sql).toContain("DIMENSIONS part.product_family")
    expect(sql).toContain("METRICS order_fulfillment.otd_pct, inventory.days_of_inventory")
    expect(sql).toContain("ORDER BY product_family")
  })
})

describe("querySemanticView identifier validation", () => {
  it("rejects a metric reference containing SQL", async () => {
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["x.y) UNION SELECT * FROM SUPPLY_CHAIN.RAW.SUPPLIER --"],
      }),
    ).rejects.toThrow(/Invalid metric/)
  })

  it("rejects a semantic view name containing a quote", async () => {
    await expect(
      querySemanticView({ semanticView: "SC'; DROP TABLE x --", metrics: ["a.b"] }),
    ).rejects.toThrow(/Invalid semantic view/)
  })

  it("rejects a dimension with a nested path", async () => {
    await expect(
      querySemanticView({
        semanticView: "SC_ONTOLOGY_360",
        metrics: ["a.b"],
        dimensions: ["a.b.c"],
      }),
    ).rejects.toThrow(/Invalid dimension/)
  })

  it("requires at least one metric", async () => {
    await expect(querySemanticView({ semanticView: "SC_ONTOLOGY_360", metrics: [] })).rejects.toThrow(
      /At least one metric/,
    )
  })
})

describe("num", () => {
  it("coerces the string form Snowflake returns for high-precision numbers", () => {
    expect(num("0.849595")).toBe(0.849595)
  })
  it("passes numbers through", () => {
    expect(num(28.76275)).toBe(28.76275)
  })
  it("returns null for null, undefined and non-numeric text", () => {
    expect(num(null)).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num("not a number")).toBeNull()
  })
})

describe("toIso", () => {
  it("converts the Date objects the Node SDK returns for TIMESTAMP columns", () => {
    const d = new Date("2026-09-19T12:34:56.000Z")
    expect(toIso(d)).toBe("2026-09-19T12:34:56.000Z")
    expect(toIso(d)?.slice(0, 10)).toBe("2026-09-19")
  })
  it("returns null for empty values", () => {
    expect(toIso(null)).toBeNull()
  })
})

describe("parseSynonyms", () => {
  it("accepts a JS array, which is what the SDK returns for ARRAY columns", () => {
    expect(parseSynonyms(["supplier", "vendor"])).toEqual(["supplier", "vendor"])
  })
  it("accepts a JSON string", () => {
    expect(parseSynonyms('["part","material","sku"]')).toEqual(["part", "material", "sku"])
  })
  it("accepts a bare comma-separated string", () => {
    expect(parseSynonyms("part,material")).toEqual(["part", "material"])
  })
  it("returns an empty list for null", () => {
    expect(parseSynonyms(null)).toEqual([])
  })
})

describe("formatMetric", () => {
  it("formats a rate as a percentage", () => {
    expect(formatMetric(0.849595, "percent")).toBe("84.96%")
  })
  it("abbreviates large dollar amounts", () => {
    expect(formatMetric(9673031075.34, "USD")).toBe("$9.67B")
  })
  it("formats days and unit costs", () => {
    expect(formatMetric(28.76275, "days")).toBe("28.8 days")
    expect(formatMetric(10.39672214, "USD per unit")).toBe("$10.40")
  })
  it("renders a dash for a missing value", () => {
    expect(formatMetric(null, "percent")).toBe("—")
  })
})
