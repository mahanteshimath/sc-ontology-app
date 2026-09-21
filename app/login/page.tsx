import { listDemoUsers, authConfigured } from "@/lib/auth"
import { LoginForm } from "@/components/login-form"
import { APP_TITLE, TEAM_NAME } from "@/lib/constants"

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
    <main className="min-h-[70vh] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{APP_TITLE}</h1>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{TEAM_NAME}</p>
        </div>

        {!configured ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
            <div className="text-sm font-semibold u-warn">
              Sign-in is not configured
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This deployment has no demo accounts, so no one can sign in and no data is reachable. Set both of these
              in the environment and redeploy:
            </p>
            <pre className="text-[11px] font-mono bg-muted/50 rounded p-2 whitespace-pre-wrap">
              {`AUTH_SECRET=<random string, 32+ chars>
DEMO_USERS=planner:<pw>:SC_PLANNER;buyer:<pw>:SC_PROCUREMENT;logistics:<pw>:SC_LOGISTICS;logistics-eu:<pw>:SC_LOGISTICS_EU`}
            </pre>
          </div>
        ) : (
          <>
            <LoginForm next={next} />
            <div className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Demo accounts</div>
              <ul className="space-y-1">
                {users.map((u) => (
                  <li key={u.username} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono">{u.username}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">acts as {u.personaRole}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
                The account you sign in as selects a real Snowflake role. Every governed query then runs under that
                role with secondary roles disabled, so its grants and row access policies are enforced by Snowflake
                rather than by this application.
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
