/**
 * Deterministic disambiguation of the two metric pairs that share a name.
 *
 * "On-time delivery" is two governed metrics: supplier OTD (inbound - did suppliers meet the dates
 * they promised us) and customer OTD (outbound - did we meet the dates we promised customers).
 * "Freight cost" is two: accrued freight and invoiced freight. The resolver prompt says to treat an
 * unqualified question as ambiguous, and the model regularly ignores that and quietly picks one
 * side - which is the exact conflation this ontology exists to prevent (eval Q54, Q55).
 *
 * So the rule is enforced in code, not requested in prose: when the resolver returns exactly one
 * member of an ambiguous pair, and the question carries nothing that selects a side, both members
 * are answered and the reason says why. Showing both, labelled, beats guessing one - and it beats
 * refusing, because the user gets both numbers and learns that they are different.
 *
 * Narrow on purpose. It never fires when the resolver chose more than that one metric (a question
 * like "fill rate and on-time delivery together" is already outbound by context), or when the
 * question names a side, a counterparty, or any breakdown.
 */

interface Pair {
  ids: [string, string]
  /** The term that makes the question ambiguous. */
  trigger: RegExp
  /** Anything that selects a side or narrows the question - if present, leave the resolver alone. */
  qualifiers: RegExp
  note: string
}

const PAIRS: Pair[] = [
  {
    ids: ["otd_pct", "supplier_otd_pct"],
    trigger: /\b(on[- ]?time|otd)\b/i,
    qualifiers:
      /\b(suppliers?|vendors?|inbound|receipts?|received|purchase|sourcing|customers?|outbound|shipped|shipping|deliver(ing|ed)? to|orders?|famil(y|ies)|regions?|carriers?|plants?|nodes?|targets?|in full|otif|fill)\b/i,
    note:
      '"On-time delivery" names two governed metrics - supplier OTD (inbound: did suppliers meet the dates they promised us) and customer OTD (outbound: did we meet the dates we promised customers). Both are shown; they are different facts and are never combined.',
  },
  {
    ids: ["freight_cost_usd", "freight_invoiced_usd"],
    trigger: /\bfreight\b/i,
    qualifiers: /\b(accru\w*|invoic\w*|bill(ed|ing)?|variance|carriers?|lanes?|expedit\w*|premium|per unit|landed)\b/i,
    note:
      '"Freight cost" names two governed metrics - freight accrued (what we booked) and freight invoiced (what carriers billed). Both are shown; the gap between them is Freight Bill Variance.',
  },
]

export interface Disambiguation {
  metricIds: string[]
  /** Set when the rule added a metric; appended to the answer's reason. */
  note: string | null
}

export function disambiguate(question: string, metricIds: string[], availableIds: string[]): Disambiguation {
  if (metricIds.length !== 1) return { metricIds, note: null }
  const [only] = metricIds
  for (const p of PAIRS) {
    if (!p.ids.includes(only)) continue
    if (!p.trigger.test(question) || p.qualifiers.test(question)) return { metricIds, note: null }
    const other = p.ids.find((id) => id !== only)!
    // Only add what this persona may actually ask about - never widen access to break a tie.
    if (!availableIds.includes(other)) return { metricIds, note: null }
    return { metricIds: [p.ids[0], p.ids[1]], note: p.note }
  }
  return { metricIds, note: null }
}
