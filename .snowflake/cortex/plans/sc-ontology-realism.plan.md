---
name: "sc-ontology-realism"
created: "2026-09-20T13:03:36.859Z"
status: pending
---

# Plan: Make the Supply Chain Ontology app realistic

## What exists today (assessment)

**Architecture** — Next.js 16 App Router, 6 server-rendered pages (`/`, `/ontology`, `/metrics`, `/consistency`, `/ask`, `/operations`), 5 API routes, all data access funnelled through `lib/sc.ts` → `lib/snowflake.ts`. No raw-table access from the app; every displayed number comes from `SELECT ... FROM SEMANTIC_VIEW(...)`. Provenance SQL is shown next to each figure.

**Backend is real, not mocked** — `SUPPLY_CHAIN` has 78 tables (`SHIPMENT` 1.48M, `SALES_ORDER` 1.51M, `GOODS_RECEIPT`/`PURCHASE_ORDER` 420K each), 8 semantic views, and a genuine governance layer: `METRIC_DEFINITION` (14), `METRIC_BINDING` (26), `METRIC_DRIFT_RESULT` (96 rows of history), a recorded pre-remediation `METRIC_DRIFT_BASELINE`, and a negative-control view (`SC_SUPPLIER_LEGACY_DEFECT`) proving the drift test can fail. This part is stronger than most demos and should be preserved.

**The core credibility gap: the app is timeless.** `SC_ONTOLOGY_360` has a month dimension *per fact* (`RECEIPT_MONTH`, `DELIVERY_MONTH`, `SNAPSHOT_MONTH`, `COST_MONTH`, `COMPLETION_MONTH`) but **no conformed calendar entity**, and `querySemanticView` has **no WHERE/filter support at all**. Consequences:

- Every KPI on every page is an all-time average over 26 months. No MTD, no trailing-13-week, no YoY, no trend line. No supply chain org runs on a lifetime average.
- Data runs to **2026-11-25** while today is 2026-09-20 — **2.79% of `SHIPMENT` rows (41,347) are future-dated** and silently inside every "current" OTD/fill-rate number.
- The month dimensions are per-fact, so a cross-fact time comparison (supplier OTD vs. customer OTD for the same month) is not expressible — which undercuts the multi-fact conformed-dimension claim the `/ontology` page makes.

**Other findings, in priority order:**

1. **The persona selector in `/ask` is decorative.** `components/ask-console.tsx` sends `{ question, persona }`, but `app/api/ask/route.ts` destructures `persona` and never uses it. The UI caption even says "the persona changes the phrasing, never the definition" — it changes nothing. Meanwhile `/consistency` *does* enforce roles properly. The app's headline claim is only half-wired.
2. **`lib/persona.ts` will likely not work as deployed.** `runAsRole` re-authenticates with the app's own credentials and sets an arbitrary `role`; under the SPCS OAuth service token an arbitrary role switch is not generally available, and `WAREHOUSE` is hardcoded to `COMPUTE_WH`. It also opens a fresh connection per role per request (unpooled). Locally it works via TOML; in SPCS it is a deploy-time failure waiting to happen.
3. **No app-level authorization.** The live deployment is a public Vercel URL with owner's-rights Snowflake access — anyone with the link reads governed supply-chain data. Only `/api/query` and `/api/time` even mention caller's rights, and they are unused template demos.
4. **No targets, no "so what".** `METRIC_DEFINITION` carries `direction` (higher/lower/to-zero) but no target or threshold. Nothing renders red/amber/green against plan, so the pages describe the data without judging it.
5. **No drill-down.** You can see Supplier OTD = 92% by region and cannot reach the late PO lines behind it. Nothing is actionable.
6. **Performance/caching.** `getMetricRegistry()` (a correlated `ARRAY_AGG` subquery) runs on *every* page load and *twice* per `/api/ask` and `/api/consistency` call. `/operations` fires 4 semantic-view queries per render. Everything is `force-dynamic` with zero caching or `Suspense` streaming, so first paint waits on all of it.
7. **Drift is manual and hidden.** No task/schedule, no alert, no history trend (96 rows of history exist and are never charted). `getLatestDrift()` uses a fragile `MAX(run_at) - 30s` window instead of a run id. On Vercel the button is disabled outright, so the flagship governance control can't be exercised where the app is actually published.
8. **Fragile error handling.** Each page does one `Promise.all` inside one `try` — a single slow or failed query blanks the entire page.
9. **Template leftovers.** `/api/time`, `/api/query`, `components/time-card.tsx`, `query-card.tsx`, `session-card.tsx` are unused scaffolding. `README.md` is still the generic template build guide. `vitest.config.ts` is wired and the `__tests__/` directory the README documents **does not exist** — there are zero tests.
10. **Data provenance smells.** `SUPPLY_CHAIN.UTIL` contains `OTD_NUDGE`, `SUP_OTD_NUDGE`, `FILL_OVERRIDE`, `SHORT_SCALE`, `FCST_SCALE` — KPI-tuning knobs. `RAW.DATE_DIM` (1,096 rows) exists but is not modelled in the ontology. `FORECAST`/`ACTUALS` (1.1M rows each) are in the ontology as a bare `FORECAST_QUANTITY` with no accuracy/bias metric, even though `SC_DEMAND` defines them.

---

## Proposed work

### Phase 1 — Time as a first-class governed dimension (highest impact)

1. Add a conformed `CALENDAR` entity to `SC_ONTOLOGY_360` backed by `RAW.DATE_DIM`, with `DATE`, `MONTH`, `QUARTER`, `YEAR`, `FISCAL_PERIOD`, `IS_FUTURE`, and relationships from all six facts to it. This makes cross-fact time comparison legal and is the fix that makes the "one path per fact to each dimension" claim on `/ontology` true for time as well.
2. Extend `querySemanticView` with a `filters` option: structured predicates only (`{ ref, op, value }`), refs validated against `INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS`, values bound — never string-concatenated. Mirror it in `semanticViewSql` so provenance keeps matching what ran.
3. Decide and enforce an as-of rule for future-dated rows. Default: exclude `delivery_date > CURRENT_DATE` from realized-service metrics; surface the open/future backlog as its own explicitly-labelled figure. Record the rule in `METRIC_DEFINITION` so it is governed, not hardcoded in the app.

### Phase 2 — Period-aware UI

4. Add a shared period control (This month / Last month / Trailing 3 / Trailing 12 / Custom, plus an as-of date) in `components/app-header.tsx`, held in the URL as search params so pages stay server-rendered and shareable.
5. Thread the period through `/`, `/operations`, and `/api/ask`. Add a trend chart per headline metric (month on x-axis) next to each `StatTile`, plus prior-period delta and YoY. `recharts` is already installed.

### Phase 3 — Targets and judgement

6. Add `target_value`, `warn_threshold`, `fail_threshold` columns to `GOVERNANCE.METRIC_DEFINITION`, populate for the 14 metrics, and surface variance-to-target on the overview and metric registry cards using the existing `direction` field to pick the comparison sense. Extend `StatusPill` to a target-aware RAG state distinct from drift status.

### Phase 4 — Drill-down to atomic evidence

7. Add `POST /api/drilldown` that takes a metric id plus the active dimension/period filters and returns the offending atomic rows from the canonical fact named in `METRIC_DEFINITION.canonical_fact` (late PO lines, short-shipped order lines, freight invoices over accrual), capped and paginated. Wire a "show the rows" affordance into the `/operations` tables and the `/ask` answer card.

### Phase 5 — Make the governance claim hold end to end

8. Honour `persona` in `/api/ask`: restrict the offered metric catalogue to the views that persona is granted (`PERSONA_VIEW_ACCESS`) and execute under that persona's scope, so a scoped persona demonstrably sees fewer rows with the same definition. Alternatively remove the selector — but the honest fix is to wire it.
9. Replace `runAsRole`'s ad-hoc connections with caller's-rights execution (`querySnowflake(sql, { callersRights: true })`) where the caller identity is available, keeping the explicit-role path only as a local-dev fallback and pooling it. Read the warehouse from config rather than hardcoding `COMPUTE_WH`.
10. Put authorization in front of the app: gate on the caller's Snowflake identity in SPCS, and either take the public Vercel deployment down or put it behind auth with a read-only, row-scoped demo role. Flag explicitly before changing the live deployment.

### Phase 6 — Performance and resilience

11. Cache the registry, ontology entities, relationships and persona catalogue with a short `revalidate` (they change on deploy, not per request) and fetch them once per request rather than twice in `/api/ask` and `/api/consistency`.
12. Wrap each page section in `Suspense` with skeletons so one slow semantic query doesn't blank the page; move the `try/catch` down to section granularity.

### Phase 7 — Drift as a running control

13. Create a Snowflake task to run `METRIC_DRIFT_TEST()` on a schedule, with an alert/notification on `FAIL`. Add `run_id` to `METRIC_DRIFT_RESULT` and replace the `MAX(run_at) - 30s` window with it.
14. Add a drift history panel to `/metrics` charting pass/fail and max spread over time from the 96 existing rows, so the control shows a track record rather than a single snapshot.

### Phase 8 — Hygiene

15. Delete `/api/time`, `/api/query`, `time-card.tsx`, `query-card.tsx`, `session-card.tsx`.
16. Add the missing `__tests__/`: unit tests for `assertIdent`/filter validation (injection attempts must throw), `formatMetric`/`parseSynonyms` edge cases, and route-handler tests for `/api/ask` (unregistered metric id from the model must be rejected) and `/api/consistency`, mocking `lib/snowflake`.
17. Replace the template `README.md` with a real one: architecture, the governance model, the as-of/future-date rule, and how to run drift locally. Document the `UTIL` nudge tables as synthetic-data generation knobs (or drop them from the shipped database) so nobody mistakes them for business logic.

---

## Sequencing and risk

Phases 1–2 deliver most of the realism gain and should land first; Phase 3 is cheap once the period exists. Phase 5 item 10 touches a live public deployment — I'll confirm before acting on it. Phases 1, 3, 7 and 13 change Snowflake objects (`SC_ONTOLOGY_360`, `METRIC_DEFINITION`, `METRIC_DRIFT_RESULT`, a new task); each will be a reviewable DDL script, and the drift test must be re-run after every semantic-view change to prove the calendar addition didn't perturb any canonical value.

**Open questions I'd like answered before Phase 1, though I can proceed on stated defaults:**

- Fiscal calendar: is 3M's fiscal year calendar-aligned, or do you want a fiscal period on `CALENDAR`? (Default: calendar months only.)
- Future-dated rows: exclude from realized metrics and show separately as open backlog? (Default: yes.)
- Target values: do you have real targets for the 14 metrics, or should I seed plausible ones clearly labelled as illustrative?
