import { NextResponse, type NextRequest } from "next/server"
import { SESSION_COOKIE, verifySession } from "@/lib/auth"

/**
 * Require a signed-in demo user for everything except the sign-in flow and static assets.
 *
 * This is the `proxy.ts` convention (Next.js 16 renamed it from `middleware.ts`, which now warns
 * on startup).
 *
 * The gate lives here rather than in each page so a new route is protected by default.
 * It fails closed: when AUTH_SECRET or DEMO_USERS is not configured, verifySession returns null
 * for every request and the whole app redirects to /login, which then explains what is missing.
 * The alternative — treating "no configuration" as "no authentication required" — would silently
 * publish the data the gate exists to protect.
 *
 * Inside Snowflake App Runtime the platform already authenticates every request and injects the
 * caller identity, so the gate is skipped there rather than asking a signed-in Snowflake user to
 * log in a second time.
 */
export async function proxy(req: NextRequest) {
  // SPCS mounts the service token; its presence means the platform is fronting the app.
  if (process.env.SNOWFLAKE_SERVICE_AUTH === "spcs") return NextResponse.next()

  // The product overview is public; all data-bearing routes remain protected.
  if (req.nextUrl.pathname === "/") return NextResponse.next()

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  if (session) return NextResponse.next()

  const url = req.nextUrl.clone()
  url.pathname = "/login"
  // Preserve where the user was heading so sign-in can return them there.
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search)

  // An unauthenticated API call should get a 401, not an HTML redirect it cannot use.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  }
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    /**
     * Everything except the sign-in routes, Next.js internals and static files. Written as a
     * negative lookahead so newly added application routes are covered without touching this list.
     */
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
}
