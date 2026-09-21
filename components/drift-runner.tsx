"use client"

import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

interface DriftResponse {
  passed: number
  failed: number
  total: number
  error?: string
}

interface Props {
  /**
   * False on Vercel, where the ~25s procedure exceeds the Hobby function limit. The page then
   * shows the last stored result instead of offering a re-run.
   */
  canRun: boolean
  lastRunAt: string | null
}

/** Runs GOVERNANCE.METRIC_DRIFT_TEST on demand and refreshes the page data. */
export function DriftRunner({ canRun, lastRunAt }: Props) {
  const router = useRouter()
  const mutation = useMutation<DriftResponse>({
    mutationFn: async () => {
      const res = await fetch("/api/drift", { method: "POST" })
      const json = (await res.json()) as DriftResponse
      if (!res.ok) throw new Error(json.error ?? "Drift test failed")
      return json
    },
    onSuccess: () => router.refresh(),
  })

  if (!canRun) {
    return (
      <div className="flex flex-col items-end gap-1 max-w-xs text-right">
        <Button size="sm" disabled title="The drift test takes about 25 seconds, which exceeds the hosting function limit">
          Run drift test
        </Button>
        <span className="text-[11px] text-muted-foreground leading-snug">
          Disabled on this host: the test takes ~25s, over the serverless function limit. Results below are
          the last stored run
          {lastRunAt ? ` (${lastRunAt.slice(0, 19).replace("T", " ")})` : ""}. Run it locally or in
          Snowflake with{" "}
          <code className="font-mono">CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST()</code>.
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} size="sm">
        {mutation.isPending ? "Running drift test…" : "Run drift test"}
      </Button>
      {mutation.isPending && (
        <span className="text-[11px] text-muted-foreground">
          Evaluating every metric through every view that serves it (~25s)
        </span>
      )}
      {mutation.isSuccess && (
        <span className="text-[11px] text-muted-foreground">
          {mutation.data.passed}/{mutation.data.total} passed
          {mutation.data.failed > 0 ? `, ${mutation.data.failed} failed` : ""}
        </span>
      )}
      {mutation.isError && (
        <span className="text-[11px] u-bad">
          {mutation.error instanceof Error ? mutation.error.message : "Failed"}
        </span>
      )}
    </div>
  )
}
