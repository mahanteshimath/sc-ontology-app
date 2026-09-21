import { Suspense } from "react"
import { PageShell, StatTile, Tag, Provenance, Section, SectionSkeleton } from "@/components/ui-kit"
import { getOntologyEntities, getOntologyRelationships, getEntityAttributes } from "@/lib/sc"
import { parseSynonyms } from "@/lib/format"
import { OntologyGraph } from "@/components/ontology-graph"

export const dynamic = "force-dynamic"

/** Hierarchies declared in the ontology, ordered from the lowest level upward. */
const HIERARCHIES = [
  { entity: "PART", name: "Product", levels: ["MATERIAL", "PRODUCT_FAMILY", "BUSINESS_SEGMENT"] },
  { entity: "SUPPLIER", name: "Supplier", levels: ["SUPPLIER", "SUPPLIER_GROUP"] },
  { entity: "NODE", name: "Location", levels: ["NODE", "NODE_REGION"] },
  { entity: "CUSTOMER", name: "Customer", levels: ["CUSTOMER", "CUSTOMER_SEGMENT"] },
  { entity: "CALENDAR", name: "Time", levels: ["CAL_DATE", "CAL_MONTH", "CAL_QUARTER", "CAL_YEAR"] },
]

async function OntologyBody() {
  const [entities, relationships, attributes] = await Promise.all([
    getOntologyEntities(),
    getOntologyRelationships(),
    getEntityAttributes(),
  ])

  const dims = entities.filter((e) => e.entityRole === "DIMENSION")
  const facts = entities.filter((e) => e.entityRole === "FACT")
  const attrsByEntity = new Map<string, typeof attributes>()
  for (const a of attributes) {
    if (!attrsByEntity.has(a.entity)) attrsByEntity.set(a.entity, [])
    attrsByEntity.get(a.entity)!.push(a)
  }

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Entities" value={String(entities.length)} sub="Ontology classes modelled" />
        <StatTile label="Conformed dimensions" value={String(dims.length)} sub="Shared across every fact" />
        <StatTile label="Facts" value={String(facts.length)} sub="Business processes measured" />
        <StatTile
          label="Relationships"
          value={String(relationships.length)}
          sub="Declared joins, one path per fact to each dimension"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Entity relationship model</h2>
        <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
          A multi-fact conformed-dimension layout. Each fact reaches every shared dimension by exactly one path, which is
          what allows procurement, logistics, planning and manufacturing metrics to be combined in a single question
          without a fan trap or a multi-path error.
        </p>
        <OntologyGraph entities={entities} relationships={relationships} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Hierarchies</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {HIERARCHIES.map((h) => (
            <div key={h.name} className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm font-medium">{h.name}</div>
              <div className="text-[11px] text-muted-foreground font-mono mb-2">{h.entity}</div>
              <ol className="space-y-1">
                {h.levels.map((lvl, i) => (
                  <li key={lvl} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground tabular-nums w-4">{h.levels.length - i}</span>
                    <span className="font-mono text-foreground/90">{lvl.toLowerCase()}</span>
                  </li>
                ))}
              </ol>
              <div className="text-[11px] text-muted-foreground mt-2">
                rolls up {h.levels.length} levels
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Entity catalogue</h2>
        <div className="space-y-3">
          {entities.map((e) => {
            const attrs = attrsByEntity.get(e.entity) ?? []
            const entityDims = attrs.filter((a) => a.kind === "DIMENSION")
            const entityMetrics = attrs.filter((a) => a.kind === "METRIC")
            const outbound = relationships.filter((r) => r.fromEntity === e.entity)
            const inbound = relationships.filter((r) => r.toEntity === e.entity)
            return (
              <div key={e.entity} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{e.entity}</span>
                      {e.ontologyClass && <Tag title="Ontology class">{e.ontologyClass}</Tag>}
                      <Tag title="Role in the star schema">{e.entityRole}</Tag>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">{e.description}</p>
                  </div>
                  <div className="text-right text-[11px] text-muted-foreground font-mono shrink-0">
                    <div>{e.baseObject}</div>
                    {e.primaryKeys != null && <div>PK ({parseSynonyms(e.primaryKeys).join(", ")})</div>}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                      Dimensions ({entityDims.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {entityDims.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
                      {entityDims.map((d) => (
                        <Tag key={d.name} title={d.comment ?? undefined}>
                          {d.name.toLowerCase()}
                        </Tag>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                      Metrics ({entityMetrics.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {entityMetrics.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
                      {entityMetrics.map((m) => (
                        <Tag key={m.name} title={m.comment ?? undefined}>
                          {m.name.toLowerCase()}
                        </Tag>
                      ))}
                    </div>
                  </div>
                </div>

                {(outbound.length > 0 || inbound.length > 0) && (
                  <div className="text-[11px] text-muted-foreground space-y-0.5 font-mono">
                    {outbound.map((r) => (
                      <div key={r.relationshipName}>
                        {r.fromEntity}({r.fromColumns}) → {r.toEntity}({r.toColumns})
                      </div>
                    ))}
                    {/*
                      Inbound joins are distinguished by a leading marker, not by opacity.
                      `opacity-60` over the muted foreground dropped 11px text to 2.78:1 and was the
                      single largest contrast defect in the app — 128 failing nodes on this page
                      alone. Dimming text is never a safe way to express secondary status.
                    */}
                    {inbound.map((r) => (
                      <div key={`in-${r.relationshipName}`} className="flex gap-1.5">
                        <span aria-hidden className="select-none">
                          ←
                        </span>
                        <span>
                          {r.fromEntity}({r.fromColumns}) → {r.toEntity}({r.toColumns})
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {parseSynonyms(e.synonyms).length > 0 && (
                  <div className="text-[11px] text-muted-foreground">
                    <span className="uppercase tracking-wider text-[11px]">Recognised as: </span>
                    {parseSynonyms(e.synonyms).join(" · ")}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <Provenance label="Source of this page">
        {`SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_ENTITY       WHERE semantic_view = 'SC_ONTOLOGY_360';
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_RELATIONSHIP WHERE semantic_view = 'SC_ONTOLOGY_360';

-- both views read INFORMATION_SCHEMA.SEMANTIC_TABLES / SEMANTIC_RELATIONSHIPS,
-- so they always reflect the deployed semantic view.`}
      </Provenance>
    </>
  )
}

export default async function OntologyPage() {
  return (
    <PageShell
      title="Supply Chain Ontology"
      description="Core entities, relationships, hierarchies and canonical metrics. Everything on this page is read live from INFORMATION_SCHEMA on the deployed semantic view, so the diagram cannot drift from what the conversational layer actually queries."
    >
      <Suspense fallback={<SectionSkeleton title="Ontology" rows={4} />}>
        <Section title="Ontology">{() => OntologyBody()}</Section>
      </Suspense>
    </PageShell>
  )
}
