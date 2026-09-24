import { NextResponse } from "next/server"
import { getNetworkRiskScenarios } from "@/lib/sc"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const scenarios = await getNetworkRiskScenarios()
    return NextResponse.json({ scenarios })
  } catch (error: any) {
    return NextResponse.json({ error: error.message ?? "Failed to fetch scenarios" }, { status: 500 })
  }
}
