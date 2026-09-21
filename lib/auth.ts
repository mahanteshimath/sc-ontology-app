/**
 * Demo-user authentication.
 *
 * The app is published at a public URL with owner's-rights Snowflake access, so without a gate
 * anyone with the link can read governed supply-chain data. This adds a small sign-in step.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * This is a demonstration gate, not an identity provider. It is deliberately simple: a fixed list
 * of demo accounts supplied by configuration, a signed cookie, no registration, no password reset,
 * no user store. It is appropriate for keeping a demo off the open internet. It is NOT appropriate
 * as the authentication layer of a production system — for that, front the app with SSO (see
 * setup-snowflake-sso) or run it in SPCS and use the injected caller identity.
 *
 * WHY A DEMO USER MAPS TO A PERSONA
 * Each account names one of the Snowflake persona roles. Signing in as the planning user makes
 * SC_PLANNER the acting persona, and every governed query for that session executes under that
 * role with secondary roles disabled. So the login is not decoration: it selects a real Snowflake
 * identity whose grants and row access policies are enforced by the database, not by this file.
 *
 * CONFIGURATION
 *   AUTH_SECRET  — random string, at least 32 characters. Signs the session cookie.
 *   DEMO_USERS   — semicolon-separated `username:password:SC_ROLE` triples, e.g.
 *                    planner:pw1:SC_PLANNER;buyer:pw2:SC_PROCUREMENT
 * Both are read from the environment. On Vercel set them as environment variables; in SPCS declare
 * them as Snowflake SECRETs and read them with getSecret rather than putting passwords in app.yml.
 * If either is unset the app refuses every sign-in rather than falling open.
 */

export interface DemoUser {
  username: string
  /** Snowflake role this account acts as. Must exist in GOVERNANCE.PERSONA_CATALOG. */
  personaRole: string
}

interface DemoUserWithSecret extends DemoUser {
  password: string
}

export const SESSION_COOKIE = "sc_session"
/** Eight hours: long enough for a working session, short enough that a leaked cookie expires. */
const SESSION_TTL_SECONDS = 8 * 60 * 60

function parseDemoUsers(): DemoUserWithSecret[] {
  const raw = process.env.DEMO_USERS
  if (!raw) return []
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, password, personaRole] = entry.split(":").map((s) => s?.trim() ?? "")
      return { username, password, personaRole }
    })
    .filter((u) => u.username && u.password && /^[A-Za-z_][A-Za-z0-9_]*$/.test(u.personaRole))
}

/** The configured accounts, without their passwords. Safe to show in the UI. */
export function listDemoUsers(): DemoUser[] {
  return parseDemoUsers().map(({ username, personaRole }) => ({ username, personaRole }))
}

export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET) && parseDemoUsers().length > 0
}

/** Constant-time string comparison, so a wrong password cannot be found byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Compare a fixed number of bytes regardless of length, then fold length into the result.
  const len = Math.max(ab.length, bb.length)
  let diff = ab.length ^ bb.length
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

// Web Crypto is used rather than node:crypto so the same code verifies sessions in the Edge
// middleware and in Node route handlers.
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export interface Session {
  username: string
  personaRole: string
  /** Unix seconds. */
  exp: number
}

/** Verify credentials and return a signed session token, or null if they do not match. */
export async function signIn(username: string, password: string): Promise<string | null> {
  const secret = process.env.AUTH_SECRET
  if (!secret) return null

  const users = parseDemoUsers()
  // Look the user up without short-circuiting on a miss, so a valid username is not distinguishable
  // from an invalid one by response time.
  let matched: DemoUserWithSecret | null = null
  for (const u of users) {
    const ok = timingSafeEqual(u.username, username) && timingSafeEqual(u.password, password)
    if (ok) matched = u
  }
  if (!matched) return null

  const payload: Session = {
    username: matched.username,
    personaRole: matched.personaRole,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return `${body}.${toBase64Url(sig)}`
}

/**
 * Verify a session token's signature and expiry.
 *
 * Returns null on anything suspect — bad shape, bad signature, expired — so callers only ever see
 * a session they can trust.
 */
export async function verifySession(token: string | undefined | null): Promise<Session | null> {
  const secret = process.env.AUTH_SECRET
  if (!secret || !token) return null

  const dot = token.lastIndexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  try {
    const key = await hmacKey(secret)
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sig) as unknown as ArrayBuffer,
      new TextEncoder().encode(body),
    )
    if (!valid) return null

    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Session
    if (typeof session.exp !== "number" || session.exp < Math.floor(Date.now() / 1000)) return null
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(session.personaRole)) return null
    return session
  } catch {
    return null
  }
}

/** Cookie attributes for the session. Secure is omitted on http so local dev still works. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure,
  }
}
