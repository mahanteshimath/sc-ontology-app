/**
 * The brief's value chain, drawn from the deployed SC_VALUE_CHAIN semantic view.
 *
 * Each arrow is checked against the relationships Snowflake reports for the view, so a missing
 * or renamed join shows up here as a broken link instead of a diagram that silently lies. The
 * parity row proves the chain view and SC_ONTOLOGY_360 return the identical value for every
 * shared metric — a second view over the same facts cannot become a second answer.
 */

import type { OntologyRelationship } from "@/lib/sc"
import { formatMetricValue } from "@/lib/format"

/** Chain order and the relationship that must exist between each consecutive pair. */
const LINKS: { from: string; to: string; label: string; rel: string; reverse?: boolean }[] = [
  { from: "SUPPLIER", to: "PART", label: "supplies", rel: "SUPPLY_TO_PART" },
  { from: "PART", to: "PLANT", label: "made at", rel: "PRODUCTION_TO_PLANT" },
  { from: "PLANT", to: "SHIPMENT", label: "ships", rel: "SHIPMENT_TO_PLANT", reverse: true },
  { from: "SHIPMENT", to: "CUSTOMER_ORDER", label: "fulfils", rel: "SHIPMENT_TO_ORDER" },
  { from: "CUSTOMER_ORDER", to: "CUSTOMER", label: "placed by", rel: "ORDER_TO_CUSTOMER" },
]

const NAMES: Record<string, string> = {
  SUPPLIER: "Supplier",
  PART: "Part",
  PLANT: "Plant",
  SHIPMENT: "Shipment",
  CUSTOMER_ORDER: "Customer Order",
  CUSTOMER: "Customer",
}

export interface ChainParity {
  metric: string
  unit: string
  chain: number | null
  ontology360: number | null
}

export function ValueChain({
  relationships,
  parity,
}: {
  relationships: OntologyRelationship[]
  parity: ChainParity[]
}) {
  const names = new Set(relationships.map((r) => r.relationshipName))
  const nodes = ["SUPPLIER", "PART", "PLANT", "SHIPMENT", "CUSTOMER_ORDER", "CUSTOMER"]
  const allLinked = LINKS.every((l) => names.has(l.rel))
  const allMatch = parity.length > 0 && parity.every((p) => p.chain !== null && p.chain === p.ontology360)

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4" data-testid="value-chain">
      <ol className="flex flex-wrap items-center gap-y-3" aria-label="Supply chain value chain">
        {nodes.map((n, i) => {
          const link = LINKS[i]
          const ok = link ? names.has(link.rel) : true
          return (
            <li key={n} className="flex items-center">
              <span className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium">
                {NAMES[n]}
              </span>
              {link && (
                <span
                  className={`mx-2 flex flex-col items-center text-[11px] ${ok ? "text-muted-foreground" : "u-bad"}`}
                  title={ok ? `Declared as ${link.rel} in SC_VALUE_CHAIN` : `${link.rel} is missing from the deployed view`}
                >
                  <span>{link.label}</span>
                  <span aria-hidden>{ok ? "──▶" : "─✕─"}</span>
                  <span className="font-mono">{link.rel.toLowerCase()}</span>
                </span>
              )}
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className={allLinked ? "u-good" : "u-bad"}>
          {allLinked ? `All ${LINKS.length} chain links declared in the deployed view` : "Chain incomplete in the deployed view"}
        </span>
        {parity.length > 0 && (
          <span className={allMatch ? "u-good" : "u-bad"}>
            {allMatch
              ? `Identical to SC_ONTOLOGY_360 on all ${parity.length} shared metrics`
              : "Differs from SC_ONTOLOGY_360"}
          </span>
        )}
      </div>

      {parity.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">Metric</th>
              <th className="py-1 font-medium text-right">SC_VALUE_CHAIN</th>
              <th className="py-1 font-medium text-right">SC_ONTOLOGY_360</th>
            </tr>
          </thead>
          <tbody>
            {parity.map((p) => (
              <tr key={p.metric} className="border-t border-border">
                <td className="py-1 font-mono">{p.metric}</td>
                <td className="py-1 text-right tabular-nums">{formatMetricValue(p.chain, p.unit)}</td>
                <td className="py-1 text-right tabular-nums">{formatMetricValue(p.ontology360, p.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
