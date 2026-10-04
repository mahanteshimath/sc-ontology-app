/** Server-side access to the current session: a demo cookie, or the SPCS caller. */

import { cookies, headers } from "next/headers"
import { SESSION_COOKIE, verifySession, type Session } from "@/lib/auth"
import { querySnowflake } from "@/lib/snowflake"

/**
 * Raised inside Snowflake App Runtime when the authenticated caller has no persona mapping.
 *
 * Refusing is the point. Before this existed, an SPCS request had no session and every route fell
 * back to the application's owner's-rights identity — so row access and masking applied to the app,
 * not the person asking, and the persona proof was silently void in the hosted deployment.
 */
export class UnmappedCallerError extends Error {
  readonly status = 403
}

/** The header SPCS ingress injects with the authenticated Snowflake user name. */
const CALLER_HEADER = "sf-context-current-user"
const USER_NAME = /^[A-Za-z0-9_.@$-]{1,255}$/
const MAP_TTL_MS = 60_000
const mapCache = new Map<string, { role: string | null; at: number }>()

async function personaForCaller(user: string): Promise<string | null> {
  const hit = mapCache.get(user)
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return hit.role
  const rows = await querySnowflake(
    `SELECT persona_role FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_USER_MAP WHERE UPPER(user_name) = UPPER(?)`,
    { binds: [user] },
  )
  const role = rows[0]?.PERSONA_ROLE ? String(rows[0].PERSONA_ROLE) : null
  mapCache.set(user, { role, at: Date.now() })
  return role
}

/** Exported for tests. */
export function resetCallerMapCache(): void {
  mapCache.clear()
}

/**
 * The current session, or null outside SPCS when nobody is signed in.
 *
 * Read from the cookie and re-verified here rather than trusted from the middleware: middleware
 * decides whether a request proceeds, but a page that acts on an identity should verify that
 * identity itself rather than assume an upstream check happened.
 *
 * Inside SPCS the caller header is trustworthy only because ingress sets it and the service has no
 * other public endpoint; the edge proxy cannot query Snowflake, so the mapping is resolved here.
 */
export async function currentSession(): Promise<Session | null> {
  if (process.env.SNOWFLAKE_SERVICE_AUTH === "spcs") {
    const user = (await headers()).get(CALLER_HEADER)?.trim() ?? ""
    if (!USER_NAME.test(user)) {
      throw new UnmappedCallerError("No authenticated Snowflake caller on this request.")
    }
    const role = await personaForCaller(user)
    if (!role || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
      throw new UnmappedCallerError(
        `${user} has no persona in GOVERNANCE.PERSONA_USER_MAP, so no data is served. Ask the ontology steward to map you.`,
      )
    }
    return { username: user, personaRole: role, exp: Math.floor(Date.now() / 1000) + 300 }
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySession(token)
}

/**
 * As currentSession, but an unmapped SPCS caller yields null instead of throwing.
 *
 * For page chrome only (the header's "signed in as" label). Data routes must call currentSession so
 * an unmapped caller is refused, never served under the application identity.
 */
export async function displaySession(): Promise<Session | null> {
  try {
    return await currentSession()
  } catch (e) {
    if (e instanceof UnmappedCallerError) return null
    throw e
  }
}

/** A 403 response for an unmapped SPCS caller, or null if `e` is some other error. */
export function unmappedCallerResponse(e: unknown): Response | null {
  return e instanceof UnmappedCallerError ? Response.json({ error: e.message }, { status: 403 }) : null
}
