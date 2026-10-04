import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { signInOneClick, oneClickEnabled, verifySession } from "@/lib/auth"

const ENV = { ...process.env }

describe("one-click judge sign-in", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "x".repeat(40)
    process.env.DEMO_USERS = "buyer:pw1:SC_PROCUREMENT;mahantesh:pw2:SC_ONTOLOGY_STEWARD"
  })
  afterEach(() => {
    process.env = { ...ENV }
  })

  it("is off unless DEMO_ONE_CLICK=true", async () => {
    delete process.env.DEMO_ONE_CLICK
    expect(oneClickEnabled()).toBe(false)
    expect(await signInOneClick("buyer")).toBeNull()
  })

  it("issues a verifiable session for an analyst persona", async () => {
    process.env.DEMO_ONE_CLICK = "true"
    const token = await signInOneClick("buyer")
    expect(token).toBeTruthy()
    const s = await verifySession(token)
    expect(s?.personaRole).toBe("SC_PROCUREMENT")
    // Ephemeral 30-minute TTL, not the full 8-hour password session
    const remainingSeconds = (s?.exp ?? 0) - Math.floor(Date.now() / 1000)
    expect(remainingSeconds).toBeGreaterThan(25 * 60)
    expect(remainingSeconds).toBeLessThanOrEqual(30 * 60)
  })

  it("never issues the steward persona", async () => {
    process.env.DEMO_ONE_CLICK = "true"
    expect(await signInOneClick("mahantesh")).toBeNull()
  })

  it("rejects unknown users", async () => {
    process.env.DEMO_ONE_CLICK = "true"
    expect(await signInOneClick("nobody")).toBeNull()
  })
})
