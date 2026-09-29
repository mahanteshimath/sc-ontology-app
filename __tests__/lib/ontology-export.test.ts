import { describe, it, expect } from "vitest"
import { asList, buildJsonLd, toTurtle, ONTOLOGY_IRI } from "@/lib/ontology-export"
import type { MetricDefinition, OntologyEntity, OntologyRelationship } from "@/lib/sc"

const entities: OntologyEntity[] = [
  {
    semanticView: "SC_ONTOLOGY_360", entity: "SHIPMENT", ontologyClass: "Shipment", entityRole: "FACT",
    baseObject: "SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT", primaryKeys: ["SHIPMENT_ID"],
    synonyms: '["shipment","delivery"]', description: 'An outbound "delivery"', dimensionCount: 4, metricCount: 3,
  },
  {
    semanticView: "SC_ONTOLOGY_360", entity: "CUSTOMER", ontologyClass: "Customer", entityRole: "DIMENSION",
    baseObject: "SUPPLY_CHAIN.RAW.CUSTOMER", primaryKeys: ["CUSTOMER_ID"], synonyms: null, description: null,
    dimensionCount: 2, metricCount: 0,
  },
]

const relationships: OntologyRelationship[] = [
  { relationshipName: "SHIPMENT_TO_CUSTOMER", fromEntity: "SHIPMENT", toEntity: "CUSTOMER", fromColumns: '["CUSTOMER_ID"]', toColumns: '["CUSTOMER_ID"]' },
]

function metric(over: Partial<MetricDefinition>): MetricDefinition {
  return {
    metricId: "otd_pct", businessName: "On-time delivery", domain: "Fulfillment", definition: "Delivered by promise date",
    numerator: null, denominator: null, grain: "shipment", canonicalFact: "FCT_SHIPMENT", canonicalSql: "SELECT AVG(on_time)",
    unit: "ratio", direction: "HIGHER_IS_BETTER", ownerRole: "SC_LOGISTICS", version: 2, effectiveFrom: null,
    bindings: [{ semanticView: "SC_ONTOLOGY_360", metricReference: "shipment.otd_pct", personaRole: null }],
    driftStatus: "PASS", driftSpread: 0, canonicalValue: 0.88, asOfScope: null, asOfRule: null,
    target: 0.95, warnThreshold: null, failThreshold: null, targetSource: null,
    scor: { code: "RL.2.2", metric: "% Orders Delivered On Time", attribute: "Reliability", process: "Deliver", alignment: "EXACT", note: "" },
    ...over,
  }
}

const input = {
  semanticView: "SC_ONTOLOGY_360",
  entities,
  relationships,
  metrics: [
    metric({}),
    metric({ metricId: "ppv_usd", businessName: "PPV", bindings: [], scor: { code: null, metric: "-", attribute: "Cost", process: "Source", alignment: "NOT_IN_SCOR", note: "" } }),
  ],
  trust: {
    semanticView: "SC_ONTOLOGY_360", certification: "CERTIFIED", dqChecks: 13, dqPassed: 13, checkedAt: null,
    metricBindings: 15, bindingsDriftPass: 15, driftAt: null, trustLevel: "TRUSTED" as const,
  },
  generatedAt: "2026-09-29T00:00:00.000Z",
}

const byId = (doc: ReturnType<typeof buildJsonLd>, id: string) => doc["@graph"].find((n) => n["@id"] === id)

describe("asList", () => {
  it("accepts arrays, JSON strings, comma lists and nulls", () => {
    expect(asList(["A", "B"])).toEqual(["A", "B"])
    expect(asList('["A","B"]')).toEqual(["A", "B"])
    expect(asList("A, B")).toEqual(["A", "B"])
    expect(asList(null)).toEqual([])
    expect(asList("")).toEqual([])
  })
})

describe("buildJsonLd", () => {
  const doc = buildJsonLd(input)

  it("declares the ontology with its source view and trust state", () => {
    const head = byId(doc, ONTOLOGY_IRI)!
    expect(head["@type"]).toBe("owl:Ontology")
    expect(head["dcterms:source"]).toBe("SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360")
    expect(head["sc:certificationStatus"]).toBe("CERTIFIED")
    expect(head["sc:trustLevel"]).toBe("TRUSTED")
  })

  it("maps entities to OWL classes with synonyms as altLabels", () => {
    const ship = byId(doc, "sc:Shipment")!
    expect(ship["@type"]).toBe("owl:Class")
    expect(ship["skos:altLabel"]).toEqual(["shipment", "delivery"])
    expect(ship["sc:primaryKey"]).toEqual(["SHIPMENT_ID"])
    expect(byId(doc, "sc:Customer")!["skos:altLabel"]).toBeUndefined()
  })

  it("maps relationships to object properties with domain, range and join", () => {
    const rel = byId(doc, "sc:SHIPMENT_TO_CUSTOMER")!
    expect(rel["rdfs:domain"]).toEqual({ "@id": "sc:Shipment" })
    expect(rel["rdfs:range"]).toEqual({ "@id": "sc:Customer" })
    expect(rel["sc:joinOn"]).toEqual(["SHIPMENT.CUSTOMER_ID = CUSTOMER.CUSTOMER_ID"])
  })

  it("maps metrics to governed concepts linked to the entity they measure and to SCOR", () => {
    const m = byId(doc, "sc:metric_otd_pct")!
    expect(m["skos:notation"]).toBe("otd_pct")
    expect(m["sc:measures"]).toEqual({ "@id": "sc:Shipment" })
    expect(m["skos:exactMatch"]).toEqual({ "@id": "urn:scor:RL.2.2" })
    expect(m["sc:binding"]).toEqual(["SC_ONTOLOGY_360:shipment.otd_pct"])
  })

  it("does not invent a SCOR link for a metric SCOR does not define", () => {
    const m = byId(doc, "sc:metric_ppv_usd")!
    expect(m["sc:scorAlignment"]).toBe("NOT_IN_SCOR")
    expect(m["skos:exactMatch"]).toBeUndefined()
    expect(m["skos:closeMatch"]).toBeUndefined()
    expect(m["sc:measures"]).toBeUndefined()
  })
})

describe("toTurtle", () => {
  const ttl = toTurtle(buildJsonLd(input))

  it("emits prefixes and one statement block per node", () => {
    expect(ttl).toContain("@prefix owl: <http://www.w3.org/2002/07/owl#> .")
    expect(ttl).toContain(`<${ONTOLOGY_IRI}>\n    a owl:Ontology`)
    expect(ttl).toContain("sc:Shipment\n    a owl:Class")
    expect(ttl).toContain("skos:exactMatch <urn:scor:RL.2.2>")
  })

  it("escapes quotes in literals and types numbers", () => {
    expect(ttl).toContain('rdfs:comment "An outbound \\"delivery\\""')
    expect(ttl).toContain('sc:target "0.95"^^xsd:double')
  })
})
