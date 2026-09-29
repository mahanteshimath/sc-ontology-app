export interface LandingFactSummary {
  governedMetrics: number
  ontologyEntities: number
  driftTarget: string
}

export interface LandingFactInput {
  registry: Array<{ metricId?: string }>
  entities: Array<{ entity?: string }>
}

/**
 * Landing-page fact summary should reflect the live governed catalogue, not marketing literals.
 * The drift target is intentionally a single invariant for this page: a zero-spread drift test is
 * the control target the app presents to users.
 */
export function summarizeLandingFacts({ registry, entities }: LandingFactInput): LandingFactSummary {
  return {
    governedMetrics: registry.length,
    ontologyEntities: entities.length,
    driftTarget: "0 spread",
  }
}
