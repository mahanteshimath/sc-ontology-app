import { describe, it, expect } from "vitest"
import { normalizeTranscript, toMono, aggregateProgress } from "../../lib/voice"

/**
 * A misheard metric name reaches the resolver as an unknown word and the question is refused as
 * off-ontology, so the vocabulary repair is what decides whether voice works at all.
 */
describe("normalizeTranscript", () => {
  it("repairs the acronyms Whisper mishears", () => {
    expect(normalizeTranscript("what is our oh tiff by region")).toBe("what is our OTIF by region?")
    expect(normalizeTranscript("show p p v for APAC suppliers")).toBe("show PPV for APAC suppliers?")
    expect(normalizeTranscript("O.T.D. for E.U. customers")).toBe("OTD for EU customers")
  })

  it("canonicalises multi-word metric names", () => {
    expect(normalizeTranscript("What is our fill-rate and land costs?")).toBe("What is our fill rate and landed cost?")
    expect(normalizeTranscript("supplier on time delivery")).toBe("supplier on-time delivery")
  })

  it("drops non-speech tags and collapses whitespace", () => {
    expect(normalizeTranscript(" [BLANK_AUDIO]  ")).toBe("")
    expect(normalizeTranscript("(music) Which   suppliers are late")).toBe("Which suppliers are late?")
  })

  it("does not add a question mark to a statement", () => {
    expect(normalizeTranscript("Days of inventory by node")).toBe("Days of inventory by node")
  })
})

describe("toMono", () => {
  it("averages channels", () => {
    const m = toMono([new Float32Array([1, 0]), new Float32Array([0, 1])])
    expect(Array.from(m)).toEqual([0.5, 0.5])
  })
  it("passes a single channel through untouched", () => {
    const c = new Float32Array([0.1, 0.2])
    expect(toMono([c])).toBe(c)
  })
})

describe("aggregateProgress", () => {
  it("weights by bytes across every model file", () => {
    expect(aggregateProgress({ a: { loaded: 50, total: 100 }, b: { loaded: 0, total: 300 } })).toBeCloseTo(0.125)
    expect(aggregateProgress({})).toBe(0)
  })
})
