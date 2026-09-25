"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter, usePathname } from "next/navigation"
import {
  Sparkles,
  ChevronRight,
  ChevronLeft,
  X,
  Compass,
  Globe,
  BotMessageSquare,
  ShieldCheck,
  Database,
  CheckCircle2,
  HelpCircle,
} from "lucide-react"

export interface TourStep {
  target: string
  title: string
  description: string
  icon: any
  route?: string
  position?: "bottom" | "top" | "left" | "right"
}

const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="nav"]',
    title: "Governed Module Navigation",
    description: "Switch seamlessly between Operations KPIs, Network Risk maps, Ask AI assistant, Outlook forecasts, Ontology schemas, Metric Registry, and Consistency checks.",
    icon: Compass,
    position: "bottom",
  },
  {
    target: '[data-tour="network-risk-link"]',
    title: "Network Risk & GIS Topology",
    description: "Inspect real-time supply chain disruptions, maritime chokepoints (e.g. Strait of Hormuz, Suez Canal), and corridor SLA impact stress tests on an interactive GIS map.",
    icon: Globe,
    position: "bottom",
  },
  {
    target: '[data-tour="ask-link"]',
    title: "Ask AI Conversational Assistant",
    description: "Ask natural language questions about supply chain metrics and get answers powered by canonical Snowflake SQL execution.",
    icon: BotMessageSquare,
    position: "bottom",
  },
  {
    target: '[data-tour="user-role"]',
    title: "Governed Persona & Role",
    description: "All queries execute under strict row-level governance according to your session role (e.g., SC_PLANNER or 3M-ONTOLOGIST).",
    icon: ShieldCheck,
    position: "bottom",
  },
  {
    target: '[data-tour="sql-provenance"]',
    title: "SQL Provenance & Transparency",
    description: "Every metric has 100% transparent SQL provenance. Click any 'SQL Provenance' button to inspect the canonical Snowflake query behind the numbers.",
    icon: Database,
    position: "bottom",
  },
]

const LOCAL_STORAGE_KEY = "sc_ontology_tour_completed_v1"

export function OnboardingTour({
  user,
}: {
  user: { username: string; personaRole: string } | null
}) {
  const router = useRouter()
  const pathname = usePathname()

  const [tourState, setTourState] = useState<"IDLE" | "WELCOME" | "ACTIVE" | "COMPLETED">("IDLE")
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)

  const activeStep = TOUR_STEPS[currentStepIndex]

  // Update target bounding rect when step changes or window resizes
  const updateTargetRect = useCallback(() => {
    if (tourState !== "ACTIVE" || !activeStep) return

    const element = document.querySelector(activeStep.target)
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })
      const rect = element.getBoundingClientRect()
      setTargetRect(rect)
    } else {
      setTargetRect(null)
    }
  }, [tourState, activeStep])

  // Check initial tour state on mount
  useEffect(() => {
    if (typeof window === "undefined" || !user || pathname === "/login") return
    const isCompleted = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!isCompleted) {
      // Delay welcome modal slightly for smooth page load transition
      const timer = setTimeout(() => {
        setTourState("WELCOME")
      }, 600)
      return () => clearTimeout(timer)
    }
  }, [user, pathname])

  useEffect(() => {
    if (tourState === "ACTIVE") {
      // Small timeout to allow route or DOM changes to stabilize
      const timer = setTimeout(updateTargetRect, 150)
      window.addEventListener("resize", updateTargetRect)
      window.addEventListener("scroll", updateTargetRect)
      return () => {
        clearTimeout(timer)
        window.removeEventListener("resize", updateTargetRect)
        window.removeEventListener("scroll", updateTargetRect)
      }
    }
  }, [tourState, currentStepIndex, updateTargetRect])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (tourState !== "ACTIVE") return
      if (e.key === "ArrowRight") handleNext()
      if (e.key === "ArrowLeft") handlePrev()
      if (e.key === "Escape") handleEndTour()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [tourState, currentStepIndex])

  // Do not render tour or restart button if user is not authenticated or on login screen
  if (!user || pathname === "/login") return null

  const handleStartTour = () => {
    setTourState("ACTIVE")
    setCurrentStepIndex(0)
  }

  const handleNext = () => {
    if (currentStepIndex < TOUR_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1)
    } else {
      handleCompleteTour()
    }
  }

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1)
    }
  }

  const handleCompleteTour = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_STORAGE_KEY, "true")
    }
    setTourState("COMPLETED")
  }

  const handleEndTour = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_STORAGE_KEY, "true")
    }
    setTourState("IDLE")
  }

  // Exposed trigger to restart tour anytime
  const handleRestartTour = () => {
    setTourState("WELCOME")
  }

  return (
    <>
      {/* Restart Tour Quick Button in Header context (rendered in fixed position or exported) */}
      <button
        onClick={handleRestartTour}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-3 py-2 rounded-full border border-primary/40 bg-slate-900/90 text-primary hover:bg-slate-800 shadow-xl backdrop-blur-md text-xs font-semibold transition-all hover:scale-105 active:scale-95"
        title="Start Guided Platform Tour"
      >
        <Sparkles className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: "4s" }} />
        <span>Guided Tour</span>
      </button>

      {/* 1. WELCOME MODAL */}
      {tourState === "WELCOME" && (
        <div className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-2xl border border-primary/30 bg-slate-900 p-6 shadow-2xl text-slate-100 space-y-5 animate-in zoom-in-95 duration-200 text-center overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-1.5 bg-gradient-to-r from-cyan-500 via-primary to-indigo-500" />
            
            <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Sparkles className="w-7 h-7 animate-pulse" />
            </div>

            <div className="space-y-2">
              <h2 className="text-lg font-bold tracking-tight text-white">Welcome to Supply Chain Ontology</h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                Take a 1-minute interactive tour to explore governed metrics, GIS network topology, SQL provenance, and AI conversational analytics.
              </p>
            </div>

            <div className="pt-2 flex items-center gap-3">
              <button
                onClick={handleEndTour}
                className="w-1/2 py-2.5 rounded-xl border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 text-xs font-semibold transition-colors"
              >
                Skip for Now
              </button>
              <button
                onClick={handleStartTour}
                className="w-1/2 py-2.5 rounded-xl bg-primary text-primary-foreground hover:brightness-110 text-xs font-semibold shadow-lg shadow-primary/25 transition-all flex items-center justify-center gap-1.5"
              >
                <span>Start Tour</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. ACTIVE SPOTLIGHT & TOOLTIP POPOVER */}
      {tourState === "ACTIVE" && activeStep && (
        <div className="fixed inset-0 z-[9990] pointer-events-auto">
          {/* Dark SVG Backdrop Mask with Cutout Spotlight */}
          <svg className="w-full h-full absolute inset-0 pointer-events-auto">
            <defs>
              <mask id="spotlight-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                {targetRect && (
                  <rect
                    x={targetRect.left - 6}
                    y={targetRect.top - 6}
                    width={targetRect.width + 12}
                    height={targetRect.height + 12}
                    rx="10"
                    fill="black"
                  />
                )}
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(15, 23, 42, 0.78)"
              mask="url(#spotlight-mask)"
            />
          </svg>

          {/* Animated Glow Outline over Target */}
          {targetRect && (
            <div
              className="absolute pointer-events-none rounded-xl border-2 border-primary shadow-[0_0_25px_rgba(41,181,232,0.8)] animate-pulse"
              style={{
                top: `${targetRect.top - 6}px`,
                left: `${targetRect.left - 6}px`,
                width: `${targetRect.width + 12}px`,
                height: `${targetRect.height + 12}px`,
                transition: "all 0.25s ease-out",
              }}
            />
          )}

          {/* Floating Tooltip Card */}
          <div
            className="absolute z-[9999] w-full max-w-sm rounded-xl border border-border bg-slate-900 p-5 shadow-2xl text-slate-100 space-y-4 animate-in fade-in duration-200"
            style={{
              top: targetRect
                ? `${Math.min(window.innerHeight - 240, Math.max(20, targetRect.bottom + 16))}px`
                : "50%",
              left: targetRect
                ? `${Math.min(window.innerWidth - 380, Math.max(20, targetRect.left))}px`
                : "50%",
              transform: targetRect ? "none" : "translate(-50%, -50%)",
              transition: "all 0.25s ease-out",
            }}
          >
            {/* Header / Step Counter */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                {activeStep.icon && <activeStep.icon className="w-4 h-4 text-primary shrink-0" />}
                <span className="text-xs font-semibold text-slate-200">
                  Step {currentStepIndex + 1} of {TOUR_STEPS.length}
                </span>
              </div>
              <button
                onClick={handleEndTour}
                className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                title="Exit tour"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="space-y-1.5">
              <h3 className="text-sm font-bold text-white">{activeStep.title}</h3>
              <p className="text-xs text-slate-300 leading-relaxed">{activeStep.description}</p>
            </div>

            {/* Footer Navigation */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1">
                {TOUR_STEPS.map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-1.5 rounded-full transition-all ${
                      idx === currentStepIndex ? "w-5 bg-primary" : "w-1.5 bg-slate-700"
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2">
                {currentStepIndex > 0 && (
                  <button
                    onClick={handlePrev}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-medium transition-colors flex items-center gap-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>
                )}

                <button
                  onClick={handleNext}
                  className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:brightness-110 text-xs font-semibold shadow-md transition-all flex items-center gap-1"
                >
                  <span>{currentStepIndex === TOUR_STEPS.length - 1 ? "Finish" : "Next"}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. TOUR COMPLETED MODAL */}
      {tourState === "COMPLETED" && (
        <div className="fixed inset-0 z-[9999] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-md rounded-2xl border border-emerald-500/30 bg-slate-900 p-6 shadow-2xl text-slate-100 space-y-5 animate-in zoom-in-95 duration-200 text-center overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-500" />

            <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-2">
              <h2 className="text-lg font-bold tracking-tight text-white">You&apos;re Ready to Explore!</h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                You have completed the platform walkthrough. You can restart this tour anytime using the bottom-right &quot;Guided Tour&quot; button.
              </p>
            </div>

            <button
              onClick={handleEndTour}
              className="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 hover:bg-emerald-400 text-xs font-bold shadow-lg shadow-emerald-500/20 transition-all"
            >
              Explore Workspace
            </button>
          </div>
        </div>
      )}
    </>
  )
}
