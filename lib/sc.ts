/**
 * Governed data access for the Supply Chain Ontology app.
 *
 * Every function here reads one of the governed objects:
 *   - SUPPLY_CHAIN.GOVERNANCE.*  — metric registry, ontology catalogue, drift results
 *   - SUPPLY_CHAIN.SEMANTIC.SC_* — semantic views, queried only via SEMANTIC_VIEW(...)
 *
 * There is no raw-table access and no hand-written metric arithmetic anywhere in the app:
 * a number shown in the UI always comes from a metric defined in a semantic view, which is
 * the same definition the conversational layer resolves to.
 */

import { cache } from "react"
import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import { useCallersRights } from "@/lib/env"

// Re-exported so route handlers have a single import surface for governed data access.
export { querySnowflake, querySnowflakeLongRunning }

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * Two layers of caching, for two different problems.
 *
 * PER REQUEST (React `cache`): a single page render used to call getMetricRegistry() more than
 * once — once for the page and again inside a route it invoked — and /api/ask called it twice in
 * one request. React's `cache` deduplicates identical calls within one request, which removes
 * those repeats without changing any call site.
 *
 * ACROSS REQUESTS (ttlMemo below): the registry, ontology and persona catalogue are metadata. They
 * change when someone redeploys a semantic view or edits the governance tables — not per request —
 * yet every page load was paying ~2s to re-read them, and the registry query in particular runs a
 * correlated ARRAY_AGG subquery. A short TTL keeps pages responsive while bounding how stale
 * metadata can be.
 *
 * Deliberately NOT cached: anything that returns a metric value. A cached number is a number that
 * can silently disagree with the semantic view, which is the exact failure mode this project
 * exists to prevent.
 */

/** How long metadata may be reused. Short enough that a redeploy is visible within a minute. */
const METADATA_TTL_MS = 60_000

interface MemoEntry<T> {
  value: Promise<T>
  expiresAt: number
}

const metadataCaches: (() => void)[] = []

/**
 * Wrap a metadata reader with both cache layers.
 *
 * A rejected promise is evicted rather than cached: otherwise one transient Snowflake failure
 * would poison the cache for the whole TTL and every subsequent page load would fail for a reason
 * that no longer exists.
 */
function cachedMetadata<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const store = new Map<string, MemoEntry<T>>()
  metadataCaches.push(() => store.clear())
  const memo = (...args: A): Promise<T> => {
    const key = JSON.stringify(args)
    const hit = store.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value
    const value = fn(...args)
    store.set(key, { value, expiresAt: Date.now() + METADATA_TTL_MS })
    value.catch(() => store.delete(key))
    return value
  }
  return cache(memo) as (...args: A) => Promise<T>
}

/** Drop all cached metadata. Call after changing a semantic view or a governance table. */
export function resetMetadataCache(): void {
  dimensionRefCache.clear()
  for (const reset of metadataCaches) reset()
}

/** Snowflake returns NUMBER as string or number depending on precision — normalise. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** The Node SDK returns TIMESTAMP columns as Date objects, not ISO strings. */
export function toIso(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** A semantic-view metric reference, e.g. "purchase_order.supplier_otd_pct". */
export type MetricRef = string

export interface MetricDefinition {
  metricId: string
  businessName: string
  domain: string
  definition: string
  numerator: string | null
  denominator: string | null
  grain: string
  canonicalFact: string
  canonicalSql: string
  unit: string | null
  direction: string | null
  ownerRole: string | null
  version: number | null
  effectiveFrom: string | null
  bindings: { semanticView: string; metricReference: string; personaRole: string | null }[]
  driftStatus: string | null
  driftSpread: number | null
  canonicalValue: number | null
  /** REALIZED (exclude future-dated rows) or SNAPSHOT (point-in-time, non-additive over time). */
  asOfScope: string | null
  asOfRule: string | null
  target: number | null
  warnThreshold: number | null
  failThreshold: number | null
  targetSource: string | null
}

export interface OntologyEntity {
  semanticView: string
  entity: string
  ontologyClass: string | null
  entityRole: string
  baseObject: string
  /** Snowflake may return these as arrays or strings depending on the source view. */
  primaryKeys: unknown
  synonyms: unknown
  description: string | null
  dimensionCount: number
  metricCount: number
}

export interface OntologyRelationship {
  relationshipName: string
  fromEntity: string
  toEntity: string
  fromColumns: string
  toColumns: string
}

export interface Persona {
  roleName: string
  personaLabel: string
  focus: string
  sortOrder: number
  rowScope: string
  accessibleSemanticViews: string
  viewCount: number
}

export interface DriftRow {
  metricId: string
  businessName: string
  bindingCount: number
  canonicalValue: number | null
  valueSpread: number | null
  status: string
  detail: string
  runAt: string | null
}

// ---------------------------------------------------------------------------
// Metric registry
// ---------------------------------------------------------------------------

/**
 * The governed metric catalogue, joined to its bindings and to the latest drift result.
 * This is the single source of truth the whole app renders from.
 */
export const getMetricRegistry = cachedMetadata(async function getMetricRegistry(): Promise<MetricDefinition[]> {
  const rows = await querySnowflake(`
    WITH latest AS (
      SELECT metric_id, status, value_spread, canonical_value, run_at,
             ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY run_at DESC) AS rn
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
    )
    SELECT
      d.metric_id, d.business_name, d.domain, d.definition, d.numerator, d.denominator,
      d.grain, d.canonical_fact, d.canonical_sql, d.unit, d.direction, d.owner_role,
      d.version, d.effective_from, d.as_of_scope, d.as_of_rule,
      d.target_value, d.warn_threshold, d.fail_threshold, d.target_source,
      l.status AS drift_status, l.value_spread AS drift_spread, l.canonical_value,
      (
        SELECT ARRAY_AGG(OBJECT_CONSTRUCT('sv', b.semantic_view, 'ref', b.metric_reference, 'persona', b.persona_role))
          WITHIN GROUP (ORDER BY b.semantic_view)
        FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING b
        WHERE b.metric_id = d.metric_id
      ) AS bindings
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d
    LEFT JOIN latest l ON l.metric_id = d.metric_id AND l.rn = 1
    ORDER BY d.domain, d.business_name
  `)

  return rows.map((r) => {
    const raw = r.BINDINGS
    const parsed: any[] = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
    return {
      metricId: r.METRIC_ID,
      businessName: r.BUSINESS_NAME,
      domain: r.DOMAIN,
      definition: r.DEFINITION,
      numerator: r.NUMERATOR ?? null,
      denominator: r.DENOMINATOR ?? null,
      grain: r.GRAIN,
      canonicalFact: r.CANONICAL_FACT,
      canonicalSql: r.CANONICAL_SQL,
      unit: r.UNIT ?? null,
      direction: r.DIRECTION ?? null,
      ownerRole: r.OWNER_ROLE ?? null,
      version: num(r.VERSION),
      effectiveFrom: toIso(r.EFFECTIVE_FROM)?.slice(0, 10) ?? null,
      bindings: parsed.map((b) => ({
        semanticView: b.sv,
        metricReference: b.ref,
        personaRole: b.persona ?? null,
      })),
      driftStatus: r.DRIFT_STATUS ?? null,
      driftSpread: num(r.DRIFT_SPREAD),
      canonicalValue: num(r.CANONICAL_VALUE),
      asOfScope: r.AS_OF_SCOPE ?? null,
      asOfRule: r.AS_OF_RULE ?? null,
      target: num(r.TARGET_VALUE),
      warnThreshold: num(r.WARN_THRESHOLD),
      failThreshold: num(r.FAIL_THRESHOLD),
      targetSource: r.TARGET_SOURCE ?? null,
    }
  })
})

// ---------------------------------------------------------------------------
// Ontology
// ---------------------------------------------------------------------------

export const getOntologyEntities = cachedMetadata(async function getOntologyEntities(
  semanticView: string = "SC_ONTOLOGY_360",
): Promise<OntologyEntity[]> {
  const rows = await querySnowflake(
    `SELECT semantic_view, entity, ontology_class, entity_role, base_object,
            primary_keys, synonyms, description, dimension_count, metric_count
       FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_ENTITY
      WHERE semantic_view = ?
      ORDER BY entity_role, entity`,
    { binds: [semanticView] },
  )
  return rows.map((r) => ({
    semanticView: r.SEMANTIC_VIEW,
    entity: r.ENTITY,
    ontologyClass: r.ONTOLOGY_CLASS ?? null,
    entityRole: r.ENTITY_ROLE,
    baseObject: r.BASE_OBJECT,
    primaryKeys: r.PRIMARY_KEYS ?? null,
    synonyms: r.SYNONYMS ?? null,
    description: r.DESCRIPTION ?? null,
    dimensionCount: num(r.DIMENSION_COUNT) ?? 0,    metricCount: num(r.METRIC_COUNT) ?? 0,
  }))
})

export const getOntologyRelationships = cachedMetadata(async function getOntologyRelationships(
  semanticView: string = "SC_ONTOLOGY_360",
): Promise<OntologyRelationship[]> {
  const rows = await querySnowflake(
    `SELECT relationship_name, from_entity, to_entity, from_columns, to_columns
       FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_RELATIONSHIP
      WHERE semantic_view = ?
      ORDER BY from_entity, to_entity`,
    { binds: [semanticView] },
  )
  return rows.map((r) => ({
    relationshipName: r.RELATIONSHIP_NAME,
    fromEntity: r.FROM_ENTITY,
    toEntity: r.TO_ENTITY,
    fromColumns: String(r.FROM_COLUMNS ?? ""),
    toColumns: String(r.TO_COLUMNS ?? ""),
  }))
})

/** Dimensions and metrics belonging to one ontology entity, read from INFORMATION_SCHEMA. */
export const getEntityAttributes = cachedMetadata(async function getEntityAttributes(
  semanticView: string = "SC_ONTOLOGY_360",
) {
  const rows = await querySnowflake(
    `SELECT 'DIMENSION' AS kind, table_name, name, data_type, synonyms, comment
       FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS WHERE semantic_view_name = ?
     UNION ALL
     SELECT 'METRIC', table_name, name, data_type, synonyms, comment
       FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_METRICS WHERE semantic_view_name = ?
     ORDER BY table_name, kind, name`,
    { binds: [semanticView, semanticView] },
  )
  return rows.map((r) => ({
    kind: r.KIND as "DIMENSION" | "METRIC",
    entity: r.TABLE_NAME as string,
    name: r.NAME as string,
    dataType: r.DATA_TYPE as string,
    synonyms: r.SYNONYMS ? String(r.SYNONYMS) : null,
    comment: r.COMMENT ? String(r.COMMENT) : null,
  }))
})

// ---------------------------------------------------------------------------
// Governance: drift + the recorded pre-remediation divergence
// ---------------------------------------------------------------------------

export async function getLatestDrift(): Promise<DriftRow[]> {
  // Selected by RUN_ID, not by a timestamp window. The previous version took every row written
  // within 30 seconds of the newest one, which silently mixed two runs if they overlapped and
  // could split one run that straddled the boundary. METRIC_DRIFT_TEST already stamps every row it
  // writes with a single UUID per invocation, so a run is exactly identifiable.
  const rows = await querySnowflake(`
    WITH latest_run AS (
      SELECT run_id
        FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
       QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
    )
    SELECT r.metric_id, r.business_name, r.binding_count, r.canonical_value,
           r.value_spread, r.status, r.detail, r.run_at
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
      JOIN latest_run l ON l.run_id = r.run_id
     ORDER BY r.status DESC, r.metric_id
  `)
  return rows.map((r) => ({
    metricId: r.METRIC_ID,
    businessName: r.BUSINESS_NAME,
    bindingCount: num(r.BINDING_COUNT) ?? 0,
    canonicalValue: num(r.CANONICAL_VALUE),
    valueSpread: num(r.VALUE_SPREAD),
    status: r.STATUS,
    detail: r.DETAIL,
    runAt: toIso(r.RUN_AT),
  }))
}

export interface DriftRun {
  runId: string
  runAt: string | null
  metricsChecked: number
  passed: number
  failed: number
  maxSpread: number | null
}

/**
 * One row per drift-test run, newest first.
 *
 * The table already held 96 rows of history that nothing displayed, so the control could only ever
 * show its current state. A track record is the more useful artefact: it shows the test has been
 * running, and when it last caught something.
 */
export async function getDriftHistory(limit = 30): Promise<DriftRun[]> {
  const rows = await querySnowflake(
    `SELECT run_id,
            MAX(run_at)                                  AS run_at,
            COUNT(*)                                     AS metrics_checked,
            COUNT_IF(status = 'PASS')                    AS passed,
            COUNT_IF(status <> 'PASS')                   AS failed,
            MAX(relative_spread)                         AS max_spread
       FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
      GROUP BY run_id
      ORDER BY run_at DESC
      LIMIT ?`,
    { binds: [Math.max(1, Math.floor(limit))] },
  )
  return rows.map((r) => ({
    runId: String(r.RUN_ID),
    runAt: toIso(r.RUN_AT),
    metricsChecked: num(r.METRICS_CHECKED) ?? 0,
    passed: num(r.PASSED) ?? 0,
    failed: num(r.FAILED) ?? 0,
    maxSpread: num(r.MAX_SPREAD),
  }))
}

/** The recorded before-state: supplier OTD disagreeing across two views. */
export async function getDriftBaseline() {
  const rows = await querySnowflake(
    `SELECT metric_id, semantic_view, metric_reference, observed_value,
            definition_sql, root_cause, captured_at, note
       FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_BASELINE
      ORDER BY observed_value DESC`,
  )
  return rows.map((r) => ({
    metricId: r.METRIC_ID,
    semanticView: r.SEMANTIC_VIEW,
    metricReference: r.METRIC_REFERENCE,
    observedValue: num(r.OBSERVED_VALUE),
    definitionSql: r.DEFINITION_SQL,
    rootCause: r.ROOT_CAUSE,
    capturedAt: toIso(r.CAPTURED_AT),
    note: r.NOTE,
  }))
}

/** Proof that the drift test is capable of failing, not just of passing. */
export async function getNegativeControl() {
  const rows = await querySnowflake(
    `SELECT run_at, metric_id, business_name, canonical_value, min_value, max_value,
            value_spread, status, detail, purpose
       FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_NEGATIVE_CONTROL
      ORDER BY run_at DESC LIMIT 1`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    runAt: toIso(r.RUN_AT),
    metricId: r.METRIC_ID,
    businessName: r.BUSINESS_NAME,
    canonicalValue: num(r.CANONICAL_VALUE),
    minValue: num(r.MIN_VALUE),
    maxValue: num(r.MAX_VALUE),
    valueSpread: num(r.VALUE_SPREAD),
    status: r.STATUS,
    detail: r.DETAIL,
    purpose: r.PURPOSE,
  }
}

export async function runDriftTest(): Promise<DriftRow[]> {
  // Deliberately the synchronous helper, not querySnowflakeLongRunning: an asyncExec submit of a
  // CALL to a table-returning procedure does not reliably yield a query id, so polling fails with
  // "A query id/statement id must be specified." The driver blocks here for the ~30-60s the
  // procedure takes, which is correct for a server-side route.
  await querySnowflake(`CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST()`)
  // The registry carries each metric's latest drift status, so a cached copy is stale the moment
  // the test writes new results.
  resetMetadataCache()
  return getLatestDrift()
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export const getPersonas = cachedMetadata(async function getPersonas(): Promise<Persona[]> {
  const rows = await querySnowflake(
    `SELECT role_name, persona_label, focus, sort_order, row_scope,
            accessible_semantic_views, view_count
       FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG ORDER BY sort_order`,
  )
  return rows.map((r) => ({
    roleName: r.ROLE_NAME,
    personaLabel: r.PERSONA_LABEL,
    focus: r.FOCUS,
    sortOrder: num(r.SORT_ORDER) ?? 0,
    rowScope: r.ROW_SCOPE,
    accessibleSemanticViews: r.ACCESSIBLE_SEMANTIC_VIEWS ?? "",
    viewCount: num(r.VIEW_COUNT) ?? 0,
  }))
})

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

/** Metric and dimension references are validated against the registry before use. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/

function assertIdent(value: string, what: string): string {
  if (!IDENT.test(value)) {
    throw new Error(`Invalid ${what}: ${value}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Governed filters
// ---------------------------------------------------------------------------

/** The only comparison operators a filter may use. */
const FILTER_OPS = ["=", "<>", ">", ">=", "<", "<=", "IN"] as const
export type FilterOp = (typeof FILTER_OPS)[number]

export interface SemanticFilter {
  /** A dimension reference, e.g. "calendar.cal_date". Validated against the deployed view. */
  ref: MetricRef
  op: FilterOp
  value: string | number | (string | number)[]
}

/**
 * The dimension references a semantic view actually exposes, read from INFORMATION_SCHEMA.
 *
 * Filters are validated against this rather than against a hardcoded list, so a filter can never
 * reference a dimension the deployed view does not have — and cannot be used to smuggle an
 * arbitrary expression into the WHERE clause.
 *
 * Cached per process: the set changes when the semantic view is redeployed, not per request.
 */
const dimensionRefCache = new Map<string, Promise<Set<string>>>()

export function validDimensionRefs(semanticView: string): Promise<Set<string>> {
  const sv = assertIdent(semanticView, "semantic view")
  let cached = dimensionRefCache.get(sv)
  if (!cached) {
    cached = querySnowflake(
      `SELECT LOWER(table_name) || '.' || LOWER(name) AS ref
         FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS
        WHERE semantic_view_name = ?`,
      { binds: [sv] },
    ).then((rows) => new Set(rows.map((r) => String(r.REF))))
    dimensionRefCache.set(sv, cached)
  }
  return cached
}

/** Clear the cached dimension list. Exported for tests and for use after a redeploy. */
export function resetDimensionRefCache(): void {
  dimensionRefCache.clear()
}

/**
 * Render one filter as SQL with a `?` placeholder per value.
 *
 * Values are never interpolated into the SQL text — they are returned separately and bound by the
 * driver. Only the dimension reference and the operator appear literally, and both are validated
 * against a closed set first.
 */
function renderFilter(f: SemanticFilter, allowed: Set<string>): { sql: string; binds: unknown[] } {
  const ref = assertIdent(f.ref, "filter dimension")
  if (!allowed.has(ref.toLowerCase())) {
    throw new Error(`Unknown filter dimension: ${f.ref}`)
  }
  if (!FILTER_OPS.includes(f.op)) {
    throw new Error(`Unsupported filter operator: ${f.op}`)
  }

  if (f.op === "IN") {
    const values = Array.isArray(f.value) ? f.value : [f.value]
    if (values.length === 0) throw new Error(`IN filter on ${ref} needs at least one value`)
    if (values.length > 200) throw new Error(`IN filter on ${ref} has too many values`)
    return { sql: `${ref} IN (${values.map(() => "?").join(", ")})`, binds: values }
  }

  if (Array.isArray(f.value)) {
    throw new Error(`Operator ${f.op} on ${ref} takes a single value, not a list`)
  }
  return { sql: `${ref} ${f.op} ?`, binds: [f.value] }
}

async function buildWhere(
  semanticView: string,
  filters: SemanticFilter[] | undefined,
): Promise<{ clause: string; binds: unknown[] }> {
  if (!filters || filters.length === 0) return { clause: "", binds: [] }
  const allowed = await validDimensionRefs(semanticView)
  const parts: string[] = []
  const binds: unknown[] = []
  for (const f of filters) {
    const r = renderFilter(f, allowed)
    parts.push(r.sql)
    binds.push(...r.binds)
  }
  return { clause: ` WHERE ${parts.join(" AND ")}`, binds }
}

/** The same filter rendering, with values inlined, for display as provenance only. */
function renderFilterForDisplay(f: SemanticFilter): string {
  const lit = (v: string | number) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
  if (f.op === "IN") {
    const values = Array.isArray(f.value) ? f.value : [f.value]
    return `${f.ref} IN (${values.map(lit).join(", ")})`
  }
  return `${f.ref} ${f.op} ${lit(f.value as string | number)}`
}

// ---------------------------------------------------------------------------
// Semantic view execution
// ---------------------------------------------------------------------------

/**
 * Execute a SEMANTIC_VIEW query. Metric and dimension references are identifier-validated
 * rather than bind-parameterised because Snowflake does not accept binds for metric/dimension
 * names; only names matching a strict identifier pattern are accepted. Filter *values*, by
 * contrast, are always bound.
 *
 * The synchronous driver path is used by default. The async path polls every 5s by default,
 * which rounds a genuinely 1.5s query up to ~6.6s of wall clock — that latency is wasted on
 * these queries, all of which return a handful of aggregate rows. Pass `long` only for
 * statements that really can run for minutes; it uses a 1s poll so it stays responsive.
 */
export async function querySemanticView(opts: {
  semanticView: string
  metrics: MetricRef[]
  dimensions?: MetricRef[]
  filters?: SemanticFilter[]
  orderBy?: string
  limit?: number
  long?: boolean
}): Promise<Record<string, any>[]> {
  const sv = assertIdent(opts.semanticView, "semantic view")
  const metrics = opts.metrics.map((m) => assertIdent(m, "metric"))
  const dims = (opts.dimensions ?? []).map((d) => assertIdent(d, "dimension"))
  if (metrics.length === 0) throw new Error("At least one metric is required")

  const where = await buildWhere(sv, opts.filters)

  const parts = [`SUPPLY_CHAIN.SEMANTIC.${sv}`]
  if (dims.length) parts.push(`DIMENSIONS ${dims.join(", ")}`)
  parts.push(`METRICS ${metrics.join(", ")}`)

  let sql = `SELECT * FROM SEMANTIC_VIEW(${parts.join(" ")}${where.clause})`
  if (opts.orderBy) sql += ` ORDER BY ${assertIdent(opts.orderBy, "order by column")}`
  if (opts.limit) sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`

  /**
   * Metric reads honour caller's rights when the deployment opts in.
   *
   * Applied here rather than at every call site because this is the single place a governed metric
   * value is read: if row access policies and masking are to apply to the signed-in Snowflake user,
   * this is the query that must run as them. Metadata reads (registry, ontology, persona catalogue)
   * deliberately stay owner's-rights — they are shared reference data that every user may see, and
   * requiring grants on the GOVERNANCE tables would make the pages fail for reasons unrelated to
   * the data being protected.
   */
  const binds = where.binds as any
  const callersRights = useCallersRights()
  return opts.long
    ? querySnowflakeLongRunning(sql, { pollIntervalMs: 1000, binds, callersRights })
    : querySnowflake(sql, { binds, callersRights })
}

/** The SQL text for a semantic-view query, for display as provenance in the UI. */
export function semanticViewSql(opts: {
  semanticView: string
  metrics: MetricRef[]
  dimensions?: MetricRef[]
  filters?: SemanticFilter[]
  orderBy?: string
}): string {
  const parts = [`SUPPLY_CHAIN.SEMANTIC.${opts.semanticView}`]
  if (opts.dimensions?.length) parts.push(`  DIMENSIONS ${opts.dimensions.join(", ")}`)
  parts.push(`  METRICS ${opts.metrics.join(", ")}`)
  if (opts.filters?.length) {
    parts.push(`  WHERE ${opts.filters.map(renderFilterForDisplay).join("\n    AND ")}`)
  }
  let sql = `SELECT * FROM SEMANTIC_VIEW(\n${parts.join("\n")}\n)`
  if (opts.orderBy) sql += `\nORDER BY ${opts.orderBy}`
  return sql
}

/** Single scalar value for one metric from one semantic view. */
export async function getMetricValue(
  semanticView: string,
  metricRef: MetricRef,
  filters?: SemanticFilter[],
): Promise<number | null> {
  const rows = await querySemanticView({ semanticView, metrics: [metricRef], filters })
  if (rows.length === 0) return null
  const first = Object.values(rows[0])[0]
  return num(first)
}

/**
 * The most recent inventory snapshot date at or before `upTo`.
 *
 * SNAPSHOT metrics (METRIC_DEFINITION.as_of_scope = 'SNAPSHOT') are balances, not events. Summing
 * on-hand quantity across twelve monthly snapshots would count the same physical stock twelve
 * times, so a period-scoped snapshot metric must be pinned to one snapshot rather than aggregated
 * over the range. There is exactly one snapshot per month in the warehouse.
 */
export const getLatestSnapshotDate = cachedMetadata(async function getLatestSnapshotDate(
  upTo: string,
): Promise<string | null> {
  const rows = await querySnowflake(
    `SELECT MAX(snapshot_date) AS d
       FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
      WHERE snapshot_date <= ?`,
    { binds: [upTo] },
  )
  return toIso(rows[0]?.D)?.slice(0, 10) ?? null
})

/**
 * Split metric references by the as-of scope recorded in the registry, so each group can be
 * queried with the filters its scope requires.
 */
export function partitionByAsOfScope<T extends { metricId: string }>(
  items: T[],
  registry: Map<string, MetricDefinition>,
): { realized: T[]; snapshot: T[] } {
  const realized: T[] = []
  const snapshot: T[] = []
  for (const item of items) {
    if (registry.get(item.metricId)?.asOfScope === "SNAPSHOT") snapshot.push(item)
    else realized.push(item)
  }
  return { realized, snapshot }
}

// ---------------------------------------------------------------------------
// Governed predictions
// ---------------------------------------------------------------------------

export interface MetricOutlook {
  metricId: string
  businessName: string | null
  unit: string | null
  method: string
  modelVersion: string | null
  grainDimension: string | null
  grainValue: string | null
  horizonPeriod: string | null
  predictedValue: number | null
  lowerBound: number | null
  upperBound: number | null
  targetValue: number | null
  breachProbability: number | null
  verdict: string | null
  backtestAccuracy: number | null
  backtestMape: number | null
  basis: string | null
}

/**
 * Latest governed prediction per metric and grain.
 *
 * Read from GOVERNANCE.V_METRIC_OUTLOOK rather than computed here: a prediction must come from the
 * registry that recorded its method, model version and backtested accuracy, never from application
 * code extrapolating on the fly. That is the same rule the metrics themselves follow.
 */
export const getMetricOutlook = cachedMetadata(async (): Promise<MetricOutlook[]> => {
  const rows = await querySnowflake(
    `SELECT metric_id, business_name, unit, method, model_version,
            grain_dimension, grain_value, horizon_period,
            predicted_value, lower_bound, upper_bound, target_value,
            breach_probability, verdict,
            method_backtest_accuracy, method_backtest_mape, basis
       FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK
      ORDER BY method, breach_probability DESC NULLS LAST, grain_value, horizon_period`,
  )
  return rows.map((r: any) => ({
    metricId: String(r.METRIC_ID),
    businessName: r.BUSINESS_NAME ?? null,
    unit: r.UNIT ?? null,
    method: String(r.METHOD),
    modelVersion: r.MODEL_VERSION ?? null,
    grainDimension: r.GRAIN_DIMENSION ?? null,
    grainValue: r.GRAIN_VALUE ?? null,
    horizonPeriod: r.HORIZON_PERIOD ?? null,
    predictedValue: r.PREDICTED_VALUE === null ? null : Number(r.PREDICTED_VALUE),
    lowerBound: r.LOWER_BOUND === null ? null : Number(r.LOWER_BOUND),
    upperBound: r.UPPER_BOUND === null ? null : Number(r.UPPER_BOUND),
    targetValue: r.TARGET_VALUE === null ? null : Number(r.TARGET_VALUE),
    breachProbability: r.BREACH_PROBABILITY === null ? null : Number(r.BREACH_PROBABILITY),
    verdict: r.VERDICT ?? null,
    backtestAccuracy: r.METHOD_BACKTEST_ACCURACY === null ? null : Number(r.METHOD_BACKTEST_ACCURACY),
    backtestMape: r.METHOD_BACKTEST_MAPE === null ? null : Number(r.METHOD_BACKTEST_MAPE),
    basis: r.BASIS ?? null,
  }))
})