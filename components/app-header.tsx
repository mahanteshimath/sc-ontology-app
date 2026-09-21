"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { APP_TITLE, TEAM_NAME } from "@/lib/constants"
import { BrandMark } from "@/components/brand-mark"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/ontology", label: "Ontology" },
  { href: "/metrics", label: "Metric Registry" },
  { href: "/consistency", label: "Consistency" },
  { href: "/outlook", label: "Outlook" },
  { href: "/ask", label: "Ask" },
  { href: "/operations", label: "Operations" },
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
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="w-full max-w-[1400px] mx-auto px-4 sm:px-6">
        <div className="flex items-center gap-3 py-2.5">
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

          {/* On md+ the nav shares the brand's row; below that it moves to its own row. */}
          <nav aria-label="Primary" className="hidden md:flex items-center gap-1 u-scroll-x">
            {NAV.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {user && (
              <>
                <div
                  className="hidden sm:flex flex-col items-end leading-tight"
                  title={`Governed queries for this session execute as ${user.personaRole}`}
                >
                  <span className="text-[length:var(--fs-label)] font-medium">{user.username}</span>
                  <span className="u-mono text-muted-foreground">{user.personaRole}</span>
                </div>
                <button
                  onClick={signOut}
                  className="u-meta whitespace-nowrap px-2 py-1.5 rounded-md hover:text-foreground hover:bg-secondary transition-colors active:scale-[0.98]"
                >
                  Sign out
                </button>
              </>
            )}
            <ThemeToggle />
          </div>
        </div>

        {/*
          Wraps rather than scrolls below md. A horizontal scroll strip left Ask and Operations
          off-screen with no affordance a user would notice, which hid a third of the app; six short
          labels fit two rows at 390px, so every destination is simply visible.
        */}
        <nav aria-label="Primary" className="md:hidden flex flex-wrap items-center gap-1 pb-2">
          {NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>
      </div>
    </header>
  )
}

/** One nav destination. `aria-current` so the active page is announced, not only coloured. */
function NavLink({ item, pathname }: { item: { href: string; label: string }; pathname: string }) {
  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "px-3 py-1.5 rounded-md text-[length:var(--fs-body)] whitespace-nowrap transition-colors",
        active
          ? "bg-secondary text-secondary-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
      )}
    >
      {item.label}
    </Link>
  )
}
