## The short answer to "how do I improve agents, not just prompt?"

Your prompt layer is already strong — I read the deployed spec, and the instructions, tool routing, domain boundaries and provenance rules are all in good shape. Further prompt editing will return very little. The gains are structural, and I measured where they are:

| Lever | Current state | Impact |
|---|---|---|
| **Verified queries** | **0 across all 7 views** — the `ai_verified_queries` blocks exist but are empty | **Highest.** Pins common questions to a known-correct SQL path instead of re-deriving it |
| **Evaluation harness** | None — accuracy is currently unmeasured | **Enables everything else.** Without a number, every change is an opinion |
| **Data engineering** | Good (canonical facts, registry) | High. Snowflake's own guidance: *"an ounce of data engineering is worth a pound of prompt engineering"* |
| **Feedback loop** | None | Medium-high. Real questions beat imagined ones as a source of synonyms and VQRs |
| **Synonyms** | 78/83 dims, 88/89 metrics | Already done |
| **Tool scoping** | 6 tools, well described | Already good (5–10 is the guidance) |
| **Constrained action space** | Resolver returns metric IDs, never SQL | Already done — this is genuinely ahead of typical |

So: **measure first, then verified queries, then a feedback loop.** That ordering is the answer, and it is why prediction comes after.

---

## What I found about the prediction idea, before building it

I checked whether the data supports forecasting. It largely does not, and this materially changes the design.

**The aggregate OTD series is flat noise.** 23 consecutive months sit between 0.8759 and 0.8811:

```
2024-11  0.88089     2025-11  0.87733     2026-05  0.87805
2024-12  0.88001     2025-12  0.88109     2026-06  0.88049
2025-01  0.87593     2026-01  0.87892     2026-07  0.87835
...                  ...                  2026-08  0.87782
```

(2024-10 at 0.925 and 2026-09 are partial months, not signal.)

**Within-entity variation over time is tiny; between-entity variation is large.**

| Product family | mean OTD | sd over 22 months | range |
|---|---|---|---|
| Films | 0.8587 | 0.0040 | 0.0133 |
| Abrasives | 0.8684 | 0.0035 | 0.0174 |
| Adhesives | 0.8777 | 0.0021 | 0.0082 |
| Respiratory | 0.8874 | 0.0025 | 0.0089 |
| Tapes | 0.9077 | 0.0026 | 0.0114 |

Cross-sectional spread is **4.9pp**; temporal noise within a family is **~0.3pp**. A ratio of roughly 6:1. Carriers show no dispersion at all (0.0008 spread) — there is nothing to predict there.

**And the incumbent forecast is already 98.83% accurate** (MAPE 1.17%, bias +1.17%).

Three consequences I want to be explicit about:

1. A time-series forecast of the ratio metrics would return a flat line at the historical mean with <0.5% error. It would *look* excellent and prove nothing — a vanity metric, which is precisely the failure mode this project exists to prevent.
2. Beating a 98.83%-accurate incumbent is not a realistic or meaningful target.
3. The data is **cross-sectionally rich and temporally stationary**. That is not a defect — it just means the honest prediction question is *"who is off target and how confident are we"*, not *"what will the number be"*.

**I am deliberately not injecting synthetic trend/seasonality into the generator.** It would make forecasting demo well, but it would alter the dataset that the drift-test baseline and every governed metric depend on. That trade isn't worth it. Say the word and I'll add it as an explicitly labelled scenario instead.

---

## What I will build instead

Three methods, each matched to what the data actually contains:

**1. Target-breach probability** — the real business question. Films sits at 0.8587 against a 0.90 target with 0.4pp variance; that supports a confident, statistically defensible "will not reach target without intervention". Computed from each entity's own realized mean and variance against its governed target and thresholds, reported as a probability with the normal approximation stated openly.

**2. Anomaly / changepoint detection** (`SNOWFLAKE.ML.ANOMALY_DETECTION`) — the *correct* tool for stationary series, and it turns the flatness into an asset: because each family holds ±0.3pp, a genuine shift is highly detectable. Complements the existing drift alert, which catches *definitional* breaks; this catches *behavioural* ones.

**3. Volume and spend forecast** (`SNOWFLAKE.ML.FORECAST`) — order lines and freight spend, where level plus days-in-month is legitimate signal. Modest, honest, useful for capacity and budget.

### The governance rule that makes this fit the project

A prediction is **not** a measurement. Enforced structurally, not by convention:

- new `as_of_scope = 'PREDICTED'`, alongside `REALIZED` and `SNAPSHOT`
- predicted values never enter realized aggregates and are **excluded from the drift test** — otherwise a forecast would "fail" against the canonical fact by design
- every prediction is scored with the **existing** canonical `FORECAST_ACCURACY`, `MAPE` and `FORECAST_BIAS` definitions rather than new ones, because reusing one definition is the entire thesis of this project
- each method's **measured backtest accuracy is itself a governed metric**, so a weak predictor is visible instead of quietly shipped
- the agent reads predictions from `METRIC_PREDICTION` via a custom tool — it never extrapolates. This extends the existing "never invent a metric" rule to "never invent a forecast"

---

## Sequencing and risk

Phases 1–3 (measurement, verified queries, feedback) are low-risk and deliver a quantified accuracy gain on their own. Phases 4–8 add prediction on top of that foundation.

The live agent is never edited in place: work happens on `SC_ONTOLOGIST_AGENT_DEV` and is promoted only if it beats the recorded baseline. If verified queries turn out not to move the number, that is a real finding and I will report it rather than claim a win.

**Rough shape:** Phases 1–3 are the majority of the accuracy value; Phase 5 is the largest single build; Phase 6 is where the honest verdict on prediction quality lands.
