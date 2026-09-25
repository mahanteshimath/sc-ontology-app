"use client"

import { useMemo, useState } from "react"
import type { OntologyEntity, OntologyRelationship } from "@/lib/sc"
import { cn } from "@/lib/utils"
import { Search, Layers, CircleDot } from "lucide-react"

interface Props {
  entities: OntologyEntity[]
  relationships: OntologyRelationship[]
}

const W = 1040
const H = 660

/** Pre-calculated 3-tier grid positions for clean visual separation and zero overlap */
const FIXED_POSITIONS: Record<string, { x: number; y: number; tier: "top" | "middle" | "bottom" }> = {
  // Top Tier: Inbound & Fulfillment Facts
  PURCHASE_ORDER: { x: 150, y: 100, tier: "top" },
  SHIPMENT_TELEMETRY: { x: 390, y: 100, tier: "top" },
  ORDER_FULFILLMENT: { x: 650, y: 100, tier: "top" },
  LANDED_COST: { x: 890, y: 100, tier: "top" },

  // Middle Tier: 5 Core Conformed Dimensions
  SUPPLIER: { x: 130, y: 340, tier: "middle" },
  CALENDAR: { x: 320, y: 340, tier: "middle" },
  PART: { x: 520, y: 340, tier: "middle" },
  NODE: { x: 710, y: 340, tier: "middle" },
  CUSTOMER: { x: 900, y: 340, tier: "middle" },

  // Bottom Tier: Planning, Manufacturing & Inventory Facts
  FORECAST: { x: 250, y: 560, tier: "bottom" },
  PRODUCTION_ORDER: { x: 520, y: 560, tier: "bottom" },
  INVENTORY: { x: 790, y: 560, tier: "bottom" },
}

export function OntologyGraph({ entities, relationships }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [hoveredEntity, setHoveredEntity] = useState<string | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<OntologyRelationship | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [viewMode, setViewMode] = useState<"tiered" | "radial">("tiered")
  const [filterRole, setFilterRole] = useState<"ALL" | "DIMENSION" | "FACT">("ALL")

  // Compute node coordinates based on view mode
  const layout = useMemo(() => {
    const dims = entities.filter((e) => e.entityRole === "DIMENSION")
    const facts = entities.filter((e) => e.entityRole !== "DIMENSION")
    const pos = new Map<string, { x: number; y: number }>()

    if (viewMode === "tiered") {
      let unmappedTop = 0
      let unmappedBottom = 0
      entities.forEach((e) => {
        if (FIXED_POSITIONS[e.entity]) {
          pos.set(e.entity, { x: FIXED_POSITIONS[e.entity].x, y: FIXED_POSITIONS[e.entity].y })
        } else if (e.entityRole === "DIMENSION") {
          pos.set(e.entity, { x: 200 + (dims.length * 120), y: 340 })
        } else {
          const isTop = unmappedTop <= unmappedBottom
          if (isTop) {
            pos.set(e.entity, { x: 150 + unmappedTop * 220, y: 100 })
            unmappedTop++
          } else {
            pos.set(e.entity, { x: 200 + unmappedBottom * 240, y: 560 })
            unmappedBottom++
          }
        }
      })
    } else {
      // Radial layout with larger radii to avoid crowding
      const CX = W / 2
      const CY = H / 2
      const dimRx = 210
      const dimRy = 130
      dims.forEach((d, i) => {
        const a = (i / Math.max(dims.length, 1)) * Math.PI * 2 - Math.PI / 2
        pos.set(d.entity, { x: CX + dimRx * Math.cos(a), y: CY + dimRy * Math.sin(a) })
      })

      const factRx = 410
      const factRy = 260
      facts.forEach((f, i) => {
        const a = (i / Math.max(facts.length, 1)) * Math.PI * 2 - Math.PI / 2
        pos.set(f.entity, { x: CX + factRx * Math.cos(a), y: CY + factRy * Math.sin(a) })
      })
    }

    return { pos, dims, facts }
  }, [entities, viewMode])

  // Active highlighted entities (selected or hovered)
  const activeFocus = selected || hoveredEntity

  const highlighted = useMemo(() => {
    if (!activeFocus) return null
    const related = new Set<string>([activeFocus])
    for (const r of relationships) {
      if (r.fromEntity === activeFocus) related.add(r.toEntity)
      if (r.toEntity === activeFocus) related.add(r.fromEntity)
    }
    return related
  }, [activeFocus, relationships])

  // Active entity object for detail popover
  const selectedEntityObj = useMemo(() => {
    if (!selected) return null
    return entities.find((e) => e.entity === selected) || null
  }, [selected, entities])

  // Related relationships for selected entity
  const activeRelationships = useMemo(() => {
    if (!activeFocus) return []
    return relationships.filter(
      (r) => r.fromEntity === activeFocus || r.toEntity === activeFocus
    )
  }, [activeFocus, relationships])

  // Search matching entities
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    return new Set(
      entities
        .filter(
          (e) =>
            e.entity.toLowerCase().includes(q) ||
            e.description?.toLowerCase().includes(q) ||
            e.baseObject?.toLowerCase().includes(q)
        )
        .map((e) => e.entity)
    )
  }, [searchQuery, entities])

  const isDim = (name: string) => layout.dims.some((d) => d.entity === name)

  const isNodeDimmed = (name: string) => {
    if (filterRole === "DIMENSION" && !isDim(name)) return true
    if (filterRole === "FACT" && isDim(name)) return true
    if (searchMatches && !searchMatches.has(name)) return true
    if (highlighted !== null && !highlighted.has(name)) return true
    return false
  }

  const isEdgeDimmed = (r: OntologyRelationship) => {
    if (filterRole === "DIMENSION" && (!isDim(r.fromEntity) || !isDim(r.toEntity))) return true
    if (filterRole === "FACT" && isDim(r.fromEntity) && isDim(r.toEntity)) return true
    if (searchMatches && !searchMatches.has(r.fromEntity) && !searchMatches.has(r.toEntity)) return true
    if (hoveredEdge) return hoveredEdge.relationshipName !== r.relationshipName
    if (highlighted !== null) {
      return !(highlighted.has(r.fromEntity) && highlighted.has(r.toEntity))
    }
    return false
  }

  return (
    <div className="rounded-xl border border-border/70 bg-card/90 backdrop-blur-md p-4 shadow-xl space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-border/50">
        {/* Search Input */}
        <div className="relative min-w-[220px] flex-1 sm:flex-initial">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search entity or column..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-secondary/60 border border-border focus:outline-none focus:ring-1 focus:ring-primary/60 placeholder:text-muted-foreground/60 transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>

        {/* Filter Role Chips */}
        <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg border border-border/40 text-xs">
          <button
            onClick={() => setFilterRole("ALL")}
            className={cn(
              "px-2.5 py-1 rounded-md transition-all font-medium text-[11px]",
              filterRole === "ALL"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            All ({entities.length})
          </button>
          <button
            onClick={() => setFilterRole("DIMENSION")}
            className={cn(
              "px-2.5 py-1 rounded-md transition-all font-medium text-[11px] flex items-center gap-1.5",
              filterRole === "DIMENSION"
                ? "bg-sky-500/15 text-sky-400 border border-sky-500/30"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="size-2 rounded-full bg-sky-400" />
            Dimensions ({layout.dims.length})
          </button>
          <button
            onClick={() => setFilterRole("FACT")}
            className={cn(
              "px-2.5 py-1 rounded-md transition-all font-medium text-[11px] flex items-center gap-1.5",
              filterRole === "FACT"
                ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="size-2 rounded-full bg-purple-400" />
            Facts ({layout.facts.length})
          </button>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg border border-border/40 text-xs">
          <button
            onClick={() => setViewMode("tiered")}
            className={cn(
              "px-2.5 py-1 rounded-md transition-all font-medium text-[11px] flex items-center gap-1.5",
              viewMode === "tiered"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="3-Tier Architectural Layout"
          >
            <Layers className="size-3.5" />
            Tiered Flow
          </button>
          <button
            onClick={() => setViewMode("radial")}
            className={cn(
              "px-2.5 py-1 rounded-md transition-all font-medium text-[11px] flex items-center gap-1.5",
              viewMode === "radial"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Concentric Radial Orbit"
          >
            <CircleDot className="size-3.5" />
            Radial
          </button>
        </div>
      </div>

      {/* Main Diagram Area */}
      <div className="relative rounded-lg border border-border/50 bg-gradient-to-b from-background/40 to-secondary/20 overflow-hidden">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto min-h-[480px] select-none"
          role="img"
          aria-label="Supply Chain Ontology Relationship Graph"
        >
          {/* Tier Background Guides drawn cleanly in SVG with zero overlap */}
          {viewMode === "tiered" && (
            <g className="pointer-events-none">
              {/* Tier 1 Header */}
              <text x={24} y={35} className="fill-purple-400/70 text-[10px] font-mono uppercase font-semibold tracking-wider">
                INBOUND & CUSTOMER FULFILLMENT FACTS
              </text>
              <line x1={24} y1={44} x2={W - 24} y2={44} stroke="currentColor" strokeWidth={0.8} opacity={0.15} />

              {/* Tier 2 Header (positioned at y=230, completely clear of all nodes) */}
              <rect x={16} y={215} width={W - 32} height={28} rx={6} className="fill-sky-500/[0.04] stroke-sky-500/20" strokeWidth={0.8} />
              <text x={28} y={233} className="fill-sky-400/90 text-[10px] font-mono uppercase font-semibold tracking-wider">
                CONFORMED DIMENSIONS (CORE HUB)
              </text>
              <text x={W - 28} y={233} textAnchor="end" className="fill-sky-400/60 text-[10px] font-mono uppercase font-semibold tracking-wider">
                SHARED ACROSS EVERY FACT
              </text>

              {/* Tier 3 Header (positioned at y=475, completely clear of all nodes) */}
              <text x={24} y={475} className="fill-purple-400/70 text-[10px] font-mono uppercase font-semibold tracking-wider">
                PLANNING, MANUFACTURING & INVENTORY FACTS
              </text>
              <line x1={24} y1={484} x2={W - 24} y2={484} stroke="currentColor" strokeWidth={0.8} opacity={0.15} />
            </g>
          )}

          <defs>
            <linearGradient id="edge-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#c084fc" stopOpacity="0.8" />
            </linearGradient>
          </defs>

          {/* Relationships / Connector Edges */}
          {relationships.map((r) => {
            const a = layout.pos.get(r.fromEntity)
            const b = layout.pos.get(r.toEntity)
            if (!a || !b) return null

            const dimmed = isEdgeDimmed(r)
            const isHovered = hoveredEdge?.relationshipName === r.relationshipName
            const isFocused =
              activeFocus && (r.fromEntity === activeFocus || r.toEntity === activeFocus)

            // Smooth curved path calculation
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const dx = b.x - a.x
            const dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1

            let qx = mx
            let qy = my

            if (viewMode === "tiered") {
              const curveness = Math.min(60, len * 0.18)
              qx = mx + (-dy / len) * curveness * 0.6
              qy = my + (dx / len) * curveness * 0.6
            } else {
              const CX = W / 2
              const CY = H / 2
              const outward = Math.sign((mx - CX) * -dy + (my - CY) * dx) || 1
              const bow = Math.min(50, len * 0.15) * outward
              qx = mx + (-dy / len) * bow
              qy = my + (dx / len) * bow
            }

            return (
              <g key={r.relationshipName}>
                {/* Thick invisible stroke for easier hover interaction */}
                <path
                  d={`M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}`}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredEdge(r)}
                  onMouseLeave={() => setHoveredEdge(null)}
                />

                {/* Visible relationship curve */}
                <path
                  d={`M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}`}
                  fill="none"
                  stroke={isFocused || isHovered ? "url(#edge-grad)" : "currentColor"}
                  strokeWidth={isFocused || isHovered ? 2.5 : 1.2}
                  strokeDasharray={isHovered ? "6 4" : undefined}
                  opacity={dimmed ? 0.05 : isFocused || isHovered ? 0.95 : 0.35}
                  className={cn(
                    "transition-all duration-300",
                    !isFocused && !isHovered && "text-muted-foreground/70"
                  )}
                />

                {/* Edge Label on Hover */}
                {isHovered && (
                  <g transform={`translate(${qx}, ${qy})`}>
                    <rect
                      x={-85}
                      y={-12}
                      width={170}
                      height={24}
                      rx={6}
                      className="fill-popover stroke-border shadow-lg"
                    />
                    <text
                      textAnchor="middle"
                      y={4}
                      className="fill-foreground text-[10px] font-mono font-medium"
                    >
                      {r.fromColumns} → {r.toColumns}
                    </text>
                  </g>
                )}
              </g>
            )
          })}

          {/* Entity Nodes */}
          {entities.map((e) => {
            const p = layout.pos.get(e.entity)
            if (!p) return null

            const dim = isDim(e.entity)
            const nodeWidth = dim ? 144 : 156
            const nodeHeight = dim ? 50 : 44
            const rx = nodeWidth / 2
            const ry = nodeHeight / 2

            const dimmed = isNodeDimmed(e.entity)
            const isSelected = selected === e.entity
            const isHovered = hoveredEntity === e.entity
            const isHighlighted = highlighted?.has(e.entity)

            return (
              <g
                key={e.entity}
                transform={`translate(${p.x},${p.y})`}
                opacity={dimmed ? 0.15 : 1}
                className="cursor-pointer transition-all duration-300"
                onClick={() => setSelected(isSelected ? null : e.entity)}
                onMouseEnter={() => setHoveredEntity(e.entity)}
                onMouseLeave={() => setHoveredEntity(null)}
              >
                {/* Outer Glow / Halo for active node */}
                {(isSelected || isHovered) && (
                  <rect
                    x={-rx - 4}
                    y={-ry - 4}
                    width={nodeWidth + 8}
                    height={nodeHeight + 8}
                    rx={dim ? 16 : 8}
                    className={cn(
                      "fill-none stroke-[2.5px] animate-pulse",
                      dim ? "stroke-sky-400/60" : "stroke-purple-400/60"
                    )}
                  />
                )}

                {/* Main Card Background */}
                <rect
                  x={-rx}
                  y={-ry}
                  width={nodeWidth}
                  height={nodeHeight}
                  rx={dim ? 12 : 6}
                  className={cn(
                    "transition-all duration-200",
                    dim
                      ? "fill-sky-950/80 stroke-sky-500/60 hover:stroke-sky-400"
                      : "fill-secondary/90 stroke-border hover:stroke-purple-400/60",
                    isSelected && (dim ? "stroke-sky-400 fill-sky-900/90" : "stroke-purple-400 fill-purple-950/80"),
                    isHighlighted && !isSelected && (dim ? "stroke-sky-400/80" : "stroke-purple-400/80")
                  )}
                  strokeWidth={isSelected ? 2 : 1.4}
                />

                {/* Status Indicator Icon Dot */}
                <circle
                  cx={-rx + 14}
                  cy={0}
                  r={4}
                  className={cn(dim ? "fill-sky-400" : "fill-purple-400")}
                />

                {/* Entity Label */}
                <text
                  x={-rx + 26}
                  y={dim ? -4 : 4}
                  textAnchor="start"
                  className={cn(
                    "font-semibold font-mono tracking-tight transition-colors text-[11px]",
                    dim ? "fill-sky-100" : "fill-foreground"
                  )}
                >
                  {e.entity.length > 17 ? `${e.entity.slice(0, 16)}…` : e.entity}
                </text>

                {/* Subtitle Badge for Dimensions */}
                {dim && (
                  <text
                    x={-rx + 26}
                    y={12}
                    textAnchor="start"
                    className="fill-sky-300/70 text-[9.5px] font-sans"
                  >
                    {e.ontologyClass ?? "Conformed Dim"}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {/* Floating Quick Details Drawer when an entity is selected */}
        {selectedEntityObj && (
          <div className="absolute bottom-3 left-3 right-3 p-3.5 rounded-lg border border-border bg-popover/95 backdrop-blur-lg shadow-2xl space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    selectedEntityObj.entityRole === "DIMENSION" ? "bg-sky-400" : "bg-purple-400"
                  )}
                />
                <h3 className="text-sm font-semibold font-mono">{selectedEntityObj.entity}</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary border border-border text-muted-foreground font-mono">
                  {selectedEntityObj.entityRole}
                </span>
                {selectedEntityObj.ontologyClass && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-400 font-mono">
                    {selectedEntityObj.ontologyClass}
                  </span>
                )}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-secondary"
              >
                Clear Selection
              </button>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              {selectedEntityObj.description || "No description provided for this ontology entity."}
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-border/40 text-[11px]">
              <div className="flex items-center gap-4 text-muted-foreground font-mono">
                <span>Base: <strong className="text-foreground">{selectedEntityObj.baseObject}</strong></span>
                {Boolean(selectedEntityObj.primaryKeys) && (
                  <span>PK: <strong className="text-foreground">{String(selectedEntityObj.primaryKeys)}</strong></span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="text-muted-foreground">Connected Joins:</span>
                <span className="px-2 py-0.5 rounded bg-primary/10 text-primary font-mono">
                  {activeRelationships.length} relationships
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Legend & Helper Notes */}
      <div className="flex items-center justify-between gap-4 px-2 pt-1 flex-wrap text-[11px] text-muted-foreground">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-2.5 rounded-full bg-sky-400" /> Conformed Dimension (Shared Hub)
          </span>
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-2.5 rounded-full bg-purple-400" /> Fact Process Table
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 rounded bg-gradient-to-r from-sky-400 to-purple-400" /> Declared Join Path
          </span>
        </div>

        <div className="text-right text-muted-foreground/80 font-mono text-[10px]">
          {selected
            ? `Click ${selected} again to deselect`
            : "Click any entity or hover a connector line to inspect joins"}
        </div>
      </div>
    </div>
  )
}
