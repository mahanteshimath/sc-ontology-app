/**
 * One formatter for governed metric values.
 *
 * WHY THIS EXISTS. There were four independent copies of this logic, and all four
 * tested for unit strings the registry does not emit. GOVERNANCE.METRIC_DEFINITION
 * stores `ratio`, `usd` and `days`; every copy branched on `"percent"`,
 * `"USD"` and `"USD per unit"`. Only `days` ever matched.
 *
 * The dashboards hid the defect because they pass hardcoded display literals
 * ("percent", "USD") rather than the registry value. The two places that pass the
 * registry value through — /ask and the home-page sparkline axis — rendered
 * on-time delivery as `0.8855` instead of `88.55%`, and landed cost as a bare
 * number with no currency marker.
 *
 * So this accepts BOTH vocabularies and normalises first. A metric's unit is
 * governed metadata; how many of its synonyms a given component happens to know
 * about should not decide whether the number is readable.
 */

export type CanonicalUnit = "ratio" | "usd" | "usd_per_unit" | "days" | "count" | "other"

/**
 * Map any unit spelling in use to a canonical one.
 *
 * Both the registry vocabulary (`ratio`, `usd`, `days`) and the display literals the
 * dashboard pages pass (`percent`, `USD`, `USD per unit`) resolve here, which is what
 * lets one formatter serve both without changing either caller.
 */
export function normalizeUnit(unit: string | null | undefined): CanonicalUnit {
  const u = (unit ?? "").trim().toLowerCase()
  if (u === "ratio" || u === "percent" || u === "pct" || u === "percentage") return "ratio"
  if (u === "usd per unit" || u === "usd_per_unit") return "usd_per_unit"
  if (u === "usd" || u === "dollars" || u === "currency") return "usd"
  if (u === "days" || u === "day") return "days"
  if (u === "count" || u === "lines" || u === "units") return "count"
  return "other"
}

/** True when a unit is a proportion that should be rendered as a percentage. */
export function isRatioUnit(unit: string | null | undefined): boolean {
  return normalizeUnit(unit) === "ratio"
}

function money(n: number, digits: number): string {
  const sign = n < 0 ? "-" : ""
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${sign}$${Math.round(abs).toLocaleString()}`
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

/**
 * Format a metric value for reading.
 *
 * The `usd` branch chooses its precision from magnitude rather than from the unit,
 * because the registry files both totals and per-unit rates under `usd`. Landed cost
 * per unit is 10.35 and needs cents; total landed cost is 1.975e9 and needs neither
 * cents nor 10 digits. Rounding the first to `$10` would make the metric useless
 * next to its own $11.00 fail threshold.
 */
export function formatMetricValue(
  value: unknown,
  unit: string | null | undefined,
  opts: { ratioDigits?: number } = {},
): string {
  if (value === null || value === undefined || value === "") return "—"
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)

  switch (normalizeUnit(unit)) {
    case "ratio":
      return `${(n * 100).toFixed(opts.ratioDigits ?? 2)}%`
    case "days":
      return `${n.toFixed(1)} days`
    case "usd_per_unit":
      return `$${n.toFixed(2)}`
    case "usd":
      return money(n, 2)
    case "count":
      return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    default:
      return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  }
}

/**
 * How many decimals an axis tick needs, given how wide the axis is.
 *
 * WHY THE UNIT ALONE IS NOT ENOUGH. Fixed precision per unit produced axes whose ticks all read the
 * same: fill rate across product families spans 97.4%–98.2%, so five ticks rounded to whole
 * percentages every one of them to "98%". Landed cost spanning $10.21–$10.94 gave three ticks
 * reading "$10". An axis whose labels are identical conveys nothing and actively suggests the series
 * is flat when it is not.
 *
 * Precision is therefore chosen from the SPAN, so a narrow range gets the decimals it needs and a
 * wide one is not cluttered with them.
 */
export function axisDecimals(unit: string | null | undefined, span: number): number {
  const s = Math.abs(span)
  if (!Number.isFinite(s) || s === 0) return 0

  switch (normalizeUnit(unit)) {
    case "ratio": {
      // The axis is rendered in percentage points, so judge the span in those terms.
      const pts = s * 100
      if (pts >= 10) return 0
      if (pts >= 2) return 1
      return 2
    }
    case "days":
      return s >= 10 ? 0 : 1
    case "usd_per_unit":
      return s >= 5 ? 1 : 2
    case "usd":
      // Large magnitudes are abbreviated to k/M/B, where the divided span decides the decimals.
      if (s >= 1e9) return s / 1e9 >= 10 ? 0 : 1
      if (s >= 1e6) return s / 1e6 >= 10 ? 0 : 1
      if (s >= 1e3) return s / 1e3 >= 10 ? 0 : 1
      return s >= 10 ? 0 : 2
    default:
      return s >= 10 ? 0 : 2
  }
}

/**
 * Compact form for a chart axis, where horizontal space is scarce and the unit is
 * already stated in the panel heading.
 *
 * Pass `decimals` (from axisDecimals) when the axis domain is known; without it the defaults are
 * tuned for a wide range and will collapse a narrow one into repeated labels.
 */
export function formatAxisTick(value: number, unit: string | null | undefined, decimals?: number): string {
  if (!Number.isFinite(value)) return ""
  switch (normalizeUnit(unit)) {
    case "ratio":
      return `${(value * 100).toFixed(decimals ?? 0)}%`
    case "days":
      return value.toFixed(decimals ?? 0)
    case "usd_per_unit":
      return `$${value.toFixed(decimals ?? 2)}`
    case "usd": {
      const abs = Math.abs(value)
      const sign = value < 0 ? "-" : ""
      if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(decimals ?? 1)}B`
      if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(decimals ?? 0)}M`
      if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(decimals ?? 0)}k`
      return `${sign}$${abs.toFixed(decimals ?? 0)}`
    }
    default:
      return value.toLocaleString(undefined, { maximumFractionDigits: decimals ?? 2 })
  }
}

/** Human label for a unit, used as a chart panel heading. */
export function unitLabel(unit: string | null | undefined): string {
  switch (normalizeUnit(unit)) {
    case "ratio":
      return "percent"
    case "usd":
      return "US dollars"
    case "usd_per_unit":
      return "US dollars per unit"
    case "days":
      return "days"
    case "count":
      return "count"
    default:
      return unit ?? "value"
  }
}

/**
 * The name the rest of the application imports.
 *
 * Kept as the primary export because every page already calls it. It is now an alias of
 * formatMetricValue, which means the dashboards gained registry-unit support without changing a
 * single call site: `formatMetric(v, "percent")` and `formatMetric(v, "ratio")` both work.
 */
export const formatMetric = formatMetricValue

/** A bare proportion as a percentage. Used where the unit is known to be a rate. */
export function formatPercent(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === "") return "\u2014"
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${(n * 100).toFixed(digits)}%`
}

/** A count, with thousands separators and no decimals. */
export function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "\u2014"
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/**
 * Coerce a synonyms or key-list column into an array.
 *
 * Three shapes reach this, all legitimately: the Node driver hands back a real JS array for an
 * ARRAY column, a VARIANT round-trips as a JSON string, and some registry columns are plain
 * comma-separated text. Guessing wrong renders a synonym list as one long unbroken string, so all
 * three are handled rather than assuming the driver's current behaviour is permanent.
 */
export function parseSynonyms(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)

  const text = String(value).trim()
  if (!text) return []

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
    } catch {
      // Fall through to delimiter splitting: a malformed JSON-looking string is still more useful
      // split than returned whole.
    }
  }

  return text
    .replace(/^\[|\]$/g, "")
    .split(/[,|]/)
    .map((v) => v.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}
