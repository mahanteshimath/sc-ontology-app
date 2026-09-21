/**
 * Executes a governed metric as a specific Snowflake role.
 *
 * The consistency proof is only meaningful if each persona's number is produced under that
 * persona's own grants, so this cannot reuse the shared owner's-rights pool — that pool runs as
 * the app's identity and would prove nothing.
 *
 * WHY NOT THE CONNECTION-LEVEL `role` OPTION
 * The previous implementation passed `role` to createConnection. That works for password and TOML
 * auth but is unreliable under the SPCS OAuth service token, where the token carries its own
 * identity and the requested role is silently ignored or rejected — so the persona comparison
 * would have quietly run every query as the service role and still shown "EXACT" agreement. This
 * version issues an explicit `USE ROLE` and then verifies with CURRENT_ROLE() that the switch
 * actually took effect, so a role that cannot be assumed is reported rather than misreported.
 *
 * `USE SECONDARY ROLES NONE` matters for the same reason: without it every role granted to the
 * identity stays active as a secondary role and a persona inherits privileges it was never
 * granted, which would make a row-access-policy demonstration meaningless.
 *
 * CONNECTION POOLING
 * Pools are keyed by role name, never shared between roles. Session role is mutable state, so a
 * single shared pool would let one request inherit another's role — a correctness and security
 * problem far worse than the cost of connecting. Each pool still issues `USE ROLE` and re-verifies
 * CURRENT_ROLE() on every acquisition, because a pooled connection's session state is not something
 * this code should assume it is the only writer of.
 */

import snowflake from "snowflake-sdk"
import { getServiceToken, readTomlDefaultConnection } from "@/lib/snowflake"

function baseOptions(): snowflake.ConnectionOptions {
  const token = getServiceToken()
  if (token) {
    return {
      authenticator: "OAUTH",
      token,
      ...(process.env.SNOWFLAKE_ACCOUNT && { account: process.env.SNOWFLAKE_ACCOUNT }),
      ...(process.env.SNOWFLAKE_ACCOUNT_URL && { accessUrl: process.env.SNOWFLAKE_ACCOUNT_URL }),
    }
  }
  if (process.env.SNOWFLAKE_USER && process.env.SNOWFLAKE_PASSWORD) {
    return {
      account: process.env.SNOWFLAKE_ACCOUNT ?? "",
      username: process.env.SNOWFLAKE_USER,
      password: process.env.SNOWFLAKE_PASSWORD,
    }
  }
  const conn = readTomlDefaultConnection()
  if (!conn) throw new Error("No Snowflake credentials available for per-role execution")
  const normalize = (
    snowflake as unknown as {
      normalizeConnectionOptions: (o: Record<string, unknown>) => snowflake.ConnectionOptions
    }
  ).normalizeConnectionOptions
  return normalize(conn as unknown as Record<string, unknown>)
}

/**
 * Warehouse for per-role execution.
 *
 * Read from configuration rather than hardcoded: the previous constant meant that deploying to an
 * account without a warehouse literally named COMPUTE_WH broke the consistency page only, and only
 * at request time.
 */
function warehouse(): string | undefined {
  return process.env.SNOWFLAKE_WAREHOUSE ?? readTomlDefaultConnection()?.warehouse ?? undefined
}

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function runStatement(conn: snowflake.Connection, sqlText: string, binds?: any): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      ...(binds && binds.length ? { binds } : {}),
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve((rows ?? []) as Record<string, any>[])),
    })
  })
}

export interface RoleQuery {
  /** Label returned alongside the value so the caller can match results up. */
  key: string
  sql: string
  binds?: unknown[]
}

export interface RoleValue {
  value: number | null
  error?: string
}

/** Full result set for a query run under a persona role. */
export interface RoleRows {
  rows: Record<string, any>[]
  error?: string
}

/**
 * One connection pool per persona role.
 *
 * Keyed by role so a connection can never be handed to a request expecting a different role. The
 * pools are small: this path serves a handful of comparison queries, not general traffic.
 */
const rolePools = new Map<string, ReturnType<typeof snowflake.createPool>>()
let poolServiceToken = ""

const ROLE_POOL_CONFIG = { min: 0, max: 3 }

function getRolePool(role: string): ReturnType<typeof snowflake.createPool> {
  // The SPCS service token rotates. A pool holding a stale token fails on every acquisition, so
  // drain everything when it changes rather than serving connections that cannot authenticate.
  const token = getServiceToken()
  if (token !== poolServiceToken) {
    for (const pool of rolePools.values()) pool.drain()
    rolePools.clear()
    poolServiceToken = token
  }

  let pool = rolePools.get(role)
  if (!pool) {
    const wh = warehouse()
    pool = snowflake.createPool({ ...baseOptions(), ...(wh ? { warehouse: wh } : {}) }, ROLE_POOL_CONFIG)
    rolePools.set(role, pool)
  }
  return pool
}

/** Drain every per-role pool. Exported for shutdown and for tests. */
export function closeRolePools(): void {
  for (const pool of rolePools.values()) pool.drain()
  rolePools.clear()
}

/**
 * Acquire a connection, assume `role`, verify the switch actually took effect, and hand it to `fn`.
 *
 * Shared by runAsRole and runRowsAsRole so the role-assumption guarantee is written once. If the two
 * had their own copies, a fix to one would silently leave the other executing as the app identity
 * while still labelling its output with the persona name — the exact misreporting this module exists
 * to prevent.
 *
 * A failure to assume the role is surfaced through `onRoleFailure` rather than thrown, because each
 * caller needs to attribute it to every query it was about to run.
 */
async function withRole<T>(
  role: string,
  fn: (conn: snowflake.Connection) => Promise<T>,
  onRoleFailure: (message: string) => T,
): Promise<T> {
  if (!ROLE_NAME.test(role)) throw new Error(`Invalid role name: ${role}`)
  const wh = warehouse()

  return getRolePool(role).use(async (conn) => {
    // Re-asserted on every acquisition rather than once at pool creation: a pooled connection
    // carries session state, and assuming this code is its only writer is exactly the assumption
    // that makes role leakage possible.
    try {
      await runStatement(conn, `USE ROLE ${role}`)
      await runStatement(conn, "USE SECONDARY ROLES NONE")
      if (wh) await runStatement(conn, `USE WAREHOUSE IDENTIFIER(?)`, [wh])

      const check = await runStatement(conn, "SELECT CURRENT_ROLE() AS R")
      const actual = String(check[0]?.R ?? "")
      if (actual.toUpperCase() !== role.toUpperCase()) {
        throw new Error(`session is running as ${actual || "an unknown role"}, not ${role}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return onRoleFailure(`could not run as ${role}: ${msg.slice(0, 140)}`)
    }

    return fn(conn)
  })
}

/**
 * Open one connection, switch to `role`, run every query, and return the first scalar of each.
 *
 * A query the role is not authorised for yields an `error` rather than aborting the batch — a
 * denial is itself a governance result worth showing. A failure to assume the role at all is
 * different: that is reported against every query, because silently falling back to the app's own
 * role would fabricate agreement.
 */
export async function runAsRole(role: string, queries: RoleQuery[]): Promise<Record<string, RoleValue>> {
  return withRole<Record<string, RoleValue>>(
    role,
    async (conn) => {
      const out: Record<string, RoleValue> = {}
      for (const q of queries) {
        try {
          const rows = await runStatement(conn, q.sql, q.binds)
          const first = rows.length > 0 ? Object.values(rows[0])[0] : null
          const n = first === null || first === undefined ? null : Number(first)
          out[q.key] = { value: Number.isFinite(n as number) ? (n as number) : null }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          out[q.key] = {
            value: null,
            error: /does not exist or not authorized/i.test(msg) ? "not authorised" : msg.slice(0, 160),
          }
        }
      }
      return out
    },
    (message) => Object.fromEntries(queries.map((q) => [q.key, { value: null, error: message }])),
  )
}

/**
 * As runAsRole, but returns every row rather than the first scalar.
 *
 * WHY THIS EXISTS. runAsRole collapses each result to one number, which is right for the consistency
 * comparison but wrong for the conversational layer: it silently discards dimensional breakdowns, so
 * "on-time delivery by product family" asked by a persona came back as a single figure with no
 * categories and therefore no chart. Widening runAsRole would have changed the contract that
 * /api/consistency depends on, so this is a sibling instead.
 *
 * The row-access policy still applies, because the role assumption is identical — a row-scoped
 * persona gets a genuinely shorter list of categories, not a filtered copy of the full one.
 */
export async function runRowsAsRole(role: string, queries: RoleQuery[]): Promise<Record<string, RoleRows>> {
  return withRole<Record<string, RoleRows>>(
    role,
    async (conn) => {
      const out: Record<string, RoleRows> = {}
      for (const q of queries) {
        try {
          out[q.key] = { rows: await runStatement(conn, q.sql, q.binds) }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          out[q.key] = {
            rows: [],
            error: /does not exist or not authorized/i.test(msg) ? "not authorised" : msg.slice(0, 160),
          }
        }
      }
      return out
    },
    (message) => Object.fromEntries(queries.map((q) => [q.key, { rows: [], error: message }])),
  )
}

/**
 * Whether this deployment can execute as an arbitrary persona role at all.
 *
 * Used by the UI to explain itself instead of showing a wall of identical errors: if the app's
 * identity has not been granted the persona roles, cross-persona execution is simply unavailable
 * and the page should say so.
 */
export async function canRunAsRole(role: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await runAsRole(role, [{ key: "probe", sql: "SELECT 1" }])
    const err = res.probe?.error
    return err ? { ok: false, reason: err } : { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
