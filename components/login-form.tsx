"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

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
    <form onSubmit={submit} className="rounded-lg border border-border bg-card p-4 space-y-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        />
      </label>
      {error && (
        <div className="rounded-md border u-chip-bad p-2 text-xs">
          {error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={pending || !username || !password}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
