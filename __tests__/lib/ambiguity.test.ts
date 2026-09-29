import { describe, it, expect } from "vitest"
import { disambiguate } from "../../lib/ambiguity"

const ALL = ["otd_pct", "supplier_otd_pct", "fill_rate_pct", "freight_cost_usd", "freight_invoiced_usd", "landed_cost_per_unit"]

/**
 * Each case is an AGENT_EVAL_QUESTION, so the rule is held to the same questions that score it.
 * The ambiguous ones must expand; every currently-passing question must be left exactly as resolved.
 */
describe("disambiguate - expands the genuinely ambiguous", () => {
  it("Q54: unqualified on-time delivery answers both sides", () => {
    const r = disambiguate("What is our on-time delivery?", ["otd_pct"], ALL)
    expect(r.metricIds).toEqual(["otd_pct", "supplier_otd_pct"])
    expect(r.note).toMatch(/inbound/)
  })
  it("Q55: unqualified freight cost answers accrued and invoiced", () => {
    const r = disambiguate("What are our freight costs?", ["freight_cost_usd"], ALL)
    expect(r.metricIds).toEqual(["freight_cost_usd", "freight_invoiced_usd"])
  })
})

describe("disambiguate - leaves resolved questions alone", () => {
  const unchanged: [string, string[]][] = [
    ["What is our supplier on-time delivery?", ["supplier_otd_pct"]], // Q01
    ["What is our on-time delivery to customers?", ["otd_pct"]], // Q06
    ["Which product families are we delivering late?", ["otd_pct"]], // Q07
    ["Show me fill rate and on-time delivery together.", ["fill_rate_pct", "otd_pct"]], // Q14 - more than one
    ["What did we accrue for freight this period?", ["freight_cost_usd"]], // Q25
    ["Which product families will miss their on-time delivery target next month?", ["otd_pct"]], // Q44
    ["What was our on-time delivery last month, including orders due next week?", ["otd_pct"]], // Q60
    ["How much more does expedited freight cost us?", ["landed_cost_per_unit"]], // Q20
  ]
  for (const [q, ids] of unchanged) {
    it(q, () => {
      const r = disambiguate(q, ids, ALL)
      expect(r.metricIds).toEqual(ids)
      expect(r.note).toBeNull()
    })
  }

  it("never adds a metric the persona is not granted", () => {
    const r = disambiguate("What is our on-time delivery?", ["otd_pct"], ["otd_pct", "fill_rate_pct"])
    expect(r.metricIds).toEqual(["otd_pct"])
  })
})
