"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  ArrowRight,
  Boxes,
  Check,
  Globe,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
} from "lucide-react"

export interface DemoUserItem {
  username: string
  personaRole: string
}

interface PersonaOption {
  username: string
  label: string
  role: string
  desc: string
  icon: React.ComponentType<{ className?: string }>
  iconBg: string
  iconColor: string
}

const PERSONA_OPTIONS: PersonaOption[] = [
  {
    username: "planner",
    label: "Planner",
    role: "SC_PLANNER",
    desc: "Demand & inventory",
    icon: Boxes,
    iconBg: "bg-amber-400/15 border-amber-400/30",
    iconColor: "text-amber-300",
  },
  {
    username: "buyer",
    label: "Procurement",
    role: "SC_PROCUREMENT",
    desc: "Suppliers & pricing",
    icon: ShoppingBag,
    iconBg: "bg-emerald-400/15 border-emerald-400/30",
    iconColor: "text-emerald-300",
  },
  {
    username: "logistics",
    label: "Logistics",
    role: "SC_LOGISTICS",
    desc: "All-region delivery",
    icon: Truck,
    iconBg: "bg-cyan-400/15 border-cyan-400/30",
    iconColor: "text-cyan-300",
  },
  {
    username: "logistics-eu",
    label: "Logistics EU",
    role: "SC_LOGISTICS_EU",
    desc: "EU row-scope filter",
    icon: Globe,
    iconBg: "bg-blue-400/15 border-blue-400/30",
    iconColor: "text-blue-300",
  },
  {
    username: "steward",
    label: "Steward",
    role: "SC_ONTOLOGY_STEWARD",
    desc: "All views & control",
    icon: ShieldCheck,
    iconBg: "bg-purple-400/15 border-purple-400/30",
    iconColor: "text-purple-300",
  },
]

export function LoginForm({
  next,
  users = [],
  demoPassword = process.env.NEXT_PUBLIC_DEMO_PASSWORD || "",
}: {
  next: string
  users?: DemoUserItem[]
  demoPassword?: string
}) {
  const router = useRouter()
  const [username, setUsername] = useState("planner")
  const [password, setPassword] = useState(demoPassword)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [feedbackUser, setFeedbackUser] = useState<string | null>(null)

  useEffect(() => {
    if (demoPassword) {
      setPassword(demoPassword)
    }
  }, [demoPassword])

  // Use all 5 persona options, filtering to configured users if provided
  const availablePersonas =
    users.length > 0
      ? PERSONA_OPTIONS.filter((p) => users.some((u) => u.username === p.username))
      : PERSONA_OPTIONS

  // Fallback to PERSONA_OPTIONS if filter returned empty
  const displayPersonas = availablePersonas.length > 0 ? availablePersonas : PERSONA_OPTIONS

  function handleSelectPersona(p: PersonaOption) {
    setUsername(p.username)
    setPassword(demoPassword)
    setError(null)
    setFeedbackUser(p.username)
    setTimeout(() => setFeedbackUser(null), 1500)
  }

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
    <form onSubmit={submit} className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-sm">
      {/* 5 Persona Icons Section */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-200">
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
            <span>Select Persona · Click to Auto-Fill</span>
          </div>
          <span className="text-[10px] text-slate-400">Click any card</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {displayPersonas.map((p, index) => {
            const isSelected = username === p.username
            const isJustFilled = feedbackUser === p.username
            const Icon = p.icon
            // Give 5th card full span on 2-col layout if odd
            const isLastOdd = index === 4

            return (
              <button
                key={p.username}
                type="button"
                onClick={() => handleSelectPersona(p)}
                className={`relative flex flex-col items-start p-3 rounded-xl border transition-all duration-200 text-left cursor-pointer group ${
                  isSelected
                    ? "border-cyan-400 bg-cyan-400/15 shadow-[0_0_20px_rgba(34,211,238,0.18)] ring-1 ring-cyan-400/50"
                    : "border-white/10 bg-black/25 hover:border-white/25 hover:bg-white/[0.04]"
                } ${isLastOdd ? "col-span-2 sm:col-span-1" : ""}`}
              >
                {/* Top Row: Icon + Selection Badge */}
                <div className="flex items-center justify-between w-full mb-2">
                  <div className={`grid h-8 w-8 place-items-center rounded-lg border ${p.iconBg} ${p.iconColor}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  {isSelected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-cyan-400/20 border border-cyan-400/40 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-200">
                      <Check className="h-2.5 w-2.5 text-cyan-300" />
                      <span>Active</span>
                    </span>
                  )}
                  {isJustFilled && !isSelected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/20 border border-emerald-400/40 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300 animate-pulse">
                      Filled!
                    </span>
                  )}
                </div>

                {/* Persona Labels */}
                <div className="font-semibold text-xs text-white group-hover:text-cyan-200 transition-colors">
                  {p.label}
                </div>
                <div className="text-[10px] font-mono text-cyan-300/80 mt-0.5">
                  @{p.username}
                </div>
                <div className="text-[10px] text-slate-400 mt-1 line-clamp-1 leading-tight">
                  {p.desc}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Auto-filled Form Fields */}
      <div className="pt-2 border-t border-white/10 space-y-3.5">
        <label className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Username</span>
            <span className="text-[10px] text-slate-400 font-mono">auto-filled on click</span>
          </div>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            placeholder="e.g. planner, buyer, logistics"
            className="h-11 rounded-lg border border-white/15 bg-black/30 px-3 text-sm font-mono text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/70 focus:ring-2 focus:ring-cyan-200/15"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Password</span>
            <span className="text-[10px] text-slate-400 font-mono">auto-filled on click</span>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="h-11 w-full rounded-lg border border-white/15 bg-black/30 px-3 text-sm font-mono text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/70 focus:ring-2 focus:ring-cyan-200/15"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-300/20 bg-red-300/[0.08] p-3 text-xs text-red-200">
          {error}
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        className="h-11 w-full rounded-lg bg-cyan-300 text-[#06283a] hover:bg-cyan-200 font-semibold shadow-lg shadow-cyan-300/10 transition-all"
        disabled={pending || !username || !password}
      >
        {pending ? "Authenticating…" : `Sign in as @${username}`} {!pending && <ArrowRight className="h-4 w-4 ml-1" aria-hidden />}
      </Button>
    </form>
  )
}
