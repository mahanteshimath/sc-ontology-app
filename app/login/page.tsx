import { listDemoUsers, authConfigured } from "@/lib/auth"
import { LoginForm } from "@/components/login-form"
import { APP_TITLE, TEAM_NAME } from "@/lib/constants"
import Link from "next/link"
import { ArrowLeft, LockKeyhole, ShieldCheck } from "lucide-react"
import { BrandMark } from "@/components/brand-mark"

export const dynamic = "force-dynamic"

/**
 * Sign-in page for the demo gate.
 *
 * The available account names and the persona each one acts as are listed, because they are not
 * secret and a demo nobody can get into is useless. Passwords are not listed and are never sent to
 * the browser.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const next = (Array.isArray(sp.next) ? sp.next[0] : sp.next) ?? "/"
  const users = listDemoUsers()
  const configured = authConfigured()

  return (
    <main className="min-h-screen bg-[#08131f] text-white">
      <div className="mx-auto grid min-h-screen w-full max-w-[1400px] lg:grid-cols-[1.1fr_0.9fr]">
        <section className="relative hidden overflow-hidden border-r border-white/10 px-10 py-10 lg:flex lg:flex-col lg:justify-between lg:px-16">
          <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(100,190,220,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(100,190,220,0.07)_1px,transparent_1px)] [background-size:56px_56px]" />
          <Link href="/" className="relative flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-200/10 text-cyan-200"><BrandMark className="h-7 w-7" /></span><span><span className="block text-sm font-semibold tracking-[0.16em]">SUPPLY CHAIN</span><span className="block text-[10px] tracking-[0.28em] text-cyan-200/70">ONTOLOGY CONTROL TOWER</span></span></Link>
          <div className="relative max-w-xl pb-16"><div className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Secure operations workspace</div><h1 className="text-5xl font-semibold leading-[1.05] tracking-[-0.03em]">Make every number accountable.</h1><p className="mt-6 max-w-lg text-base leading-7 text-slate-300">Your role determines the governed views, row scope, and metric access behind every decision. Sign in to continue to the control tower.</p><div className="mt-10 grid max-w-md grid-cols-2 gap-3"><div className="rounded-xl border border-white/10 bg-white/[0.05] p-4"><ShieldCheck className="h-5 w-5 text-emerald-300" /><div className="mt-4 text-sm font-medium">Snowflake-enforced</div><div className="mt-1 text-xs leading-5 text-slate-400">Persona grants and row access policies apply at query time.</div></div><div className="rounded-xl border border-white/10 bg-white/[0.05] p-4"><LockKeyhole className="h-5 w-5 text-cyan-200" /><div className="mt-4 text-sm font-medium">Governed by design</div><div className="mt-1 text-xs leading-5 text-slate-400">Metrics resolve to the ontology, not ad hoc calculations.</div></div></div></div>
          <div className="relative text-xs text-slate-500">{TEAM_NAME} · governed supply chain analytics</div>
        </section>

        <section className="flex items-center justify-center px-5 py-10 sm:px-10">
          <div className="w-full max-w-md space-y-6">
            <Link href="/" className="inline-flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white lg:hidden"><ArrowLeft className="h-4 w-4" /> Back to overview</Link>
            <div className="lg:hidden"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-200/10 text-cyan-200"><BrandMark className="h-7 w-7" /></span><span><span className="block text-sm font-semibold tracking-[0.16em]">SUPPLY CHAIN</span><span className="block text-[10px] tracking-[0.28em] text-cyan-200/70">ONTOLOGY CONTROL TOWER</span></span></div></div>
            <div><div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Authorized access</div><h2 className="mt-3 text-3xl font-semibold tracking-[-0.02em]">Sign in to continue</h2><p className="mt-2 text-sm leading-6 text-slate-400">Use your workspace credentials to open governed analytics.</p></div>

        {!configured ? (
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-5 space-y-2">
            <div className="text-sm font-semibold text-amber-200">
              Sign-in is not configured
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This deployment has no demo accounts, so no one can sign in and no data is reachable. Set both of these
              in the environment and redeploy:
            </p>
            <pre className="rounded-lg bg-black/20 p-3 text-[11px] font-mono whitespace-pre-wrap text-slate-300">
              {`AUTH_SECRET=<random string, 32+ chars>
DEMO_USERS=planner:<pw>:SC_PLANNER;buyer:<pw>:SC_PROCUREMENT;logistics:<pw>:SC_LOGISTICS;logistics-eu:<pw>:SC_LOGISTICS_EU`}
            </pre>
          </div>
        ) : (
          <>
            <LoginForm next={next} />
            <div className="rounded-xl border border-white/10 bg-white/[0.05] p-5 space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Available workspaces</div>
              <ul className="space-y-1">
                {users.map((u) => (
                  <li key={u.username} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono">{u.username}</span>
                    <span className="font-mono text-[11px] text-slate-400">{u.personaRole}</span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-white/10 pt-3 text-[11px] leading-relaxed text-slate-400">
                The account you sign in as selects a real Snowflake role. Every governed query then runs under that
                role with secondary roles disabled, so its grants and row access policies are enforced by Snowflake
                rather than by this application.
              </p>
            </div>
          </>
        )}
            <p className="text-center text-[11px] text-slate-500">Access is logged and governed by the active Snowflake persona.</p>
          </div>
        </section>
      </div>
    </main>
  )
}
