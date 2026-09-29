/**
 * Serialises the governed ontology as OWL/SKOS, in JSON-LD or Turtle.
 *
 * Nothing here is authored by hand: entities and relationships are the ones read back out of the
 * deployed SC_ONTOLOGY_360 semantic view (GOVERNANCE.ONTOLOGY_ENTITY / ONTOLOGY_RELATIONSHIP), and
 * metrics are the registry rows. The export is a projection of what Snowflake already enforces,
 * so a downstream graph tool (Protégé, a triple store, a data catalogue) sees the same definitions
 * the semantic views execute — not a parallel model that can drift from them.
 *
 * Mapping:
 *   entity        -> owl:Class          (synonyms -> skos:altLabel, base table -> sc:baseObject)
 *   relationship  -> owl:ObjectProperty (rdfs:domain / rdfs:range, join columns -> sc:joinOn)
 *   metric        -> skos:Concept + sc:GovernedMetric (definition, unit, grain, canonical SQL, bindings)
 *   SCOR mapping  -> skos:exactMatch (EXACT) / skos:closeMatch (VARIANT) / skos:related (COMPONENT)
 *
 * SCOR publishes no dereferenceable IRIs, so SCOR codes are minted as `urn:scor:<code>`.
 */

import type { MetricDefinition, OntologyEntity, OntologyRelationship, TrustSignal } from "@/lib/sc"

export const ONTOLOGY_IRI = "urn:snowflake:SUPPLY_CHAIN:ontology"
const SC = "urn:snowflake:SUPPLY_CHAIN:ontology#"

export const PREFIXES: Record<string, string> = {
  sc: SC,
  owl: "http://www.w3.org/2002/07/owl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  dcterms: "http://purl.org/dc/terms/",
}

export interface OntologyExportInput {
  semanticView: string
  entities: OntologyEntity[]
  relationships: OntologyRelationship[]
  metrics: MetricDefinition[]
  trust?: TrustSignal | null
  generatedAt: string
}

/** Snowflake returns ARRAY columns as arrays, JSON strings, or comma lists depending on the path. */
export function asList(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      // fall through to the comma split
    }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

/** Local names must be valid in both a CURIE and a Turtle prefixed name. */
function localName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_")
}

function classId(e: Pick<OntologyEntity, "entity" | "ontologyClass">): string {
  return `sc:${localName(e.ontologyClass || e.entity)}`
}

const SCOR_PREDICATE: Record<string, string | null> = {
  EXACT: "skos:exactMatch",
  VARIANT: "skos:closeMatch",
  COMPONENT: "skos:related",
  NOT_IN_SCOR: null,
}

type Node = Record<string, unknown>

/** The export as a JSON-LD document. The Turtle serialisation is derived from this same graph. */
export function buildJsonLd(input: OntologyExportInput): { "@context": Node; "@graph": Node[] } {
  const byEntity = new Map(input.entities.map((e) => [e.entity.toUpperCase(), e]))
  const graph: Node[] = []

  const header: Node = {
    "@id": ONTOLOGY_IRI,
    "@type": "owl:Ontology",
    "rdfs:label": "Supply Chain Governed Ontology",
    "dcterms:source": `SUPPLY_CHAIN.SEMANTIC.${input.semanticView}`,
    "dcterms:created": { "@value": input.generatedAt, "@type": "xsd:dateTime" },
    "rdfs:comment":
      "Generated from the deployed Snowflake semantic view and GOVERNANCE.METRIC_DEFINITION. " +
      "Edit the semantic view or the registry, not this file.",
  }
  if (input.trust) {
    header["sc:certificationStatus"] = input.trust.certification ?? "NOT_CERTIFIED"
    header["sc:trustLevel"] = input.trust.trustLevel
  }
  graph.push(header)

  graph.push(
    { "@id": "sc:GovernedMetric", "@type": "owl:Class", "rdfs:subClassOf": { "@id": "skos:Concept" }, "rdfs:label": "Governed metric" },
    { "@id": "sc:measures", "@type": "owl:ObjectProperty", "rdfs:domain": { "@id": "sc:GovernedMetric" }, "rdfs:range": { "@id": "owl:Class" } },
  )

  for (const e of input.entities) {
    const node: Node = {
      "@id": classId(e),
      "@type": "owl:Class",
      "rdfs:label": e.ontologyClass || e.entity,
      "sc:entityName": e.entity,
      "sc:entityRole": e.entityRole,
      "sc:baseObject": e.baseObject,
      "sc:primaryKey": asList(e.primaryKeys),
    }
    const syn = asList(e.synonyms)
    if (syn.length) node["skos:altLabel"] = syn
    if (e.description) node["rdfs:comment"] = e.description
    graph.push(node)
  }

  for (const r of input.relationships) {
    const from = byEntity.get(r.fromEntity.toUpperCase())
    const to = byEntity.get(r.toEntity.toUpperCase())
    const fromCols = asList(r.fromColumns)
    const toCols = asList(r.toColumns)
    graph.push({
      "@id": `sc:${localName(r.relationshipName)}`,
      "@type": "owl:ObjectProperty",
      "rdfs:label": r.relationshipName,
      "rdfs:domain": { "@id": from ? classId(from) : `sc:${localName(r.fromEntity)}` },
      "rdfs:range": { "@id": to ? classId(to) : `sc:${localName(r.toEntity)}` },
      "sc:joinOn": fromCols.map((c, i) => `${r.fromEntity}.${c} = ${r.toEntity}.${toCols[i] ?? c}`),
    })
  }

  for (const m of input.metrics) {
    const node: Node = {
      "@id": `sc:metric_${localName(m.metricId)}`,
      "@type": ["sc:GovernedMetric", "skos:Concept"],
      "skos:notation": m.metricId,
      "skos:prefLabel": m.businessName,
      "skos:definition": m.definition,
      "sc:domain": m.domain,
      "sc:grain": m.grain,
      "sc:canonicalFact": m.canonicalFact,
      "sc:canonicalSql": m.canonicalSql,
      "sc:binding": m.bindings.map((b) => `${b.semanticView}:${b.metricReference}`),
    }
    if (m.unit) node["sc:unit"] = m.unit
    if (m.direction) node["sc:direction"] = m.direction
    if (m.ownerRole) node["sc:ownerRole"] = m.ownerRole
    if (m.version != null) node["dcterms:hasVersion"] = String(m.version)
    if (m.target != null) node["sc:target"] = { "@value": m.target, "@type": "xsd:double" }
    if (m.driftStatus) node["sc:driftStatus"] = m.driftStatus

    // The entity a metric measures is the table prefix of its binding in the ontology view.
    const own = m.bindings.find((b) => b.semanticView === input.semanticView)
    const measured = own ? byEntity.get(own.metricReference.split(".")[0].toUpperCase()) : undefined
    if (measured) node["sc:measures"] = { "@id": classId(measured) }

    if (m.scor) {
      node["sc:scorAlignment"] = m.scor.alignment
      const pred = SCOR_PREDICATE[m.scor.alignment]
      if (pred && m.scor.code) node[pred] = { "@id": `urn:scor:${m.scor.code}` }
    }
    graph.push(node)
  }

  return { "@context": { ...PREFIXES }, "@graph": graph }
}

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

function ttlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")}"`
}

function ttlTerm(v: unknown): string {
  if (v && typeof v === "object" && "@id" in (v as Node)) {
    const id = String((v as Node)["@id"])
    return id.includes(":") && !id.startsWith("urn:") && !id.startsWith("http") ? id : `<${id}>`
  }
  if (v && typeof v === "object" && "@value" in (v as Node)) {
    const lit = v as Node
    return `${ttlString(String(lit["@value"]))}^^${lit["@type"]}`
  }
  if (typeof v === "number") return `${ttlString(String(v))}^^xsd:double`
  return ttlString(String(v))
}

function ttlSubject(id: string): string {
  return id.startsWith("urn:") || id.startsWith("http") ? `<${id}>` : id
}

/** Turtle serialisation of the same graph `buildJsonLd` returns. */
export function toTurtle(doc: ReturnType<typeof buildJsonLd>): string {
  const lines: string[] = []
  for (const [p, iri] of Object.entries(doc["@context"])) lines.push(`@prefix ${p}: <${iri}> .`)
  lines.push("")

  for (const node of doc["@graph"]) {
    const { "@id": id, "@type": type, ...props } = node
    const po: string[] = []
    const types = Array.isArray(type) ? type : type ? [type] : []
    if (types.length) po.push(`a ${types.join(", ")}`)
    for (const [pred, val] of Object.entries(props)) {
      const vals = Array.isArray(val) ? val : [val]
      if (vals.length === 0) continue
      po.push(`${pred} ${vals.map(ttlTerm).join(", ")}`)
    }
    lines.push(`${ttlSubject(String(id))}\n    ${po.join(" ;\n    ")} .`)
    lines.push("")
  }
  return lines.join("\n")
}
