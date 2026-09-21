/**
 * Target evaluation.
 *
 * A metric's direction is what makes a comparison meaningful: 92% on-time delivery beats a 90%
 * target, but $92 of landed cost per unit misses a $90 target, and a freight bill variance is
 * judged on its distance from zero in either direction. All three live in the same registry, so
 * the sense of the comparison has to come from METRIC_DEFINITION.direction rather than from the
 * page rendering it.
 */

export type RagState = "on-target" | "warn" | "off-target" | "none"

export interface TargetAssessment {
  state: RagState
  /** Signed difference from target in the metric's own unit; positive means above target. */
  delta: number | null
  /** True when a higher number is the better outcome. Null for "to zero" metrics. */
  higherIsBetter: boolean | null
  label: string
}

/**
 * Compare a value to its governed target and thresholds.
 *
 * Thresholds are optional. With only a target, the result is a two-state on/off assessment; with
 * a warn threshold as well, the middle band becomes amber.
 */
export function assessTarget(opts: {
  value: number | null
  target: number | null
  warnThreshold: number | null
  failThreshold: number | null
  direction: string | null
}): TargetAssessment {
  const { value, target, warnThreshold, failThreshold, direction } = opts

  if (value === null || target === null) {
    return { state: "none", delta: null, higherIsBetter: null, label: "no target" }
  }

  const delta = value - target

  // "to zero" metrics (e.g. freight bill variance) are judged on magnitude, not sign.
  if (direction === "to zero") {
    const magnitude = Math.abs(value)
    const warn = warnThreshold ?? null
    const fail = failThreshold ?? null
    if (fail !== null && magnitude > Math.abs(fail)) {
      return { state: "off-target", delta, higherIsBetter: null, label: "outside tolerance" }
    }
    if (warn !== null && magnitude > Math.abs(warn)) {
      return { state: "warn", delta, higherIsBetter: null, label: "drifting from zero" }
    }
    return { state: "on-target", delta, higherIsBetter: null, label: "within tolerance" }
  }

  const higherIsBetter = direction !== "lower"

  // Normalise to "how far past the line are we, in the good direction".
  const passes = (threshold: number) => (higherIsBetter ? value >= threshold : value <= threshold)

  if (passes(target)) {
    return { state: "on-target", delta, higherIsBetter, label: "at or better than target" }
  }
  if (warnThreshold !== null && passes(warnThreshold)) {
    return { state: "warn", delta, higherIsBetter, label: "below target" }
  }
  if (failThreshold !== null && !passes(failThreshold)) {
    return { state: "off-target", delta, higherIsBetter, label: "below minimum" }
  }
  // No thresholds configured: missing the target is simply off-target.
  return {
    state: warnThreshold === null && failThreshold === null ? "off-target" : "warn",
    delta,
    higherIsBetter,
    label: "below target",
  }
}

/** Tailwind text colour for a RAG state. */
export function ragTextClass(state: RagState): string {
  switch (state) {
    case "on-target":
      return "u-good"
    case "warn":
      return "u-warn"
    case "off-target":
      return "u-bad"
    default:
      return "text-muted-foreground"
  }
}

/** Tailwind border/background for a RAG state, for pills and card edges. */
export function ragChipClass(state: RagState): string {
  switch (state) {
    case "on-target":
      return "u-chip-good"
    case "warn":
      return "u-chip-warn"
    case "off-target":
      return "u-chip-bad"
    default:
      return "u-chip-neutral"
  }
}

/** Solid dot colour for a RAG state, matching the drift pill's visual language. */
export function ragDotClass(state: RagState): string {
  switch (state) {
    case "on-target":
      return "u-dot-good"
    case "warn":
      return "u-dot-warn"
    case "off-target":
      return "u-dot-bad"
    default:
      return "u-dot-neutral"
  }
}
