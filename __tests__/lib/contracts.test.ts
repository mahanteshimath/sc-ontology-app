import { describe, it, expect, vi, beforeEach } from "vitest"
import { getContractImpact, getContractBreaches, getImpactScorecard } from "../../lib/sc"

/**
 * The contract and impact readers are thin by design - every figure is computed in a governed
 * view - so what must not regress is the mapping: a renamed column silently becomes null on the
 * page, which reads as "no penalty" rather than as a bug.
 */

// vi.hoisted so the mock factory (hoisted above the imports) can reference it.
const querySnowflake = vi.hoisted(() => vi.fn())
vi.mock("@/lib/snowflake", () => ({
  querySnowflake: (...a: unknown[]) => querySnowflake(...a),
  querySnowflakeLongRunning: vi.fn(),
}))

beforeEach(() => querySnowflake.mockReset())

describe("getContractImpact", () => {
  it("maps V_CONTRACT_IMPACT, keeping money as numbers", async () => {
    querySnowflake.mockResolvedValue([
      {
        CONTRACTS: 300, BREACHES_GOVERNED: 67, BREACHES_LEGACY: 49, HIDDEN_BREACHES: 18,
        PENALTY_EXPOSURE_USD: "815222.03", PENALTY_MISSED_BY_LEGACY_USD: 178831.92,
        DEFINITION_CONFLICTS: 79, NEEDS_REVIEW: 0, EXTRACTION_ACCURACY: 1,
      },
    ])
    const r = await getContractImpact()
    expect(r).toMatchObject({ contracts: 300, hiddenBreaches: 18, penaltyExposureUsd: 815222.03, extractionAccuracy: 1 })
    expect(String(querySnowflake.mock.calls[0][0])).toContain("GOVERNANCE.V_CONTRACT_IMPACT")
  })

  it("returns null when the contract layer is not built", async () => {
    querySnowflake.mockResolvedValue([])
    expect(await getContractImpact()).toBeNull()
  })
})

describe("getContractBreaches", () => {
  it("binds the limit rather than interpolating it, and lists hidden breaches first", async () => {
    querySnowflake.mockResolvedValue([])
    await getContractBreaches(5)
    const [sql, opts] = querySnowflake.mock.calls[0]
    expect(opts).toEqual({ binds: [5] })
    expect(sql).toMatch(/LIMIT \?/)
    expect(sql).toMatch(/ORDER BY IFF\(c\.compliance_status = 'HIDDEN_BREACH', 0, 1\)/)
  })
})

describe("getImpactScorecard", () => {
  it("preserves the MEASURED / ASSUMPTION label on every row", async () => {
    querySnowflake.mockResolvedValue([
      { ORD: 1, PILLAR: "Consistency", MEASURE: "m", VALUE: "15 / 15", BASIS: "MEASURED", SOURCE_OBJECT: "METRIC_DRIFT_RESULT" },
      { ORD: 12, PILLAR: "Time", MEASURE: "baseline", VALUE: "4 h", BASIS: "ASSUMPTION", SOURCE_OBJECT: "replace" },
    ])
    const rows = await getImpactScorecard()
    expect(rows.map((r) => r.basis)).toEqual(["MEASURED", "ASSUMPTION"])
    expect(rows[1].sourceObject).toBe("replace")
  })
})
