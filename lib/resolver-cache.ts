/**
 * Reuses a resolver MAPPING (question -> metric ids + dimension), never a number.
 *
 * The AI_COMPLETE call that maps a question onto the registry is the single largest cost in
 * /api/ask, and in a demo or a standing dashboard the same questions arrive again and again. The
 * mapping is a pure function of the prompt, so it can be reused safely as long as the key covers
 * every input the prompt is built from: the model, the catalogue this persona is offered, the
 * metrics it is denied, the dimensions, the conversation and the reporting period. Change any of
 * them — a new registry row, a revoked grant, a different persona — and the key changes with it.
 *
 * What is NOT cached is everything the project is actually about: the governed SQL still executes
 * under the persona's own role on every turn, against the live semantic view, so a cached mapping
 * can never produce a stale or wrongly-scoped value. Responses report `resolverCached` so the UI
 * can say so rather than implying the model was consulted.
 */

import { createHash } from "node:crypto"

/** Long enough to cover a demo or a working session; short enough that prompt tuning is visible. */
export const RESOLVER_CACHE_TTL_MS = 15 * 60_000
const MAX_ENTRIES = 500

interface Entry<T> {
  value: T
  expiresAt: number
}

const store = new Map<string, Entry<unknown>>()

/** Case, whitespace and trailing punctuation do not change what a question asks. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").replace(/[\s?.!]+$/, "").trim()
}

export function resolverCacheKey(parts: {
  model: string
  question: string
  catalogue: string
  dimensions: string
  denied: string
  conversation: string
  period: string
}): string {
  const material = JSON.stringify([
    parts.model,
    normalizeQuestion(parts.question),
    parts.catalogue,
    parts.dimensions,
    parts.denied,
    parts.conversation,
    parts.period,
  ])
  return createHash("sha256").update(material).digest("hex")
}

/** Returns a copy, so a caller that decorates the result cannot alter what the next caller sees. */
export function getCachedResolution<T>(key: string): T | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }
  // Refresh recency so the eviction below is least-recently-used, not least-recently-inserted.
  store.delete(key)
  store.set(key, hit)
  return structuredClone(hit.value) as T
}

export function setCachedResolution<T>(key: string, value: T): void {
  store.delete(key)
  store.set(key, { value: structuredClone(value), expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS })
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export function clearResolverCache(): void {
  store.clear()
}
