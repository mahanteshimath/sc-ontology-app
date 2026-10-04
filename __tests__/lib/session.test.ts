/**
 * SPCS caller -> persona resolution.
 *
 * Inside Snowflake App Runtime the request carries no demo cookie, only the ingress-injected caller.
 * These tests pin the property that matters: a caller is served only under its mapped persona, and
 * an unmapped or missing caller is refused rather than falling back to the application identity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const headerMap = new Map<string, string>()
const querySnowflake = vi.fn()

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerMap.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock("../../lib/snowflake", () => ({ querySnowflake: (...a: unknown[]) => querySnowflake(...a) }))

beforeEach(() => {
  headerMap.clear()
  querySnowflake.mockReset()
  process.env.SNOWFLAKE_SERVICE_AUTH = "spcs"
})

afterEach(() => {
  delete process.env.SNOWFLAKE_SERVICE_AUTH
  vi.resetModules()
})

describe("currentSession inside SPCS", () => {
  it("maps the authenticated caller to its persona role", async () => {
    headerMap.set("sf-context-current-user", "JANE")
    querySnowflake.mockResolvedValue([{ PERSONA_ROLE: "SC_LOGISTICS_EU" }])
    const { currentSession } = await import("../../lib/session")
    const s = await currentSession()
    expect(s?.personaRole).toBe("SC_LOGISTICS_EU")
    expect(s?.username).toBe("JANE")
    expect(querySnowflake.mock.calls[0][1].binds).toEqual(["JANE"])
  })

  it("refuses an unmapped caller instead of serving the application identity", async () => {
    headerMap.set("sf-context-current-user", "STRANGER")
    querySnowflake.mockResolvedValue([])
    const { currentSession, UnmappedCallerError, unmappedCallerResponse } = await import("../../lib/session")
    const err = await currentSession().catch((e) => e)
    expect(err).toBeInstanceOf(UnmappedCallerError)
    expect(unmappedCallerResponse(err)?.status).toBe(403)
  })

  it("refuses a request with no caller header", async () => {
    const { currentSession, UnmappedCallerError } = await import("../../lib/session")
    await expect(currentSession()).rejects.toBeInstanceOf(UnmappedCallerError)
  })

  it("rejects a mapped role that is not a plain identifier", async () => {
    headerMap.set("sf-context-current-user", "JANE")
    querySnowflake.mockResolvedValue([{ PERSONA_ROLE: "SC_X; USE ROLE ACCOUNTADMIN" }])
    const { currentSession, UnmappedCallerError } = await import("../../lib/session")
    await expect(currentSession()).rejects.toBeInstanceOf(UnmappedCallerError)
  })

  it("displaySession returns null for an unmapped caller so page chrome still renders", async () => {
    headerMap.set("sf-context-current-user", "STRANGER")
    querySnowflake.mockResolvedValue([])
    const { displaySession } = await import("../../lib/session")
    await expect(displaySession()).resolves.toBeNull()
  })
})
