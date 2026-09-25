import { Suspense } from "react"
import { PageShell, StatTile, Tag, Provenance, Section, SectionSkeleton } from "@/components/ui-kit"
import {
  getOntologyEntities,
  getOntologyRelationships,
  getEntityAttributes,
  getOntologyHierarchies,
} from "@/lib/sc"
import { parseSynonyms } from "@/lib/format"
import { OntologyGraph } from "@/components/ontology-graph"

export const dynamic = "force-dynamic"

async function OntologyBody() {
  const [entities, relationships, attributes, hierarchyLevels] = await Promise.all([
    getOntologyEntities(),
    getOntologyRelationships(),
    getEntityAttributes(),
    getOntologyHierarchies(),
  ])

  const dims = entities.filter((e) => e.entityRole === "DIMENSION")
  const facts = entities.filter((e) => e.entityRole === "FACT")
  const attrsByEntity = new Map<string, typeof attributes>()
  for (const a of attributes) {
    if (!attrsByEntity.has(a.entity)) attrsByEntity.set(a.entity, [])
    attrsByEntity.get(a.entity)!.push(a)
  }

  // Levels arrive ordered by hierarchy then level; group them without re-sorting.
  const hierarchies = new Map<string, typeof hierarchyLevels>()
  for (const l of hierarchyLevels) {
    if (!hierarchies.has(l.hierarchyId)) hierarchies.set(l.hierarchyId, [])
    hierarchies.get(l.hierarchyId)!.push(l)
  }
  const rollups = hierarchyLevels.filter((l) => l.rollupStatus !== "BASE")
  const provenRollups = rollups.filter((l) => l.rollupStatus === "PASS" && l.resolves).length
  const validatedAt = hierarchyLevels.find((l) => l.validatedAt)?.validatedAt ?? null

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Entities" value={String(entities.length)} sub="Ontology classes modelled" />
        <StatTile label="Conformed dimensions" value={String(dims.length)} sub="Shared across every fact" />
        <StatTile label="Facts" value={String(facts.length)} sub="Business processes measured" />
        <StatTile
          label="Relationships"
          value={String(relationships.length)}
          sub="Declared joins, one path per fact to each dimension"
        />
        <StatTile
          label="Hierarchies"
          value={String(hierarchies.size)}
          tone={provenRollups === rollups.length ? "good" : "bad"}
          sub={`${provenRollups}/${rollups.length} rollups measured as true`}
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
        <div>
          <h2 className="text-sm font-semibold">Hierarchies</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
            A semantic view has no hierarchy construct, so these are declared rather than derived — which is exactly
            why each level is checked instead of trusted. Every level is joined to the deployed view, and every rollup
            is measured against the conformed dimension it is sourced from: a level only qualifies if each child value
            has exactly one parent. <strong>{provenRollups} of {rollups.length}</strong> rollups are proven.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...hierarchies.values()].map((levels) => {
            const head = levels[0]
            const broken = levels.some((l) => !l.resolves || (l.rollupStatus ?? "") === "FAIL")
            return (
              <div
                key={head.hierarchyId}
                className={`rounded-lg border p-4 ${
                  broken ? "border-red-500/40 bg-red-500/5" : "border-border bg-card"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{head.hierarchyName}</div>
                  <Tag title="Ontology entity the drill path belongs to">{head.entity}</Tag>
                </div>
                <div className="text-[11px] text-muted-foreground mb-2">
                  {head.levelCount} levels, finest grain last
                </div>
                <ol className="space-y-1">
                  {[...levels].reverse().map((l) => (
                    <li key={l.levelNo} className="flex items-baseline gap-2 text-xs">
                      <span className="text-muted-foreground tabular-nums w-4 shrink-0">{l.levelNo}</span>
                      <span
                        className={`font-mono ${l.resolves ? "text-foreground/90" : "text-red-500 line-through"}`}
                        title={l.description ?? undefined}
                      >
                        {l.levelDimension.toLowerCase()}
                      </span>
                      {!l.resolves && <span className="text-[10px] text-red-500">not a dimension</span>}
                      {l.rollupStatus === "FAIL" && (
                        <span className="text-[10px] text-red-500">{l.violationCount} split parents</span>
                      )}
                    </li>
                  ))}
                </ol>
                <div className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                  {levels.find((l) => l.rollupStatus !== "BASE")?.validationDetail ?? "single level"}
                </div>
              </div>
            )
          })}
        </div>
        {validatedAt && (
          <Provenance label="How a rollup is proven">
            {`-- Every parent/child pair is measured against the conformed dimension it is sourced
-- from. A level qualifies only if each child value has exactly one parent value.
-- Last run ${validatedAt.slice(0, 19).replace("T", " ")} UTC.

CALL SUPPLY_CHAIN.GOVERNANCE.VALIDATE_ONTOLOGY_HIERARCHY();

SELECT hierarchy_id, level_no, dimension_ref, resolves, rollup_status,
       violation_count, validation_detail
  FROM SUPPLY_CHAIN.GOVERNANCE.V_ONTOLOGY_HIERARCHY
 ORDER BY hierarchy_id, level_no;`}
          </Provenance>
        )}
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
      description="Live semantic-view entities, relationships, hierarchies and metrics."
    >
      <Suspense fallback={<SectionSkeleton title="Ontology" rows={4} />}>
        <Section title="Ontology">{() => OntologyBody()}</Section>
      </Suspense>
    </PageShell>
  )
}
