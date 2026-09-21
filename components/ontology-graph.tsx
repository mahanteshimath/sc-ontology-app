"use client"

import { useMemo, useState } from "react"
import type { OntologyEntity, OntologyRelationship } from "@/lib/sc"
import { cn } from "@/lib/utils"

interface Props {
  entities: OntologyEntity[]
  relationships: OntologyRelationship[]
}

const W = 980
const H = 600
const CX = W / 2
const CY = H / 2

/** Node half-extents, needed by the layout so it can keep rectangles from overlapping. */
const DIM_RX = 62
const DIM_RY = 24
const FACT_RX = 70
const FACT_RY = 21

/**
 * Deterministic layout: conformed dimensions on an inner ellipse, facts on an outer one, each fact
 * near the dimensions it references. No layout library, so the diagram renders identically every
 * time and adds no dependencies.
 *
 * Ellipses rather than circles because the canvas is landscape; concentric circles wasted the left
 * and right thirds while crowding top and bottom. The ring radii are also chosen against the node
 * widths: the previous 130/235 circles left a 105px radial gap between rings while a fact box is
 * 140px wide, so any fact sitting at a dimension's angle necessarily overlapped it — which is what
 * put PART through PRODUCTION_ORDER and NODE through FORECAST.
 *
 * A short separation pass then resolves the residual collisions between neighbours on the same ring,
 * which trigonometry alone cannot prevent once labels vary in width.
 */
export function OntologyGraph({ entities, relationships }: Props) {
  const [selected, setSelected] = useState<string | null>(null)

  const layout = useMemo(() => {
    const dims = entities.filter((e) => e.entityRole === "DIMENSION")
    const facts = entities.filter((e) => e.entityRole !== "DIMENSION")
    const pos = new Map<string, { x: number; y: number }>()

    const dimRx = 178
    const dimRy = 108
    dims.forEach((d, i) => {
      const a = (i / Math.max(dims.length, 1)) * Math.PI * 2 - Math.PI / 2
      pos.set(d.entity, { x: CX + dimRx * Math.cos(a), y: CY + dimRy * Math.sin(a) })
    })

    // Place each fact at the average angle of the dimensions it points to.
    const factRx = 372
    const factRy = 232
    const angleOf = (x: number, y: number) => Math.atan2(y - CY, x - CX)
    const factAngles = facts.map((f) => {
      const targets = relationships
        .filter((r) => r.fromEntity === f.entity)
        .map((r) => pos.get(r.toEntity))
        .filter(Boolean) as { x: number; y: number }[]
      if (targets.length === 0) return { entity: f.entity, angle: null as number | null }
      const sx = targets.reduce((s, t) => s + Math.cos(angleOf(t.x, t.y)), 0)
      const sy = targets.reduce((s, t) => s + Math.sin(angleOf(t.x, t.y)), 0)
      return { entity: f.entity, angle: Math.atan2(sy, sx) }
    })

    // Spread facts evenly but seeded by their preferred angle, so edges rarely cross.
    const ordered = [...factAngles].sort((a, b) => (a.angle ?? 99) - (b.angle ?? 99))
    ordered.forEach((f, i) => {
      const a = (i / Math.max(ordered.length, 1)) * Math.PI * 2 - Math.PI / 2
      pos.set(f.entity, { x: CX + factRx * Math.cos(a), y: CY + factRy * Math.sin(a) })
    })

    /*
     * Separation pass.
     *
     * Rectangles, not circles: two nodes only collide when they overlap on BOTH axes, so the
     * smaller of the two penetrations is resolved. Pushing along the lesser axis keeps a node near
     * the angle its relationships earned it. Bounded iterations, no randomness — the diagram must
     * stay byte-identical between renders.
     */
    const half = (name: string) =>
      dims.some((d) => d.entity === name)
        ? { x: DIM_RX + 10, y: DIM_RY + 9 }
        : { x: FACT_RX + 10, y: FACT_RY + 9 }

    const names = entities.map((e) => e.entity).filter((n) => pos.has(n))
    for (let iter = 0; iter < 24; iter++) {
      let moved = false
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = pos.get(names[i])!
          const b = pos.get(names[j])!
          const ha = half(names[i])
          const hb = half(names[j])
          const minX = ha.x + hb.x
          const minY = ha.y + hb.y
          const dx = b.x - a.x
          const dy = b.y - a.y
          const overlapX = minX - Math.abs(dx)
          const overlapY = minY - Math.abs(dy)
          if (overlapX <= 0 || overlapY <= 0) continue

          moved = true
          // Resolve along whichever axis needs the least movement.
          if (overlapX / minX < overlapY / minY) {
            const push = (overlapX / 2) * (dx === 0 ? 1 : Math.sign(dx))
            a.x -= push
            b.x += push
          } else {
            const push = (overlapY / 2) * (dy === 0 ? 1 : Math.sign(dy))
            a.y -= push
            b.y += push
          }
        }
      }
      if (!moved) break
    }

    // Keep every node fully inside the viewBox after separation.
    for (const n of names) {
      const p = pos.get(n)!
      const h = half(n)
      p.x = Math.min(W - h.x, Math.max(h.x, p.x))
      p.y = Math.min(H - h.y, Math.max(h.y, p.y))
    }

    return { pos, dims, facts }
  }, [entities, relationships])

  const highlighted = useMemo(() => {
    if (!selected) return null
    const related = new Set<string>([selected])
    for (const r of relationships) {
      if (r.fromEntity === selected) related.add(r.toEntity)
      if (r.toEntity === selected) related.add(r.fromEntity)
    }
    return related
  }, [selected, relationships])

  const isDim = (name: string) => layout.dims.some((d) => d.entity === name)
  const dimmed = (name: string) => highlighted !== null && !highlighted.has(name)

  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Ontology entity relationship graph">
        {/*
          Edges bow away from the centre.
          Sixteen straight chords all crossed the middle of the diagram and passed underneath the
          CALENDAR and INVENTORY boxes, so the "one path per fact to each dimension" claim was
          unreadable from the picture. A quadratic curve displaced perpendicular to the chord keeps
          each edge in open space and makes parallel relationships distinguishable.
        */}
        {relationships.map((r) => {
          const a = layout.pos.get(r.fromEntity)
          const b = layout.pos.get(r.toEntity)
          if (!a || !b) return null
          const faded = highlighted !== null && !(highlighted.has(r.fromEntity) && highlighted.has(r.toEntity))

          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          // Perpendicular offset, signed so the bow always moves away from the graph centre.
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.hypot(dx, dy) || 1
          const outward = Math.sign((mx - CX) * -dy + (my - CY) * dx) || 1
          const bow = Math.min(46, len * 0.16) * outward
          const qx = mx + (-dy / len) * bow
          const qy = my + (dx / len) * bow

          return (
            <path
              key={r.relationshipName}
              d={`M ${a.x} ${a.y} Q ${qx} ${qy} ${b.x} ${b.y}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              opacity={faded ? 0.1 : 0.45}
              className="text-muted-foreground transition-opacity duration-200"
            />
          )
        })}

        {/* entity nodes */}
        {entities.map((e) => {
          const p = layout.pos.get(e.entity)
          if (!p) return null
          const dim = isDim(e.entity)
          const rx = dim ? DIM_RX : FACT_RX
          const ry = dim ? DIM_RY : FACT_RY
          const faded = dimmed(e.entity)
          return (
            <g
              key={e.entity}
              transform={`translate(${p.x},${p.y})`}
              opacity={faded ? 0.25 : 1}
              className="cursor-pointer transition-opacity duration-200"
              onClick={() => setSelected(selected === e.entity ? null : e.entity)}
            >
              <rect
                x={-rx}
                y={-ry}
                width={rx * 2}
                height={ry * 2}
                rx={dim ? 12 : 4}
                className={cn(
                  dim ? "fill-primary/15 stroke-primary" : "fill-secondary stroke-border",
                  selected === e.entity && "stroke-[2.5px]",
                )}
                strokeWidth={1.4}
              />
              <text
                textAnchor="middle"
                y={dim ? -2 : 0}
                className="fill-foreground text-[11px] font-semibold"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {e.entity.length > 17 ? `${e.entity.slice(0, 16)}…` : e.entity}
              </text>
              {dim && (
                <text textAnchor="middle" y={12} className="fill-muted-foreground text-[10px]">
                  {e.ontologyClass ?? "dimension"}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div className="flex items-center gap-4 px-3 pb-2 pt-1 flex-wrap text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[4px] border border-primary bg-primary/15" /> conformed dimension
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[2px] border border-border bg-secondary" /> fact
        </span>
        <span className="ml-auto">
          {selected ? `${selected} selected — click again to clear` : "click an entity to isolate its relationships"}
        </span>
      </div>
    </div>
  )
}
