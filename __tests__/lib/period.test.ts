/**
 * Period resolution and target assessment.
 *
 * Both are pure functions that decide what a number means: which rows are in scope, and whether the
 * result is good. Getting either wrong produces a plausible-looking figure that is wrong, which is
 * the failure mode this project exists to prevent, so they are tested directly.
 */

import { describe, it, expect } from "vitest"
import { resolvePeriod, periodFilters, snapshotFilters, priorPeriod, yearAgoPeriod, trendPeriod } from "../../lib/period"
import { assessTarget } from "../../lib/target"

// A fixed as-of date keeps these assertions stable regardless of when the suite runs.
const AS_OF = "2026-09-20"

describe("resolvePeriod", () => {
  it("treats 'this month' as month-to-date, not the whole month", () => {
    const p = resolvePeriod({ id: "mtd", asOf: AS_OF })
    expect(p.from).toBe("2026-09-01")
    expect(p.to).toBe(AS_OF)
  })

  it("returns the last complete calendar month for 'last-month'", () => {
    const p = resolvePeriod({ id: "last-month", asOf: AS_OF })
    expect(p.from).toBe("2026-08-01")
    expect(p.to).toBe("2026-08-31")
  })

  it("uses complete months only for trailing windows", () => {
    const t3 = resolvePeriod({ id: "t3m", asOf: AS_OF })
    expect(t3.from).toBe("2026-06-01")
    // Ends the day before the current month starts, so September is excluded.
    expect(t3.to).toBe("2026-08-31")

    const t12 = resolvePeriod({ id: "t12m", asOf: AS_OF })
    expect(t12.from).toBe("2025-09-01")
    expect(t12.to).toBe("2026-08-31")
  })

  it("defaults to trailing 12 months when the id is missing or unrecognised", () => {
    expect(resolvePeriod({ asOf: AS_OF }).id).toBe("t12m")
    expect(resolvePeriod({ id: "nonsense", asOf: AS_OF }).id).toBe("t12m")
  })

  it("clamps a custom range that runs past the as-of date", () => {
    const p = resolvePeriod({ from: "2026-01-01", to: "2027-12-31", asOf: AS_OF })
    expect(p.id).toBe("custom")
    expect(p.to).toBe(AS_OF)
  })

  it("says so in the description when it clamped the end", () => {
    // A shorter window than the user asked for has to be explained, not silently substituted.
    const p = resolvePeriod({ from: "2026-01-01", to: "2027-12-31", asOf: AS_OF })
    expect(p.description).toContain("clamped to as-of")
  })

  it("does not clamp, or annotate, a range that already ends before the as-of date", () => {
    const p = resolvePeriod({ from: "2026-01-01", to: "2026-03-31", asOf: AS_OF })
    expect(p.to).toBe("2026-03-31")
    expect(p.description).not.toContain("clamped")
  })

  it("ignores an incoherent custom range rather than inverting it", () => {
    const p = resolvePeriod({ from: "2026-09-01", to: "2026-01-01", asOf: AS_OF })
    expect(p.id).toBe("t12m")
  })

  it("ignores a custom range that lies entirely in the future", () => {
    /*
     * The regression this guards: coherence used to be checked only on the raw input, so this range
     * passed `from <= to`, then had its end clamped back to the as-of date and came out inverted —
     * described as "2027-01-01 to 2026-09-20" and filtered with from > to, which no row can match.
     */
    const p = resolvePeriod({ from: "2027-01-01", to: "2027-03-31", asOf: AS_OF })
    expect(p.id).toBe("t12m")
  })

  it("never returns a range whose start is after its end", () => {
    // Property check over the boundary: one day either side of the as-of date, and on it.
    for (const from of ["2026-09-19", AS_OF, "2026-09-21", "2030-01-01"]) {
      const p = resolvePeriod({ from, to: "2031-12-31", asOf: AS_OF })
      expect(p.from === null || p.to === null || p.from <= p.to).toBe(true)
    }
  })

  it("accepts a single-day range ending exactly on the as-of date", () => {
    const p = resolvePeriod({ from: AS_OF, to: AS_OF, asOf: AS_OF })
    expect(p.id).toBe("custom")
    expect(p.from).toBe(AS_OF)
    expect(p.to).toBe(AS_OF)
  })

  it("ignores malformed dates", () => {
    const p = resolvePeriod({ from: "not-a-date", to: "2026-09-01", asOf: AS_OF })
    expect(p.id).toBe("t12m")
  })

  it("leaves 'all history' unbounded at the start but still capped at the as-of date", () => {
    const p = resolvePeriod({ id: "all", asOf: AS_OF })
    expect(p.from).toBeNull()
    expect(p.to).toBe(AS_OF)
  })
})

describe("periodFilters", () => {
  it("excludes future-dated rows for realized metrics", () => {
    const filters = periodFilters(resolvePeriod({ id: "last-month", asOf: AS_OF }))
    expect(filters).toEqual([
      { ref: "calendar.cal_date", op: ">=", value: "2026-08-01" },
      { ref: "calendar.cal_date", op: "<=", value: "2026-08-31" },
      { ref: "calendar.is_future", op: "=", value: 0 },
    ])
  })

  it("omits the future-date rule when the caller opts out", () => {
    const filters = periodFilters(resolvePeriod({ id: "last-month", asOf: AS_OF }), false)
    expect(filters.some((f) => f.ref === "calendar.is_future")).toBe(false)
  })

  it("emits no lower bound for all history", () => {
    const filters = periodFilters(resolvePeriod({ id: "all", asOf: AS_OF }))
    expect(filters.filter((f) => f.op === ">=")).toHaveLength(0)
  })
})

describe("snapshotFilters", () => {
  it("pins to a single date rather than spanning a range", () => {
    expect(snapshotFilters("2026-08-31")).toEqual([
      { ref: "calendar.cal_date", op: "=", value: "2026-08-31" },
    ])
  })

  it("returns nothing when no snapshot exists, so no rows are returned rather than all of them", () => {
    expect(snapshotFilters(null)).toEqual([])
  })
})

describe("comparison periods", () => {
  it("makes the prior period the same length, immediately before", () => {
    const p = resolvePeriod({ id: "last-month", asOf: AS_OF })
    const prev = priorPeriod(p)!
    expect(prev.from).toBe("2026-07-01")
    expect(prev.to).toBe("2026-07-31")
  })

  it("shifts the year-ago period back exactly one year", () => {
    const p = resolvePeriod({ id: "last-month", asOf: AS_OF })
    const ly = yearAgoPeriod(p)!
    expect(ly.from).toBe("2025-08-01")
    expect(ly.to).toBe("2025-08-31")
  })

  it("has no comparison period for all history", () => {
    const p = resolvePeriod({ id: "all", asOf: AS_OF })
    expect(priorPeriod(p)).toBeNull()
    expect(yearAgoPeriod(p)).toBeNull()
  })

  it("keeps the trend window fixed regardless of the selected period", () => {
    const short = trendPeriod(resolvePeriod({ id: "mtd", asOf: AS_OF }), 12)
    const long = trendPeriod(resolvePeriod({ id: "t12m", asOf: AS_OF }), 12)
    expect(short.from).toBe(long.from)
    expect(short.to).toBe(long.to)
  })
})

describe("assessTarget", () => {
  const thresholds = { warnThreshold: 0.87, failThreshold: 0.85 }

  it("treats higher as better by default", () => {
    expect(assessTarget({ value: 0.91, target: 0.9, ...thresholds, direction: "higher" }).state).toBe("on-target")
    expect(assessTarget({ value: 0.88, target: 0.9, ...thresholds, direction: "higher" }).state).toBe("warn")
    expect(assessTarget({ value: 0.8, target: 0.9, ...thresholds, direction: "higher" }).state).toBe("off-target")
  })

  it("inverts the comparison for lower-is-better metrics", () => {
    // $9 against a $10 target is good for a cost metric and bad for a service metric.
    const cost = assessTarget({
      value: 9,
      target: 10,
      warnThreshold: 10.5,
      failThreshold: 11,
      direction: "lower",
    })
    expect(cost.state).toBe("on-target")

    const expensive = assessTarget({
      value: 12,
      target: 10,
      warnThreshold: 10.5,
      failThreshold: 11,
      direction: "lower",
    })
    expect(expensive.state).toBe("off-target")
  })

  it("judges 'to zero' metrics on magnitude, so a large negative is not a pass", () => {
    const over = assessTarget({ value: 5_000_000, target: 0, warnThreshold: 1e6, failThreshold: 3e6, direction: "to zero" })
    const under = assessTarget({ value: -5_000_000, target: 0, warnThreshold: 1e6, failThreshold: 3e6, direction: "to zero" })
    expect(over.state).toBe("off-target")
    expect(under.state).toBe("off-target")

    const fine = assessTarget({ value: 100, target: 0, warnThreshold: 1e6, failThreshold: 3e6, direction: "to zero" })
    expect(fine.state).toBe("on-target")
  })

  it("reports no state when there is no target, rather than implying success", () => {
    const a = assessTarget({ value: 0.5, target: null, warnThreshold: null, failThreshold: null, direction: "higher" })
    expect(a.state).toBe("none")
    expect(a.delta).toBeNull()
  })

  it("reports no state when there is no value", () => {
    expect(
      assessTarget({ value: null, target: 0.9, ...thresholds, direction: "higher" }).state,
    ).toBe("none")
  })

  it("returns a signed delta in the metric's own unit", () => {
    const a = assessTarget({ value: 0.88, target: 0.9, ...thresholds, direction: "higher" })
    expect(a.delta).toBeCloseTo(-0.02, 10)
  })

  it("treats a missed target with no thresholds as off-target, not amber", () => {
    const a = assessTarget({
      value: 0.5,
      target: 0.9,
      warnThreshold: null,
      failThreshold: null,
      direction: "higher",
    })
    expect(a.state).toBe("off-target")
  })
})
