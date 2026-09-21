import { describe, it, expect, vi, beforeEach } from "vitest"

const querySnowflake = vi.fn()

vi.mock("../../lib/sc", () => ({
  querySnowflake: (...a: unknown[]) => querySnowflake(...a),
}))

import { findUnverifiableNumbers, templateNarration } from "../../app/api/ask/narrate/route"

/**
 * The guardrail is the reason this endpoint is allowed to exist.
 *
 * Narration sits directly beneath a number that carries full provenance and inherits its
 * credibility, so a fabricated figure in the prose is indistinguishable from a governed one to the
 * reader. These tests pin both halves of the trade-off: fabrication must be caught, and ordinary
 * rounding must NOT be — a guardrail that fires on correct prose would make the template the only
 * thing ever shown, and the reader would learn to ignore the distinction entirely.
 */

function request(body: unknown): Request {
  return new Request("http://localhost/api/ask/narrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const METRICS = [
  {
    metricId: "otd_pct",
    businessName: "On-Time Delivery",
    column: "OTD_PCT",
    unit: "ratio",
    target: 0.95,
    direction: "HIGHER",
    asOfScope: "REALIZED",
  },
]

const ROWS = [
  { PRODUCT_FAMILY: "Castings", OTD_PCT: 0.812345 },
  { PRODUCT_FAMILY: "Fasteners", OTD_PCT: 0.934567 },
]

function narrationReturns(text: string) {
  querySnowflake.mockResolvedValue([{ NARRATION: text }])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("findUnverifiableNumbers", () => {
  const allowed = new Set(["88.55", "0.885475", "88.5", "89"])

  it("accepts a figure present in the payload", () => {
    expect(findUnverifiableNumbers("On-time delivery is 88.55%.", allowed)).toEqual([])
  })

  it("flags a figure the payload cannot account for", () => {
    expect(findUnverifiableNumbers("On-time delivery is 91.20%.", allowed)).toEqual(["91.20"])
  })

  it("ignores small integers, which are counts and ordinals rather than metric values", () => {
    // "3 of 8 families" is structural. Treating it as fabrication would fire on well-formed prose.
    expect(findUnverifiableNumbers("3 of the 8 families miss target.", allowed)).toEqual([])
  })

  it("ignores a four-digit year", () => {
    expect(findUnverifiableNumbers("Performance in 2026 was steady.", allowed)).toEqual([])
  })

  it("sees through thousands separators", () => {
    const withTotal = new Set(["1975000000", "1.98"])
    expect(findUnverifiableNumbers("Landed cost reached 1,975,000,000.", withTotal)).toEqual([])
    expect(findUnverifiableNumbers("Landed cost reached 2,100,000,000.", withTotal)).toEqual([
      "2,100,000,000",
    ])
  })
})

describe("templateNarration", () => {
  it("states the value against its target for a single figure", () => {
    const text = templateNarration({
      metrics: METRICS,
      rows: [{ OTD_PCT: 0.885475 }],
      dimensionColumn: null,
      periodLabel: "August 2026",
    })
    expect(text).toContain("88.55%")
    expect(text).toContain("95.00%")
    expect(text).toMatch(/misses/)
  })

  it("reports the range and how many miss target for a breakdown", () => {
    const text = templateNarration({
      metrics: METRICS,
      rows: ROWS,
      dimensionColumn: "PRODUCT_FAMILY",
      periodLabel: "August 2026",
    })
    expect(text).toContain("Castings")
    expect(text).toContain("Fasteners")
    expect(text).toContain("2 of 2")
  })

  it("does not invent content when there are no rows", () => {
    expect(
      templateNarration({ metrics: METRICS, rows: [], dimensionColumn: null, periodLabel: "August 2026" }),
    ).toMatch(/No governed rows/)
  })
})

describe("POST /api/ask/narrate", () => {
  it("returns model prose when every figure in it checks out", async () => {
    narrationReturns(
      "On-Time Delivery ranges from 81.23% for Castings to 93.46% for Fasteners. Both sit below the 95.00% target.",
    )
    const { POST } = await import("../../app/api/ask/narrate/route")
    const body = await (
      await POST(request({ question: "OTD by family?", metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))
    ).json()

    expect(body.narrationSource).toBe("model")
    expect(body.narration).toContain("81.23%")
    expect(body.rejectedNumbers).toEqual([])
  })

  it("DISCARDS the whole response when the model invents a figure", async () => {
    // 12.23 is a gap the model computed itself. It appears nowhere in the rows.
    narrationReturns(
      "On-Time Delivery ranges from 81.23% to 93.46%, a spread of 12.23 percentage points.",
    )
    const { POST } = await import("../../app/api/ask/narrate/route")
    const body = await (
      await POST(request({ metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))
    ).json()

    expect(body.narrationSource).toBe("template")
    expect(body.rejectedNumbers).toContain("12.23")
    // The replacement is a real answer, not an error message.
    expect(body.narration).toContain("Castings")
  })

  it("tolerates rounding, so correct prose is not thrown away", async () => {
    // 81.2 and 93.5 are the payload's own values at lower precision.
    narrationReturns("On-Time Delivery runs from 81.2% to 93.5% across the two families.")
    const { POST } = await import("../../app/api/ask/narrate/route")
    const body = await (
      await POST(request({ metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))
    ).json()

    expect(body.narrationSource).toBe("model")
  })

  it("falls back to the template when the model call fails", async () => {
    querySnowflake.mockRejectedValue(new Error("model unavailable"))
    const { POST } = await import("../../app/api/ask/narrate/route")
    const res = await POST(request({ metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))
    const body = await res.json()

    // A narrator outage must not deny the user a number that is already computed.
    expect(res.status).toBe(200)
    expect(body.narrationSource).toBe("template")
  })

  it("falls back to the template when the model returns nothing", async () => {
    narrationReturns("   ")
    const { POST } = await import("../../app/api/ask/narrate/route")
    const body = await (
      await POST(request({ metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))
    ).json()
    expect(body.narrationSource).toBe("template")
  })

  it("rejects a request with no rows to describe", async () => {
    const { POST } = await import("../../app/api/ask/narrate/route")
    const res = await POST(request({ metrics: METRICS, rows: [] }))
    expect(res.status).toBe(400)
  })

  it("never asks the model to write SQL or choose a metric", async () => {
    narrationReturns("On-Time Delivery is 81.23% for Castings and 93.46% for Fasteners.")
    const { POST } = await import("../../app/api/ask/narrate/route")
    await POST(request({ metrics: METRICS, rows: ROWS, dimensionColumn: "PRODUCT_FAMILY" }))

    const prompt = String(querySnowflake.mock.calls[0]?.[1]?.binds?.[1] ?? "")
    expect(prompt).toContain("ALREADY been computed")
    expect(prompt).toMatch(/Do NOT compute/)
    expect(prompt).not.toMatch(/SELECT|SEMANTIC_VIEW/)
  })
})
