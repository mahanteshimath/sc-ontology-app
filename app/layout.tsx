import type { Metadata } from "next"
import type React from "react"
import { AppHeader } from "@/components/app-header"
import { OnboardingTour } from "@/components/onboarding-tour"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import { currentSession } from "@/lib/session"
import "./globals.css"

export const metadata: Metadata = {
  title: APP_TITLE,
  description:
    "Governed conversational analytics over a supply chain ontology: one set of canonical metric definitions, proven to resolve identically for planning, procurement and logistics.",
  icons: { icon: LOGO_SRC },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Read once here rather than in every page: the header needs it and the value is request-scoped.
  const session = await currentSession()

  return (
    <html lang="en" className="overflow-x-hidden w-full max-w-full" suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      </head>
      <body className="antialiased min-h-screen bg-background text-foreground overflow-x-hidden w-full max-w-full">
        <ThemeProvider>
          <QueryProvider>
            <AppHeader
              user={session ? { username: session.username, personaRole: session.personaRole } : null}
            />
            {children}
            <OnboardingTour
              user={session ? { username: session.username, personaRole: session.personaRole } : null}
            />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
