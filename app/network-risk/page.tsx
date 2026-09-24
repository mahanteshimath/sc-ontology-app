import { Suspense } from "react"
import { PageShell, Section, SectionSkeleton } from "@/components/ui-kit"
import { getNetworkRiskScenarios } from "@/lib/sc"
import { NetworkRiskMap } from "@/components/network-risk-map"

export const dynamic = "force-dynamic"

async function NetworkRiskContent() {
  const scenarios = await getNetworkRiskScenarios()
  return <NetworkRiskMap scenarios={scenarios} />
}

export default async function NetworkRiskPage() {
  return (
    <PageShell
      title="Network Risk & Geospatial Topology"
      description="Simulated capacity constraints, maritime chokepoints, and lane-level stress tests read from GOVERNANCE.V_NETWORK_RISK_SCENARIO."
    >
      <Suspense fallback={<SectionSkeleton title="Network Risk Topology" rows={3} />}>
        <Section title="Network Risk Topology">{() => NetworkRiskContent()}</Section>
      </Suspense>
    </PageShell>
  )
}
