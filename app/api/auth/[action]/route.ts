/**
 * Sign in / sign out for the demo gate.
 *
 * POST /api/auth/login      { username, password }
 * POST /api/auth/one-click  { username }   only when DEMO_ONE_CLICK=true; never the steward
 * POST /api/auth/logout
 *
 * Failures are deliberately vague ("Incorrect username or password") so the response cannot be
 * used to enumerate which accounts exist. The one exception is a missing configuration, which is
 * an operator error rather than a credential error and is worth reporting clearly.
 */

import {
  signIn,
  signInOneClick,
  authConfigured,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params

  if (action === "logout") {
    const res = Response.json({ ok: true })
    res.headers.append(
      "set-cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    )
    return res
  }

  if (action !== "login" && action !== "one-click") {
    return Response.json({ error: "Unknown action" }, { status: 404 })
  }

  if (!authConfigured()) {
    return Response.json(
      {
        error:
          "Sign-in is not configured. Set AUTH_SECRET and DEMO_USERS in the environment (see .env.example).",
      },
      { status: 503 },
    )
  }

  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string }
  const username = (body.username ?? "").trim()
  const password = body.password ?? ""

  let token: string | null
  if (action === "one-click") {
    if (!username) return Response.json({ error: "Username is required" }, { status: 400 })
    token = await signInOneClick(username)
    if (!token) return Response.json({ error: "One-click access is not available for this workspace" }, { status: 403 })
  } else {
    if (!username || !password) {
      return Response.json({ error: "Username and password are required" }, { status: 400 })
    }
    token = await signIn(username, password)
    if (!token) {
      return Response.json({ error: "Incorrect username or password" }, { status: 401 })
    }
  }

  const secure = new URL(req.url).protocol === "https:"
  const opts = sessionCookieOptions(secure)
  const res = Response.json({ ok: true })
  res.headers.append(
    "set-cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      `Path=${opts.path}`,
      `Max-Age=${opts.maxAge}`,
      "HttpOnly",
      `SameSite=${opts.sameSite === "lax" ? "Lax" : opts.sameSite}`,
      ...(opts.secure ? ["Secure"] : []),
    ].join("; "),
  )
  return res
}
