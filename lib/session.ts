/** Server-side access to the current demo session. */

import { cookies } from "next/headers"
import { SESSION_COOKIE, verifySession, type Session } from "@/lib/auth"

/**
 * The signed-in demo user, or null.
 *
 * Read from the cookie and re-verified here rather than trusted from the middleware: middleware
 * decides whether a request proceeds, but a page that acts on an identity should verify that
 * identity itself rather than assume an upstream check happened.
 */
export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySession(token)
}
