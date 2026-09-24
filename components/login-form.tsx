"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowRight } from "lucide-react"

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) {
        setError(json.error ?? "Sign-in failed")
        return
      }
      // Only allow same-origin relative paths, so ?next= cannot be used to bounce a signed-in
      // user to an attacker-controlled site.
      const target = next.startsWith("/") && !next.startsWith("//") ? next : "/"
      router.replace(target)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed")
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
          className="h-11 rounded-lg border border-white/15 bg-black/20 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/70 focus:ring-2 focus:ring-cyan-200/15"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="h-11 rounded-lg border border-white/15 bg-black/20 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/70 focus:ring-2 focus:ring-cyan-200/15"
        />
      </label>
      {error && (
        <div role="alert" className="rounded-lg border border-red-300/20 bg-red-300/[0.08] p-3 text-xs text-red-200">
          {error}
        </div>
      )}
      <Button type="submit" size="lg" className="h-11 w-full rounded-lg bg-cyan-300 text-[#06283a] hover:bg-cyan-200" disabled={pending || !username || !password}>
        {pending ? "Authenticating…" : "Continue securely"} {!pending && <ArrowRight className="h-4 w-4" aria-hidden />}
      </Button>
    </form>
  )
}
