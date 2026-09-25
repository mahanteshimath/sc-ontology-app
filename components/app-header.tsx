"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { APP_TITLE, TEAM_NAME } from "@/lib/constants"
import { BrandMark } from "@/components/brand-mark"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import {
  BarChart3,
  BotMessageSquare,
  Boxes,
  ClipboardCheck,
  Database,
  GitCompareArrows,
  Globe,
  Network,
} from "lucide-react"

const NAV = [
  { href: "/", label: "Overview", icon: BarChart3 },
  { href: "/operations", label: "Operations", icon: Boxes },
  { href: "/network-risk", label: "Network Risk", icon: Globe },
  { href: "/ask", label: "Ask", icon: BotMessageSquare },
  { href: "/outlook", label: "Outlook", icon: ClipboardCheck },
  { href: "/ontology", label: "Ontology", icon: Network },
  { href: "/metrics", label: "Metric Registry", icon: Database },
  { href: "/consistency", label: "Consistency", icon: GitCompareArrows },
]

export function AppHeader({
  user,
}: {
  user: { username: string; personaRole: string } | null
}) {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" })
    router.replace("/login")
    router.refresh()
  }

  // The sign-in page is its own self-contained screen; a nav bar on it is noise.
  if (pathname === "/login") return null
  if (pathname === "/" && !user) return null

  /*
   * The header is two rows on small screens and one on large.
   *
   * It used to be a single fixed-height (h-14) row holding brand, six nav links, the user block and
   * the theme toggle. At 390px the brand alone rendered 85px tall inside that 57px box, so it hung
   * below the header's own border and overprinted the first heading and the first button on every
   * route — a functional failure, not a tight fit. Meanwhile the nav exposed 129px of its 537px
   * content behind an unlabelled native scrollbar, hiding four of six destinations.
   *
   * Fixes: height is intrinsic rather than fixed, the brand truncates to one line, the nav gets its
   * own full-width row below `md` with a masked edge so a cut-off link reads as scrollable.
   */
  return (
    <header className="sticky top-0 z-50 w-full max-w-full overflow-x-hidden border-b border-border bg-background/95 shadow-[0_1px_0_rgb(15_23_42_/_0.03)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="w-full max-w-[1400px] mx-auto px-4 sm:px-6">
        <div className="flex items-center gap-3 py-3">
          <Link href="/" className="flex items-center gap-2.5 min-w-0 rounded-md">
            {/* Inlined, not <Image>: see BrandMark for why currentColor needs to be in-document. */}
            <BrandMark className="shrink-0 text-[var(--brand-mark)]" />
            <span className="flex flex-col leading-tight min-w-0">
              <span className="u-subhead truncate">{APP_TITLE}</span>
              {/* Hidden on the narrowest screens: it is provenance, not navigation. */}
              <span className="hidden sm:block u-label normal-case tracking-widest truncate">
                {TEAM_NAME}
              </span>
            </span>
          </Link>

          {/* On xl+ the nav shares the brand's row; below that it moves to its own row. */}
          <nav data-tour="nav" aria-label="Primary" className="hidden xl:flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto overflow-y-hidden py-1">
            {NAV.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {user && (
              <>
                <div
                  data-tour="user-role"
                  className="hidden sm:flex flex-col items-end leading-tight"
                  title={`Governed queries for this session execute as ${user.personaRole}`}
                >
                  <span className="text-[length:var(--fs-label)] font-medium">{user.username}</span>
                  <span className="u-mono text-muted-foreground">{user.personaRole}</span>
                </div>
                <button
                  onClick={signOut}
                  className="u-meta whitespace-nowrap rounded-md border border-transparent px-2.5 py-1.5 hover:border-border hover:text-foreground hover:bg-secondary transition-colors active:scale-[0.98]"
                >
                  Sign out
                </button>
              </>
            )}
            <ThemeToggle />
          </div>
        </div>

        {/*
          Wraps rather than scrolls below xl. A horizontal scroll strip left Ask and Operations
          off-screen with no affordance a user would notice.
        */}
        <nav aria-label="Primary" className="xl:hidden flex flex-wrap items-center gap-1 pb-2.5">
          {NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>
      </div>
    </header>
  )
}

/** One nav destination. `aria-current` so the active page is announced, not only coloured. */
function NavLink({
  item,
  pathname,
}: {
  item: { href: string; label: string; icon: typeof BarChart3 }
  pathname: string
}) {
  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  const Icon = item.icon
  const dataTour =
    item.href === "/network-risk" ? "network-risk-link"
    : item.href === "/ask" ? "ask-link"
    : item.href === "/consistency" ? "consistency-link"
    : item.href === "/metrics" ? "metrics-link"
    : undefined

  return (
    <Link
      href={item.href}
      data-tour={dataTour}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[length:var(--fs-meta)] whitespace-nowrap transition-colors",
        active
          ? "bg-[color-mix(in_oklab,var(--brand-primary)_12%,var(--secondary))] text-foreground font-semibold"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {item.label}
    </Link>
  )
}
