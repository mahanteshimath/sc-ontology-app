/**
 * The governed ontology as a portable OWL/SKOS document.
 *
 * GET /api/ontology                 -> JSON-LD (application/ld+json)
 * GET /api/ontology?format=ttl      -> Turtle  (text/turtle)
 * GET /api/ontology?download=1      -> same, with Content-Disposition: attachment
 *
 * Every triple is generated from what Snowflake already holds (the deployed SC_ONTOLOGY_360
 * semantic view, the metric registry and its SCOR mapping), so the file cannot say something the
 * semantic layer does not enforce. See lib/ontology-export.ts for the mapping.
 */

import {
  getMetricRegistry,
  getOntologyEntities,
  getOntologyRelationships,
  getTrustSignals,
} from "@/lib/sc"
import { buildJsonLd, toTurtle } from "@/lib/ontology-export"

export const dynamic = "force-dynamic"

/** Governance tables key on the unqualified view name. */
const VIEW = "SC_ONTOLOGY_360"

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const format = (url.searchParams.get("format") ?? "jsonld").toLowerCase()
    const download = url.searchParams.has("download")

    const [entities, relationships, metrics, trust] = await Promise.all([
      getOntologyEntities(VIEW),
      getOntologyRelationships(VIEW),
      getMetricRegistry(),
      getTrustSignals(),
    ])

    const doc = buildJsonLd({
      semanticView: VIEW,
      entities,
      relationships,
      metrics,
      trust: trust.find((t) => t.semanticView === VIEW) ?? null,
      generatedAt: new Date().toISOString(),
    })

    const turtle = format === "ttl" || format === "turtle"
    const body = turtle ? toTurtle(doc) : JSON.stringify(doc, null, 2)
    const headers: Record<string, string> = {
      "Content-Type": turtle ? "text/turtle; charset=utf-8" : "application/ld+json; charset=utf-8",
    }
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="sc-ontology.${turtle ? "ttl" : "jsonld"}"`
    }
    return new Response(body, { headers })
  } catch (e) {
    console.error(new Date().toISOString(), "[ontology] export failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to export the ontology" },
      { status: 500 },
    )
  }
}
