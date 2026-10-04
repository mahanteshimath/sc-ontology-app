"use client"

/**
 * One-click persona sign-in for judges. Rendered only when DEMO_ONE_CLICK=true, and the server
 * refuses the steward persona regardless (lib/auth.ts signInOneClick).
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

export function OneClickPersonas({
  users,
  next,
}: {
  users: { username: string; personaRole: string }[]
  next: string
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function go(username: string) {
    setPending(username)
    setError(null)
    try {
      const res = await fetch("/api/auth/one-click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(json.error ?? "Sign-in failed")
        return
      }
      const target = next.startsWith("/") && !next.startsWith("//") ? next : "/tour"
      router.replace(target)
      router.refresh()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="rounded-xl border border-cyan-200/20 bg-cyan-200/[0.06] p-5 space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Judge access · one click</div>
      <div className="grid grid-cols-2 gap-2">
        {users.map((u) => (
          <button
            key={u.username}
            type="button"
            onClick={() => go(u.username)}
            disabled={pending !== null}
            className="rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-left text-xs hover:border-cyan-200/60 disabled:opacity-50"
          >
            <span className="block font-medium">{pending === u.username ? "Signing in…" : u.username}</span>
            <span className="block font-mono text-[11px] text-slate-400">{u.personaRole}</span>
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
      <p className="text-[11px] leading-relaxed text-slate-400">
        Each button signs in as a real Snowflake persona role. Sign in as two personas in turn to see the same metric
        resolve identically, and the EU persona see only EU rows.
      </p>
    </div>
  )
}
