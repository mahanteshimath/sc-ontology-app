/**
 * Many sources, one definition.
 *
 * The brief's problem in one table: each source system answers "what is our on-time delivery?"
 * with its own native definition, and they disagree. The governed metric is the one answer every
 * persona gets. Values are computed live from GOVERNANCE.V_SOURCE_DEFINITION_SPREAD.
 */

import { formatMetricValue } from "@/lib/format"

interface SpreadRow {
  direction: string
  sourceSystem: string
  nativeDefinition: string
  value: number | null
  isGoverned: boolean
}

interface MapRow {
  sourceSystem: string
  sourceObject: string
  sourceAttribute: string
  sourceEncoding: string
  ontologyRef: string
  transformation: string
}

export function SourceSpread({ spread, mapping }: { spread: SpreadRow[]; mapping: MapRow[] }) {
  const directions = [...new Set(spread.map((s) => s.direction))]
  return (
    <div className="space-y-4" data-testid="source-spread">
      <div className="grid gap-3 md:grid-cols-2">
        {directions.map((d) => {
          const rows = spread.filter((s) => s.direction === d)
          const ungoverned = rows.filter((r) => !r.isGoverned && r.value !== null).map((r) => r.value as number)
          const span = ungoverned.length > 1 ? Math.max(...ungoverned) - Math.min(...ungoverned) : 0
          return (
            <div key={d} className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{d === "INBOUND" ? "Supplier OTD" : "Customer OTD"}</span>
                <span className="text-[11px] u-warn">
                  sources disagree by {(span * 100).toFixed(1)} pts
                </span>
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.sourceSystem} className={`border-t border-border ${r.isGoverned ? "font-semibold" : ""}`}>
                      <td className="py-1.5 pr-2 align-top">
                        <div>{r.sourceSystem}</div>
                        <div className="text-[11px] font-normal text-muted-foreground">{r.nativeDefinition}</div>
                      </td>
                      <td className={`py-1.5 text-right tabular-nums align-top ${r.isGoverned ? "u-good" : ""}`}>
                        {formatMetricValue(r.value, "ratio")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>

      {mapping.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Source-to-ontology mapping · {mapping.length} attributes from {new Set(mapping.map((m) => m.sourceSystem)).size} systems
          </summary>
          <div className="overflow-auto border-t border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-medium">System</th>
                  <th className="px-3 py-1.5 font-medium">Native attribute</th>
                  <th className="px-3 py-1.5 font-medium">Encoding</th>
                  <th className="px-3 py-1.5 font-medium">Ontology</th>
                  <th className="px-3 py-1.5 font-medium">Transformation</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m) => (
                  <tr key={`${m.sourceObject}.${m.sourceAttribute}`} className="border-t border-border">
                    <td className="px-3 py-1.5">{m.sourceSystem}</td>
                    <td className="px-3 py-1.5 font-mono">{m.sourceAttribute}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{m.sourceEncoding}</td>
                    <td className="px-3 py-1.5 font-mono">{m.ontologyRef}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.transformation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
