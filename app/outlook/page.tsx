import { Suspense } from "react"
import {
  PageShell,
  StatTile,
  StatusPill,
  Tag,
  Provenance,
  Section,
  SectionHeading,
  SectionSkeleton,
} from "@/components/ui-kit"
import { getMetricOutlook, type MetricOutlook } from "@/lib/sc"
import { formatMetric, formatNumber } from "@/lib/format"
import { TargetSimulator } from "@/components/target-simulator"
import { VolumeForecastChart } from "@/components/volume-forecast-chart"

export const dynamic = "force-dynamic"

/** Map a breach verdict onto the same RAG vocabulary the rest of the app uses. */
function verdictState(o: MetricOutlook): "on-target" | "warn" | "off-target" | "none" {
  if (o.breachProbability === null) return "none"
  if (o.breachProbability >= 0.6) return "off-target"
  if (o.breachProbability >= 0.2) return "warn"
  return "on-target"
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`
}

async function OutlookBody() {
  const outlook = await getMetricOutlook()

  const breach = outlook.filter((o) => o.method === "TARGET_BREACH")
  const forecast = outlook.filter((o) => o.method === "ML_FORECAST")
  const willBreach = breach.filter((o) => (o.breachProbability ?? 0) >= 0.95)
  const atRisk = breach.filter((o) => (o.breachProbability ?? 0) >= 0.2 && (o.breachProbability ?? 0) < 0.95)
  const accuracy = breach.find((o) => o.backtestAccuracy !== null)?.backtestAccuracy ?? null

  return (
    <>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Will breach target"
          value={String(willBreach.length)}
          tone={willBreach.length > 0 ? "bad" : "good"}
          sub="Target is outside current process capability"
        />
        <StatTile
          label="At risk"
          value={String(atRisk.length)}
          tone={atRisk.length > 0 ? "warn" : "good"}
          sub="Current variation could miss target"
        />
        <StatTile
          label="Method accuracy"
          value={accuracy === null ? "not scored" : pct(accuracy)}
          sub="Backtested on 6 held-out months"
        />
        <StatTile
          label="Volume forecast"
          value={forecast.length ? `${forecast.length} months` : "—"}
          sub="Order-line volume forecast horizon"
        />
      </section>

      {/*
        The honesty section. This page exists to make a prediction useful without overselling it, and
        the single most important fact about this data set is that its ratio metrics do not move.
      */}
      <section className="u-card p-5 space-y-3">
        <SectionHeading note="method limits">
          Prediction scope
        </SectionHeading>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="u-label">Not forecastable</div>
            <p className="u-body text-muted-foreground">
              Service ratios are stable. A level forecast would mostly repeat the historical mean.
            </p>
          </div>
          <div className="space-y-2">
            <div className="u-label">Genuinely predictable</div>
            <p className="u-body text-muted-foreground">
              Target reachability and order-line volume carry useful signal; level forecasts do not.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading note="probability that the governed target is missed next period">
          Target-breach outlook by product family
        </SectionHeading>
        <div className="u-card overflow-hidden">
          <div className="hidden md:grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_minmax(0,1.2fr)] gap-x-4 px-4 py-2 border-b border-border bg-secondary/50 items-end">
            <div className="u-label">Metric</div>
            <div className="u-label">Family</div>
            <div className="u-label md:text-right">Expected</div>
            <div className="u-label md:text-right">Target</div>
            <div className="u-label md:text-right">Breach</div>
            <div className="u-label">Verdict</div>
          </div>
          {breach.map((o) => (
            <div
              key={`${o.metricId}-${o.grainValue}`}
              className="grid md:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_minmax(0,1.2fr)] gap-x-4 gap-y-1 px-4 py-3 border-b border-border last:border-0 items-baseline"
            >
              <div className="min-w-0">
                <div className="u-subhead truncate">{o.businessName ?? o.metricId}</div>
                <div className="u-mono text-muted-foreground">{o.metricId}</div>
              </div>
              <div className="u-body">{o.grainValue}</div>
              <div className="md:text-right u-mono">{formatMetric(o.predictedValue, o.unit)}</div>
              <div className="md:text-right u-mono text-muted-foreground">
                {formatMetric(o.targetValue, o.unit)}
              </div>
              <div className="md:text-right u-mono">{pct(o.breachProbability)}</div>
              <div>
                <StatusPill kind="target" status={verdictState(o)} label={o.verdict ?? "—"} />
              </div>
            </div>
          ))}
        </div>
        <p className="u-meta u-prose">Verdicts compare the target with current process capability, not a model-generated promise.</p>

        <TargetSimulator />
      </section>

      {forecast.length > 0 && (
        <section className="space-y-4">
          <SectionHeading note="SNOWFLAKE.ML.FORECAST over 22 full months">
            Order-line volume forecast
          </SectionHeading>
          <div className="grid gap-4 sm:grid-cols-3">
            {forecast.map((o) => (
              <div key={o.horizonPeriod} className="u-card p-5 space-y-2">
                <div className="u-label">{o.horizonPeriod}</div>
                <div className="u-value">{formatNumber(Math.round(o.predictedValue ?? 0))}</div>
                <div className="u-mono text-muted-foreground">
                  {formatNumber(Math.round(o.lowerBound ?? 0))} – {formatNumber(Math.round(o.upperBound ?? 0))}
                </div>
                <p className="u-meta">95% interval, order lines delivered</p>
              </div>
            ))}
          </div>

          <VolumeForecastChart forecasts={forecast} />
        </section>
      )}

      <section className="space-y-4">
        <SectionHeading>How a prediction stays governed</SectionHeading>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="u-card p-5 space-y-2">
            <h3 className="u-subhead">Prediction guardrails</h3>
            <ul className="u-body text-muted-foreground space-y-1.5 list-disc list-inside">
              <li>Predictions stay outside realized metrics and drift tests.</li>
              <li>Each prediction includes its method and backtest.</li>
            </ul>
          </div>
          <div className="u-card p-5 space-y-2">
            <h3 className="u-subhead">Methods in use</h3>
            <div className="space-y-2.5">
              {[...new Set(outlook.map((o) => o.method))].map((m) => {
                const sample = outlook.find((o) => o.method === m)!
                return (
                  <div key={m} className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Tag>{m}</Tag>
                      <span className="u-mono text-muted-foreground">{sample.modelVersion}</span>
                    </div>
                    <p className="u-meta leading-relaxed">{sample.basis}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <Provenance label="Where these numbers come from">
        {`-- Predictions are read, never recomputed in the application:
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK;

-- Refresh the target-breach outlook:
CALL SUPPLY_CHAIN.GOVERNANCE.PREDICT_TARGET_BREACH();

-- Refresh the volume forecast:
SELECT * FROM TABLE(SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST!FORECAST(FORECASTING_PERIODS => 3));

-- Accuracy of each method, scored on held-out months:
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST;`}
      </Provenance>
    </>
  )
}

export default async function OutlookPage() {
  return (
    <PageShell
      title="Outlook"
      description="Governed predictions with their measured backtest results."
    >
      <Suspense fallback={<SectionSkeleton title="Outlook" rows={4} />}>
        <Section title="Outlook">{() => OutlookBody()}</Section>
      </Suspense>
    </PageShell>
  )
}
