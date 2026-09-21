/**
 * Exception drill-down: the atomic rows behind a missed metric.
 *
 * POST /api/drilldown
 *   { metricId, dimension?, dimensionValue?, period?, from?, to?, asOf?, limit? }
 *
 * A metric on its own is not actionable. Supplier OTD of 85% in EMEA tells a buyer that something
 * is wrong but not which receipts to chase. This route returns the individual purchase-order
 * lines, order lines, shipments or stock positions that caused the miss, from the same canonical
 * fact the metric is defined over — so the rows always reconcile to the number above them.
 *
 * TRUST BOUNDARY. What counts as an exception is read from
 * GOVERNANCE.METRIC_EXCEPTION_RULE rather than hardcoded here, so the drill-down and the metric
 * cannot drift apart. That table's `exception_where` is interpolated into SQL, which is only safe
 * because the GOVERNANCE schema is admin-owned and not writable by any application role — it is
 * configuration, at the same trust level as the semantic view definitions themselves. Everything
 * that arrives from the request, by contrast, is either bound or validated against
 * INFORMATION_SCHEMA:
 *   - metricId       looked up in the registry; unknown ids are rejected
 *   - dimension      mapped to a physical column and checked to exist on that fact
 *   - dimensionValue bound
 *   - dates          bound
 */

import { querySnowflake, getMetricRegistry, toIso } from "@/lib/sc"
import { resolvePeriod } from "@/lib/period"

export const dynamic = "force-dynamic"

/** A selective scan over one fact with a LIMIT; a few seconds at most. */
export const maxDuration = 60

const MAX_LIMIT = 200

/**
 * Semantic dimension reference to the physical column that carries it on a fact.
 *
 * The canonical facts are denormalised, so most ontology dimensions exist directly on the fact and
 * the drill-down needs no joins. A reference that is not in this map simply does not narrow the
 * result — better than guessing a column name.
 */
const DIMENSION_COLUMN: Record<string, string> = {
  "part.product_family": "PRODUCT_FAMILY",
  "part.business_segment": "BUSINESS_SEGMENT",
  "part.abc_class": "ABC_CLASS",
  "part.material": "MATERIAL_ID",
  "supplier.supplier_region": "SUPPLIER_REGION",
  "supplier.supplier_name": "SUPPLIER_NAME",
  "supplier.supplier_group": "SUPPLIER_GROUP",
  "supplier.supplier_tier": "SUPPLIER_TIER",
  "customer.customer_region": "CUSTOMER_REGION",
  "customer.customer_segment": "CUSTOMER_SEGMENT",
  "customer.customer": "CUSTOMER_ID",
  "order_fulfillment.carrier": "CARRIER",
  "order_fulfillment.ship_region": "SHIP_REGION",
  "node.node_region": "NODE_REGION",
  "node.node": "NODE_ID",
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

interface ExceptionRule {
  metricId: string
  canonicalFact: string
  dateColumn: string
  exceptionWhere: string
  displayColumns: string[]
  orderBy: string
  description: string
}

async function getExceptionRule(metricId: string): Promise<ExceptionRule | null> {
  const rows = await querySnowflake(
    `SELECT metric_id, canonical_fact, date_column, exception_where,
            display_columns, order_by, description
       FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE
      WHERE metric_id = ?`,
    { binds: [metricId] },
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    metricId: r.METRIC_ID,
    canonicalFact: r.CANONICAL_FACT,
    dateColumn: r.DATE_COLUMN,
    exceptionWhere: r.EXCEPTION_WHERE,
    displayColumns: String(r.DISPLAY_COLUMNS)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    orderBy: r.ORDER_BY,
    description: r.DESCRIPTION,
  }
}

/** The columns a fact actually has, so a stale rule fails loudly instead of producing bad SQL. */
async function factColumns(fact: string): Promise<Set<string>> {
  const [schema, table] = fact.split(".")
  if (!IDENT.test(schema ?? "") || !IDENT.test(table ?? "")) {
    throw new Error(`Invalid canonical fact in registry: ${fact}`)
  }
  const rows = await querySnowflake(
    `SELECT column_name FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.COLUMNS
      WHERE table_schema = ? AND table_name = ?`,
    { binds: [schema, table] },
  )
  return new Set(rows.map((r) => String(r.COLUMN_NAME).toUpperCase()))
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      metricId?: string
      dimension?: string
      dimensionValue?: string
      period?: string
      from?: string
      to?: string
      asOf?: string
      limit?: number
      offset?: number
    }

    const metricId = (body.metricId ?? "").trim()
    if (!metricId) return Response.json({ error: "metricId is required" }, { status: 400 })

    const registry = await getMetricRegistry()
    const metric = registry.find((m) => m.metricId === metricId)
    if (!metric) {
      return Response.json(
        { error: `"${metricId}" is not a registered metric.` },
        { status: 404 },
      )
    }

    const rule = await getExceptionRule(metricId)
    if (!rule) {
      return Response.json(
        {
          error: `No exception rule is registered for "${metricId}", so there is nothing to drill into. Add one to GOVERNANCE.METRIC_EXCEPTION_RULE.`,
        },
        { status: 404 },
      )
    }

    // A rule pointing at a different fact than the metric would return rows that do not reconcile
    // to the number being explained.
    if (rule.canonicalFact !== metric.canonicalFact) {
      return Response.json(
        {
          error: `Exception rule for ${metricId} reads ${rule.canonicalFact} but the metric is defined over ${metric.canonicalFact}.`,
        },
        { status: 500 },
      )
    }

    const columns = await factColumns(rule.canonicalFact)

    const display = rule.displayColumns.filter((c) => IDENT.test(c) && columns.has(c.toUpperCase()))
    if (display.length === 0) {
      throw new Error(`Exception rule for ${metricId} names no column that exists on ${rule.canonicalFact}`)
    }
    if (!IDENT.test(rule.dateColumn) || !columns.has(rule.dateColumn.toUpperCase())) {
      throw new Error(`Exception rule date column ${rule.dateColumn} is not on ${rule.canonicalFact}`)
    }

    const period = resolvePeriod({
      id: body.period ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
      asOf: body.asOf ?? null,
    })

    const where: string[] = [`(${rule.exceptionWhere})`]
    const binds: unknown[] = []

    if (period.from) {
      where.push(`${rule.dateColumn} >= ?`)
      binds.push(period.from)
    }
    if (period.to) {
      where.push(`${rule.dateColumn} <= ?`)
      binds.push(period.to)
    }
    // The same as-of rule the metric uses. Without it the worst "late" receipts would be ones that
    // simply have not happened yet.
    if (metric.asOfScope === "REALIZED") {
      where.push(`${rule.dateColumn} <= CURRENT_DATE()`)
    }

    let dimensionColumn: string | null = null
    if (body.dimension && body.dimensionValue) {
      const mapped = DIMENSION_COLUMN[body.dimension.toLowerCase()]
      if (mapped && columns.has(mapped)) {
        dimensionColumn = mapped
        where.push(`${mapped} = ?`)
        binds.push(body.dimensionValue)
      }
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(body.limit ?? 50)))
    // Paging by OFFSET is adequate here because ORDER BY is a deterministic single column on an
    // append-mostly fact, and the population is capped at a few thousand rows in practice. A
    // keyset cursor would be the right answer for an unbounded, concurrently-mutating table.
    const offset = Math.max(0, Math.floor(body.offset ?? 0))

    const sql =
      `SELECT ${display.join(", ")}\n` +
      `  FROM SUPPLY_CHAIN.${rule.canonicalFact}\n` +
      ` WHERE ${where.join("\n   AND ")}\n` +
      ` ORDER BY ${rule.orderBy}\n` +
      ` LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""}`

    // Count the full exception population separately: the table shows the worst `limit` rows, but
    // "the worst 50 of 12,431" is a materially different message from "all 50 of them".
    const countSql =
      `SELECT COUNT(*) AS N FROM SUPPLY_CHAIN.${rule.canonicalFact} WHERE ${where.join(" AND ")}`

    const [rows, countRows] = await Promise.all([
      querySnowflake(sql, { binds: binds as any }),
      querySnowflake(countSql, { binds: binds as any }),
    ])

    // Timestamps arrive from the driver as Date objects; normalise before serialising.
    const serialised = rows.map((r) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) {
        out[k] = v instanceof Date ? toIso(v)?.slice(0, 10) : v
      }
      return out
    })

    return Response.json({
      metricId: metric.metricId,
      businessName: metric.businessName,
      description: rule.description,
      canonicalFact: `SUPPLY_CHAIN.${rule.canonicalFact}`,
      period: { label: period.label, description: period.description },
      dimension: dimensionColumn,
      dimensionValue: dimensionColumn ? body.dimensionValue : null,
      columns: display,
      rows: serialised,
      shown: serialised.length,
      offset,
      limit,
      hasMore: offset + serialised.length < Number(countRows[0]?.N ?? 0),
      total: Number(countRows[0]?.N ?? 0),
      sql,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[drilldown] exception query failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load exception rows" },
      { status: 500 },
    )
  }
}
