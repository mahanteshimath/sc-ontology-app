import { describe, it, expect } from "vitest"
import { validateExceptionWhere, validateOrderBy } from "@/lib/sql-guard"

const COLS = new Set([
  "IS_ON_TIME", "ORDERED_QTY", "RECEIVED_QTY", "SHIPPED_QTY", "TOTAL_LANDED_COST",
  "ON_HAND_QTY", "AVG_DAILY_DEMAND", "SAFETY_STOCK", "IS_STOCKED_OUT", "DELIVERY_DATE",
])

describe("sql-guard: production exception rules pass", () => {
  it.each([
    "IS_ON_TIME = 0",
    "RECEIVED_QTY < ORDERED_QTY",
    "SHIPPED_QTY > 0 AND TOTAL_LANDED_COST / SHIPPED_QTY > 15",
    "AVG_DAILY_DEMAND > 0 AND ON_HAND_QTY / AVG_DAILY_DEMAND > 60",
    "IS_STOCKED_OUT = 1 OR ON_HAND_QTY < SAFETY_STOCK",
  ])("predicate %s", (w) => expect(validateExceptionWhere(w, COLS)).toBe(w))

  it.each(["DELIVERY_DATE DESC", "(ORDERED_QTY - RECEIVED_QTY) DESC", "ON_HAND_QTY ASC NULLS LAST"])(
    "order by %s",
    (o) => expect(validateOrderBy(o, COLS)).toBe(o),
  )
})

describe("sql-guard: injection attempts are rejected", () => {
  it.each([
    "IS_ON_TIME = 0; DROP TABLE X",
    "IS_ON_TIME = 0 -- comment",
    "IS_ON_TIME = 0 /* x */",
    "IS_ON_TIME = 0 OR 1 IN (SELECT 1)",
    "IS_ON_TIME = 0 UNION SELECT PASSWORD",
    "SYSTEM$WHITELIST() = 1",
    "UNKNOWN_COL = 1",
    "(IS_ON_TIME = 0",
    "",
  ])("predicate %s", (w) => expect(() => validateExceptionWhere(w, COLS)).toThrow())

  it.each(["DELIVERY_DATE; DROP TABLE X", "RANDOM()", "NOPE DESC"])("order by %s", (o) =>
    expect(() => validateOrderBy(o, COLS)).toThrow(),
  )
})
