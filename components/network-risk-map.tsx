"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { type NetworkRiskScenario } from "@/lib/sc"
import { Tag } from "@/components/ui-kit"
import {
  Anchor,
  Compass,
  Filter,
  Globe,
  Info,
  Layers,
  MapPin,
  Navigation,
  ShieldAlert,
  TrendingUp,
  X,
  Zap,
} from "lucide-react"

const REGION_HUBS = [
  { region: "NA", name: "Chicago Hub", lat: 41.8781, lon: -87.6298, city: "Chicago, IL" },
  { region: "EU", name: "Rotterdam Hub", lat: 51.9244, lon: 4.4777, city: "Rotterdam, NL" },
  { region: "APAC", name: "Singapore Hub", lat: 1.3521, lon: 103.8198, city: "Singapore, SG" },
  { region: "LATAM", name: "Sao Paulo Hub", lat: -23.5505, lon: -46.6333, city: "São Paulo, BR" },
]

const CHOKEPOINTS = [
  { id: "CHOKE-01", name: "Strait of Hormuz", lat: 26.5667, lon: 56.25, mode: "OCEAN", desc: "Narrow Gulf maritime passage. Critical oil & container corridor." },
  { id: "CHOKE-02", name: "Suez Canal", lat: 30.5852, lon: 32.2654, mode: "OCEAN", desc: "Mediterranean to Red Sea passage connecting Asia & Europe." },
  { id: "CHOKE-03", name: "Bab el-Mandeb", lat: 12.5833, lon: 43.3333, mode: "OCEAN", desc: "Red Sea to Gulf of Aden strategic strait." },
  { id: "CHOKE-04", name: "Panama Canal", lat: 9.08, lon: -79.68, mode: "OCEAN", desc: "Atlantic to Pacific canal passage." },
  { id: "CHOKE-05", name: "Strait of Malacca", lat: 2.5, lon: 101.0, mode: "OCEAN", desc: "Indian Ocean to South China Sea main shipping route." },
]

const ALL_NODES = [
  { id: "ND-01", name: "St. Paul Plant", region: "NA", lat: 44.9537, lon: -93.0899 },
  { id: "ND-02", name: "Columbia Hub", region: "NA", lat: 34.0007, lon: -81.0348 },
  { id: "ND-03", name: "Austin DC", region: "NA", lat: 30.2671, lon: -97.7430 },
  { id: "ND-04", name: "Mankato Facility", region: "NA", lat: 44.1591, lon: -94.0138 },
  { id: "ND-05", name: "Chicago Central", region: "NA", lat: 41.8781, lon: -87.6297 },
  { id: "ND-06", name: "Hamilton Depot", region: "NA", lat: 43.2557, lon: -79.8711 },
  { id: "ND-07", name: "Düsseldorf Hub", region: "EU", lat: 51.2041, lon: 6.6879 },
  { id: "ND-08", name: "Hagen Depot", region: "EU", lat: 51.3670, lon: 7.4632 },
  { id: "ND-09", name: "Swansea Logistics", region: "EU", lat: 51.6693, lon: -4.0413 },
  { id: "ND-10", name: "Breda Hub", region: "EU", lat: 51.5719, lon: 4.7683 },
  { id: "ND-11", name: "Milan Logistics", region: "EU", lat: 45.4642, lon: 9.1899 },
  { id: "ND-12", name: "Lyon Facility", region: "EU", lat: 45.7640, lon: 4.8356 },
  { id: "ND-13", name: "Singapore Regional DC", region: "APAC", lat: 1.3520, lon: 103.8198 },
  { id: "ND-14", name: "Suzhou Manufacturing", region: "APAC", lat: 31.2988, lon: 120.5853 },
  { id: "ND-15", name: "Yamagata Hub", region: "APAC", lat: 38.2554, lon: 140.3396 },
  { id: "ND-16", name: "Sydney Facility", region: "APAC", lat: -33.8688, lon: 151.2092 },
  { id: "ND-17", name: "Pune Plant", region: "APAC", lat: 18.5204, lon: 73.8567 },
  { id: "ND-18", name: "Seoul Logistics Hub", region: "APAC", lat: 37.5665, lon: 126.9779 },
  { id: "ND-19", name: "Sorocaba Depot", region: "LATAM", lat: -23.5015, lon: -47.4525 },
  { id: "ND-20", name: "Itapetininga Hub", region: "LATAM", lat: -23.5886, lon: -48.0482 },
  { id: "ND-21", name: "Querétaro Plant", region: "LATAM", lat: 20.5887, lon: -100.3898 },
  { id: "ND-22", name: "Bogotá Hub", region: "LATAM", lat: 4.7110, lon: -74.0720 },
  { id: "ND-23", name: "Santiago Facility", region: "LATAM", lat: -33.4488, lon: -70.6692 },
  { id: "ND-24", name: "Buenos Aires Plant", region: "LATAM", lat: -34.6037, lon: -58.3815 },
]

/** Interpolate curved points for Leaflet polyline arcs */
function getArcPoints(
  start: [number, number],
  end: [number, number],
  via?: [number, number],
  numPoints = 20
): [number, number][] {
  const points: [number, number][] = []
  const mid: [number, number] = via
    ? via
    : [(start[0] + end[0]) / 2 + 10, (start[1] + end[1]) / 2]

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints
    const lat = (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * mid[0] + t * t * end[0]
    const lon = (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * mid[1] + t * t * end[1]
    points.push([lat, lon])
  }
  return points
}

export function NetworkRiskMap({ scenarios }: { scenarios: NetworkRiskScenario[] }) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<any>(null)
  const layerGroupRef = useRef<any>(null)

  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(
    scenarios[0]?.scenarioId ?? "SCN-HORMUZ-001"
  )
  const [viewMode, setViewMode] = useState<"DISRUPTED" | "ALL_LANES" | "CHOKEPOINTS">("DISRUPTED")
  const [regionFilter, setRegionFilter] = useState<string>("ALL")

  const [mapReady, setMapReady] = useState(false)
  const [drawerData, setDrawerData] = useState<{ type: string; data: any } | null>(null)

  const activeScenarios = useMemo(() => {
    return scenarios.filter((s) => s.scenarioId === selectedScenarioId)
  }, [scenarios, selectedScenarioId])

  const filteredScenarios = useMemo(() => {
    if (regionFilter === "ALL") return activeScenarios
    return activeScenarios.filter(
      (s) => s.originRegion === regionFilter || s.destinationRegion === regionFilter
    )
  }, [activeScenarios, regionFilter])

  const currentScenarioMeta = activeScenarios[0]

  const totalAffectedLanes = activeScenarios.length
  const baseAvgDelay = activeScenarios.reduce((acc, s) => acc + s.transitDelayDays, 0) / (totalAffectedLanes || 1)
  const effectiveDelay = baseAvgDelay
  const avgUplift = activeScenarios.reduce((acc, s) => acc + s.freightUpliftPct, 0) / (totalAffectedLanes || 1)
  const maxCapacityRed = Math.max(...activeScenarios.map((s) => s.capacityReductionPct), 0)

  // Initialize Leaflet Map
  useEffect(() => {
    if (typeof window === "undefined" || !mapContainerRef.current) return

    let isMounted = true

    import("leaflet").then((L) => {
      if (!isMounted || !mapContainerRef.current) return

      if (!mapInstanceRef.current) {
        const map = L.map(mapContainerRef.current, {
          center: [20, 10],
          zoom: 2,
          minZoom: 2,
          maxZoom: 10,
          zoomControl: false,
        })

        L.control.zoom({ position: "topright" }).addTo(map)
        mapInstanceRef.current = map
        layerGroupRef.current = L.layerGroup().addTo(map)

        const tileUrl = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        L.tileLayer(tileUrl, { attribution, maxZoom: 18, crossOrigin: true }).addTo(map)

        setMapReady(true)
      }
    })

    return () => {
      isMounted = false
    }
  }, [])

  // Draw layers dynamically when state or active scenario changes
  useEffect(() => {
    if (!mapReady || typeof window === "undefined" || !mapInstanceRef.current || !layerGroupRef.current) return

    import("leaflet").then((L) => {
      const layerGroup = layerGroupRef.current
      layerGroup.clearLayers()

      // 1. Draw Base Network Lanes (Standard Dotted Feeder Lines)
      if (viewMode === "ALL_LANES" || viewMode === "DISRUPTED") {
        ALL_NODES.forEach((node) => {
          if (regionFilter !== "ALL" && node.region !== regionFilter) return
          const hub = REGION_HUBS.find((h) => h.region === node.region) ?? REGION_HUBS[0]
          const line = L.polyline(
            [
              [node.lat, node.lon],
              [hub.lat, hub.lon],
            ],
            {
              color: "#38bdf8",
              weight: 1.5,
              dashArray: "4, 6",
              opacity: 0.6,
            }
          )
          line.bindTooltip(`Feeder: ${node.name} → ${hub.name}`, { sticky: true })
          layerGroup.addLayer(line)
        })

        // Inter-hub Backbone Routes
        const hubConnections: [string, string][] = [
          ["NA", "EU"],
          ["EU", "APAC"],
          ["NA", "LATAM"],
          ["APAC", "NA"],
        ]
        hubConnections.forEach(([r1, r2]) => {
          const h1 = REGION_HUBS.find((h) => h.region === r1)
          const h2 = REGION_HUBS.find((h) => h.region === r2)
          if (h1 && h2) {
            const arc = getArcPoints([h1.lat, h1.lon], [h2.lat, h2.lon])
            const line = L.polyline(arc, {
              color: "#6366f1",
              weight: 2,
              dashArray: "6, 8",
              opacity: 0.7,
            })
            line.bindTooltip(`Backbone Route: ${h1.name} ↔ ${h2.name}`, { sticky: true })
            layerGroup.addLayer(line)
          }
        })
      }

      // 2. Draw Active Disrupted Lanes (Glowing Curved Polyline Arcs)
      filteredScenarios.forEach((sc, idx) => {
        const node = ALL_NODES.find((n) => n.id === sc.originNode) ?? ALL_NODES[12]
        const hub = REGION_HUBS.find((h) => h.region === sc.destinationRegion) ?? REGION_HUBS[1]
        const cpObj = CHOKEPOINTS.find((c) => c.name === sc.chokepointName) ?? CHOKEPOINTS[0]

        const arcPoints = getArcPoints([node.lat, node.lon], [hub.lat, hub.lon], [cpObj.lat, cpObj.lon])

        const outerGlow = L.polyline(arcPoints, {
          color: "#f43f5e",
          weight: 6,
          opacity: 0.4,
        })

        const activeLine = L.polyline(arcPoints, {
          color: "#fbbf24",
          weight: 3,
          dashArray: "8, 6",
          opacity: 0.95,
        })

        activeLine.on("click", () => setDrawerData({ type: "LANE", data: sc }))
        activeLine.bindTooltip(
          `<b>Lane ${sc.laneId}</b><br/>${sc.originName} → ${sc.destinationRegion}<br/>Delay: +${sc.transitDelayDays.toFixed(1)}d · Uplift: +${(sc.freightUpliftPct * 100).toFixed(0)}%`,
          { sticky: true }
        )

        layerGroup.addLayer(outerGlow)
        layerGroup.addLayer(activeLine)
      })

      // 3. Draw Maritime Chokepoints
      CHOKEPOINTS.forEach((cp) => {
        const isTargeted = currentScenarioMeta?.chokepointName === cp.name

        if (isTargeted) {
          const aura = L.circleMarker([cp.lat, cp.lon], {
            radius: 14,
            color: "#f43f5e",
            fillColor: "#f43f5e",
            fillOpacity: 0.3,
            stroke: false,
          })
          layerGroup.addLayer(aura)
        }

        const marker = L.circleMarker([cp.lat, cp.lon], {
          radius: isTargeted ? 7 : 5,
          color: isTargeted ? "#f43f5e" : "#eab308",
          fillColor: isTargeted ? "#f43f5e" : "#eab308",
          fillOpacity: 0.9,
          weight: 2,
        })

        marker.on("click", () => setDrawerData({ type: "CHOKEPOINT", data: cp }))
        marker.bindTooltip(`<b>${cp.name}</b><br/>${cp.desc}`)
        layerGroup.addLayer(marker)
      })

      // 4. Draw Region Hubs
      REGION_HUBS.forEach((hub) => {
        if (regionFilter !== "ALL" && hub.region !== regionFilter) return
        const marker = L.circleMarker([hub.lat, hub.lon], {
          radius: 7,
          color: "#ffffff",
          fillColor: "#6366f1",
          fillOpacity: 0.95,
          weight: 2,
        })
        marker.on("click", () => setDrawerData({ type: "HUB", data: hub }))
        marker.bindTooltip(`<b>${hub.name}</b><br/>Region: ${hub.region}`)
        layerGroup.addLayer(marker)
      })

      // 5. Draw All 24 Nodes
      ALL_NODES.forEach((node) => {
        if (regionFilter !== "ALL" && node.region !== regionFilter) return
        const marker = L.circleMarker([node.lat, node.lon], {
          radius: 4,
          color: "#0f172a",
          fillColor: "#38bdf8",
          fillOpacity: 0.9,
          weight: 1.5,
        })
        marker.on("click", () => setDrawerData({ type: "NODE", data: node }))
        marker.bindTooltip(`<b>${node.id}: ${node.name}</b><br/>Region: ${node.region}`)
        layerGroup.addLayer(marker)
      })
    })
  }, [mapReady, selectedScenarioId, viewMode, regionFilter, filteredScenarios, currentScenarioMeta])

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden">
      {/* Enterprise Control Toolbar */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-[var(--shadow-card)] max-w-full overflow-hidden">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-primary" />
              <h2 className="text-base font-semibold tracking-tight">Scenario & Network Controls</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Select a simulation corridor to evaluate transit SLA impact.
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* View Mode */}
            <div className="flex rounded-lg border border-border bg-secondary/40 p-1 gap-1">
              <button
                onClick={() => setViewMode("DISRUPTED")}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                  viewMode === "DISRUPTED" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                Disrupted Corridors
              </button>
              <button
                onClick={() => setViewMode("ALL_LANES")}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                  viewMode === "ALL_LANES" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                All 96 Lanes
              </button>
            </div>

            {/* Region Filter */}
            <div className="flex items-center gap-1.5 bg-background border border-border rounded-lg px-2.5 py-1">
              <Filter className="w-3.5 h-3.5 text-muted-foreground" />
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
                className="bg-transparent text-xs font-medium focus:outline-none"
              >
                <option value="ALL">All Regions</option>
                <option value="NA">North America (NA)</option>
                <option value="EU">Europe (EU)</option>
                <option value="APAC">Asia-Pacific (APAC)</option>
                <option value="LATAM">Latin America (LATAM)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Active Scenario Selector */}
        <div className="pt-2 border-t border-border">
          <div className="space-y-1.5 max-w-lg">
            <label className="text-xs uppercase font-semibold text-muted-foreground">Select Simulation Scenario</label>
            <select
              value={selectedScenarioId}
              onChange={(e) => setSelectedScenarioId(e.target.value)}
              className="w-full h-10 rounded-lg border border-border bg-background px-3 text-xs font-medium focus:ring-2 focus:ring-primary focus:outline-none"
            >
              {Array.from(new Set(scenarios.map((s) => s.scenarioId))).map((id) => {
                const sc = scenarios.find((s) => s.scenarioId === id)
                return (
                  <option key={id} value={id}>
                    {id}: {sc?.scenarioName ?? id}
                  </option>
                )
              })}
            </select>
          </div>
        </div>

        {/* KPI Summaries */}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 pt-2">
          <div className="rounded-lg border border-border bg-secondary/30 p-3.5 space-y-1 min-w-0">
            <div className="text-[11px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5 text-primary" />
              Corridor Lanes
            </div>
            <div className="text-2xl font-bold">{totalAffectedLanes} <span className="text-xs font-normal text-muted-foreground">active lanes</span></div>
            <div className="text-[11px] text-muted-foreground truncate">{currentScenarioMeta?.chokepointName ?? "Maritime Chokepoint"}</div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/30 p-3.5 space-y-1 min-w-0">
            <div className="text-[11px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-amber-500" />
              Effective Transit Delay
            </div>
            <div className="text-2xl font-bold text-amber-500">+{effectiveDelay.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">days</span></div>
            <div className="text-[11px] text-muted-foreground truncate">vs baseline lead time</div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/30 p-3.5 space-y-1 min-w-0">
            <div className="text-[11px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-rose-500" />
              Freight Cost Uplift
            </div>
            <div className="text-2xl font-bold text-rose-500">+{(avgUplift * 100).toFixed(0)}%</div>
            <div className="text-[11px] text-muted-foreground truncate">Emergency surcharge estimate</div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/30 p-3.5 space-y-1 min-w-0">
            <div className="text-[11px] uppercase font-semibold text-muted-foreground flex items-center gap-1.5">
              <Anchor className="w-3.5 h-3.5 text-indigo-400" />
              Capacity Throughput
            </div>
            <div className="text-2xl font-bold text-indigo-400">-{(maxCapacityRed * 100).toFixed(0)}%</div>
            <div className="text-[11px] text-muted-foreground truncate">Container slot bottleneck</div>
          </div>
        </div>
      </div>

      {/* Main Interactive Map & Side Panel Grid */}
      <div className="grid gap-6 grid-cols-1 xl:grid-cols-3 w-full min-w-0">
        {/* Map Container (2 Columns on XL screens) */}
        <div className="xl:col-span-2 min-w-0 relative rounded-xl border border-border bg-slate-950 p-3 shadow-xl overflow-hidden flex flex-col justify-between min-h-[520px]">
          <div className="flex items-center justify-between gap-3 mb-2 px-2 flex-wrap z-10 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <Globe className="w-4 h-4 text-cyan-400 animate-pulse" />
              <span className="text-xs font-semibold text-slate-200">Global GIS Supply Chain Topology</span>
            </div>

            {/* Non-overlapping Top Bar Legend */}
            <div className="flex items-center gap-x-3 gap-y-1 text-[10px] sm:text-[11px] text-slate-300 flex-wrap min-w-0">
              <div className="flex items-center gap-1.5" title="Active scenario chokepoint">
                <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)] animate-pulse shrink-0" />
                <span className="text-slate-200 whitespace-nowrap">Disrupted Chokepoint</span>
              </div>
              <div className="flex items-center gap-1.5" title="Monitored maritime strait">
                <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-amber-400 shrink-0" />
                <span className="text-slate-200 whitespace-nowrap">Strategic Strait</span>
              </div>
              <div className="flex items-center gap-1.5" title="Regional distribution center hub">
                <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-indigo-500 border border-white shrink-0" />
                <span className="text-slate-200 whitespace-nowrap">Regional Hub</span>
              </div>
              <div className="flex items-center gap-1.5" title="Plant or DC Facility node">
                <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-cyan-400 shrink-0" />
                <span className="text-slate-200 whitespace-nowrap">Facility Node</span>
              </div>
              <div className="flex items-center gap-1.5" title="Impacted transit corridor">
                <span className="w-3.5 h-0.5 bg-amber-400 border-b border-dashed border-amber-400 shrink-0" />
                <span className="text-slate-200 whitespace-nowrap">Disrupted Corridor</span>
              </div>
            </div>
          </div>

          <div
            ref={mapContainerRef}
            className="w-full h-[460px] rounded-lg border border-slate-800 overflow-hidden z-0 [&_.leaflet-tile-pane]:invert [&_.leaflet-tile-pane]:hue-rotate-180 [&_.leaflet-tile-pane]:brightness-90 [&_.leaflet-tile-pane]:contrast-125"
          />
        </div>

        {/* Interactive Detail Drawer Panel (Right Column) */}
        <div className="min-w-0 rounded-xl border border-border bg-card p-5 space-y-4 shadow-[var(--shadow-card)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold tracking-tight">Entity Topology Inspector</h3>
              </div>
              {drawerData && (
                <button
                  onClick={() => setDrawerData(null)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {drawerData ? (
              <div className="py-3 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase font-semibold text-muted-foreground">Type</span>
                  <Tag>{drawerData.type}</Tag>
                </div>

                {drawerData.type === "LANE" && (
                  <div className="space-y-2">
                    <div className="font-semibold text-sm">{drawerData.data.laneId}: {drawerData.data.originName} → {drawerData.data.destinationRegion}</div>
                    <div className="p-3 rounded-lg bg-secondary/50 space-y-1.5 font-mono text-[11px]">
                      <div>Baseline Lead: <span className="font-bold">{drawerData.data.baselineTransitDays}d</span></div>
                      <div className="text-amber-500">Simulated Lead: <span className="font-bold">{drawerData.data.simulatedTransitDays}d</span></div>
                      <div className="text-emerald-500">Mitigated Lead: <span className="font-bold">{drawerData.data.mitigatedTransitDays}d</span></div>
                      <div className="text-rose-500">Freight Uplift: <span className="font-bold">+{(drawerData.data.freightUpliftPct * 100).toFixed(0)}%</span></div>
                    </div>
                    <p className="text-muted-foreground leading-relaxed">{drawerData.data.notes}</p>
                  </div>
                )}

                {drawerData.type === "CHOKEPOINT" && (
                  <div className="space-y-2">
                    <div className="font-semibold text-sm">{drawerData.data.id}: {drawerData.data.name}</div>
                    <div className="p-3 rounded-lg bg-secondary/50 space-y-1 font-mono text-[11px]">
                      <div>Transport Mode: {drawerData.data.mode}</div>
                      <div>Coordinates: {drawerData.data.lat.toFixed(4)}, {drawerData.data.lon.toFixed(4)}</div>
                    </div>
                    <p className="text-muted-foreground leading-relaxed">{drawerData.data.desc}</p>
                  </div>
                )}

                {drawerData.type === "NODE" && (
                  <div className="space-y-2">
                    <div className="font-semibold text-sm">{drawerData.data.id}: {drawerData.data.name}</div>
                    <div className="p-3 rounded-lg bg-secondary/50 space-y-1 font-mono text-[11px]">
                      <div>Region: {drawerData.data.region}</div>
                      <div>Coordinates: {drawerData.data.lat.toFixed(4)}, {drawerData.data.lon.toFixed(4)}</div>
                      <div>Precision: CITY_CENTRE</div>
                    </div>
                  </div>
                )}

                {drawerData.type === "HUB" && (
                  <div className="space-y-2">
                    <div className="font-semibold text-sm">{drawerData.data.name}</div>
                    <div className="p-3 rounded-lg bg-secondary/50 space-y-1 font-mono text-[11px]">
                      <div>Region Code: {drawerData.data.region}</div>
                      <div>City Hub: {drawerData.data.city}</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-12 text-center text-xs text-muted-foreground space-y-2">
                <Compass className="w-8 h-8 text-muted-foreground mx-auto opacity-50" />
                <p>Click any Node, Chokepoint, or Lane on the map to inspect full geospatial metadata and mitigation plans.</p>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-border text-[11px] text-muted-foreground font-mono">
            Source: SUPPLY_CHAIN.RAW.GEO_NODE & V_NETWORK_RISK_SCENARIO
          </div>
        </div>
      </div>

      {/* Lane Impact Table */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-[var(--shadow-card)] max-w-full overflow-hidden">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Simulated Lane Impact Matrix</h3>
            <p className="text-xs text-muted-foreground">
              Detailed transit baseline vs. simulated disruption and mitigation delay estimates.
            </p>
          </div>
          <Tag title="Scenario Reference ID">{selectedScenarioId}</Tag>
        </div>

        <div className="w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-muted-foreground font-medium">
                <th className="p-2.5">Lane ID</th>
                <th className="p-2.5">Origin Node</th>
                <th className="p-2.5">Dest Region</th>
                <th className="p-2.5">Service Level</th>
                <th className="p-2.5">Baseline Lead</th>
                <th className="p-2.5 text-amber-500">Simulated Lead</th>
                <th className="p-2.5 text-emerald-500">Mitigated Lead</th>
                <th className="p-2.5 text-rose-500">Freight Uplift</th>
                <th className="p-2.5">Mitigation Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredScenarios.map((lane) => (
                <tr
                  key={lane.laneId}
                  className="hover:bg-secondary/30 transition-colors cursor-pointer"
                  onClick={() => setDrawerData({ type: "LANE", data: lane })}
                >
                  <td className="p-2.5 font-mono font-medium text-foreground">{lane.laneId}</td>
                  <td className="p-2.5">{lane.originName} <span className="text-[10px] text-muted-foreground">({lane.originNode})</span></td>
                  <td className="p-2.5 font-semibold">{lane.destinationRegion}</td>
                  <td className="p-2.5">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border border-border bg-background">
                      {lane.serviceLevel}
                    </span>
                  </td>
                  <td className="p-2.5">{lane.baselineTransitDays} days</td>
                  <td className="p-2.5 font-semibold text-amber-500">
                    {lane.simulatedTransitDays} days <span className="text-[10px] font-normal">(+{lane.transitDelayDays.toFixed(1)}d)</span>
                  </td>
                  <td className="p-2.5 font-semibold text-emerald-500">{lane.mitigatedTransitDays} days</td>
                  <td className="p-2.5 font-semibold text-rose-500">+{(lane.freightUpliftPct * 100).toFixed(0)}%</td>
                  <td className="p-2.5 font-mono text-[11px] text-primary">{lane.mitigationStrategy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
