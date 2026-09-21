_Note: the only assumption I had to make is spelled out under "Fidelity limit" below._

## Context

The new connection (`GI21459` / `RQPCPYK-BY42913`, user `MONTY`, `ACCOUNTADMIN`, `COMPUTE_WH`) is empty: `SHOW DATABASES` returns only `SNOWFLAKE`, `SNOWFLAKE_LEARNING_DB`, `SNOWFLAKE_SAMPLE_DATA`, `USER$MONTY`. No `SUPPLY_CHAIN`.

The repo's `sql/01`–`08` are **increments**, not a build. They cannot run against an empty account:

- [sql/01_calendar_dimension.sql](sql/01_calendar_dimension.sql) calls `GET_DDL('SEMANTIC_VIEW','SC_ONTOLOGY_360')` and string-splices a `CALENDAR` entity into the result.
- [sql/02_as_of_rule.sql](sql/02_as_of_rule.sql) runs `ALTER TABLE GOVERNANCE.METRIC_DEFINITION ADD COLUMN`.
- [sql/03_targets.sql](sql/03_targets.sql) runs nine `UPDATE`s keyed on existing `metric_id`s.
- [sql/07_verified_queries.sql](sql/07_verified_queries.sql) splices `GET_DDL` output for six semantic views.
- [sql/08_prediction_layer.sql](sql/08_prediction_layer.sql) builds ML models over `CANONICAL.FCT_ORDER_LINE_FULFILLMENT`.

The base layer they assume — RAW tables with data, CANONICAL facts, the 8 SEMANTIC views, the GOVERNANCE registry and the `METRIC_DRIFT_TEST` procedure — was built ad-hoc in the old account and exists in **no file in this repo**. Authoring it is the work.

A dependency sweep of `app/`, `lib/`, `components/`, `__tests__/` and `sql/` established the exact contract the base layer must satisfy: which entities `01`'s splice anchors require, which columns [app/api/drilldown/route.ts](app/api/drilldown/route.ts) and [sql/05_exception_rules.sql](sql/05_exception_rules.sql) read from each fact, and which 14 `metric_id`s `03` updates.

### Fidelity limit (the one assumption)

The old data came from generator knobs in `UTIL` (`OTD_NUDGE`, `SUP_OTD_NUDGE`, `FILL_OVERRIDE`, `SHORT_SCALE`, `FCST_SCALE`) whose values are recorded nowhere readable. I will **reconstruct distributions to match the recorded observable facts**, not reproduce the old rows byte-for-byte:

- `SC_LOGISTICS` OTD Aug-2026 approximately 0.878, `SC_LOGISTICS_EU` approximately 0.880 (close but unequal — same definition, different row scope)
- RAW span 2024-10-03..2026-11-25, approximately 2.8% of receipt/shipment rows future-dated against 2026-09-20
- exactly one inventory snapshot per month, 2024-10-31..2026-09-30 (24 dates)
- row counts 420K / 1.5M / 1.48M / 137K

**Consequence:** values will be plausible and internally consistent, and every threshold in `03_targets.sql` will be exercised, but individual numbers will not equal the old account's to 6 decimal places. The drift test still gates correctness, because it checks each semantic view agrees with its canonical fact — a test of definitional agreement, not of specific values.

## Design decisions

**Scale** — full, matching the old counts. Pure SQL (`GENERATOR` + seeded `RANDOM`), minutes on `COMPUTE_WH`.

**RAW breadth** — only what is read: `DATE_DIM`, `PART`, `SUPPLIER`, `CUSTOMER`, `NODE`, `CARRIER`, `LANE`, plus the transactional sources behind the 5 facts. Not all 78. `UTIL` is created but left empty since nothing reads it.

**Numbering** — new base-layer files take a `00*` prefix so `01`–`08` keep the numbers you already know them by.

**Idempotency hazard** — base scripts use `CREATE OR REPLACE` so a rebuild works from zero. This matters for `SC_ONTOLOGY_360`: `01` rewrites it to `create or alter`, so `00e` then `01` is safe, but running `00e` *after* `01` silently drops the `CALENDAR` dimension. The runner enforces order; the file header says so.

## Everything goes in sql/

Per your instruction, **no query is run that does not first exist as a file in `sql/`**. That covers three categories, not just the DDL:

1. **Base-layer DDL** — `sql/00a`..`00f` below.
2. **Verification queries** — the drift-test call, row-count assertions, the persona row-scope comparison, the splice-anchor pre-checks. These go in `sql/90_verify_base.sql`, `sql/91_verify_personas.sql`, `sql/92_verify_counts.sql` rather than being typed ad-hoc into the console.
3. **Anything I discover I need mid-build** — if a fix or investigation query turns out to be necessary, it is appended to the relevant numbered file (or a new `sql/93_*.sql`) before being run, so the directory is a complete and replayable record of the rebuild.

`sql/00_README.md` records the run order and the `00e`-after-`01` hazard.

## Implementation steps

| File | Contents |
|---|---|
| `sql/00a_foundation.sql` | `SUPPLY_CHAIN` db; schemas `RAW`, `CANONICAL`, `SEMANTIC`, `GOVERNANCE`, `UTIL`, `APPS`. Roles `SC_PLANNER`, `SC_PROCUREMENT`, `SC_LOGISTICS`, `SC_LOGISTICS_EU`, `SC_ONTOLOGY_STEWARD`, plus owner roles `SC_PROCUREMENT_ANALYST`, `SC_LOGISTICS_ANALYST`, `SC_PLANNING_ANALYST`. All granted to `MONTY`; `USAGE ON WAREHOUSE COMPUTE_WH` to each. |
| `sql/00b_raw_dimensions.sql` | `DATE_DIM` (2024-01-01..2026-12-31) with exactly the columns `01` maps: `DATE_KEY`, `MONTH_START`, `PERIOD`, `FISCAL_QUARTER`, `YEAR_NUM`, `IS_WEEKDAY`. `PART` (PK `MATERIAL_ID`, + `PRODUCT_FAMILY`, `BUSINESS_SEGMENT`, `ABC_CLASS`, `STANDARD_COST`), `SUPPLIER`, `CUSTOMER`, `NODE`, `CARRIER`, `LANE`. |
| `sql/00c_raw_transactions.sql` | PO receipt lines (420K), customer order lines (1.5M), landed-cost shipments (1.48M), inventory snapshots (137K, month-end only), production orders, demand forecast with `PERIOD` as a `YYYY-MM` string (`01` relies on it having no day key). Seeded, hitting the distribution targets above. |
| `sql/00d_canonical.sql` | `FCT_SUPPLIER_DELIVERY_LINE`, `FCT_ORDER_LINE_FULFILLMENT`, `FCT_LANDED_COST_SHIPMENT`, `FCT_INVENTORY_SNAPSHOT`, `FCT_REQUISITION_LINE`. Column lists taken verbatim from `05_exception_rules.sql`'s `display_columns` plus the dimension map at [app/api/drilldown/route.ts](app/api/drilldown/route.ts):42-58, so no drill-down can reference a missing column. |
| `sql/00e_semantic.sql` | `SC_ONTOLOGY_360` with 10 entities and 12 relationships (`CALENDAR` + 4 edges arrive via `01`, reaching the recorded 11/16). Entity names are fixed by `01`'s splice anchors and must be exact: `PURCHASE_ORDER`, `ORDER_FULFILLMENT`, `INVENTORY`, `PRODUCTION_ORDER`, `LANDED_COST`, `FORECAST`, `PART`, `SUPPLIER`, `CUSTOMER`, `NODE`. `LANDED_COST` gets no direct `PART` or `CALENDAR` edge (it reaches both via `COST_TO_FULFILLMENT`) or every landed-cost metric fails with a multi-path error. Then `SC_SUPPLIER`, `SC_FULFILLMENT`, `SC_INVENTORY`, `SC_LANDED_COST`, `SC_DEMAND`, `SC_MANUFACTURING`, and `SC_SUPPLIER_LEGACY_DEFECT` (average-of-averages bug, deliberately). |
| `sql/00f_governance.sql` | `METRIC_DEFINITION` **without** the six columns `02` adds (otherwise `ADD COLUMN IF NOT EXISTS` no-ops and `03`'s targets land nowhere) — 14 metrics: `supplier_otd_pct`, `supplier_fill_rate`, `ppv`, `otd_pct`, `otif_pct`, `fill_rate_pct`, `perfect_order_pct`, `freight_cost_usd`, `freight_invoiced_usd`, `freight_bill_variance_usd`, `landed_cost_per_unit`, `landed_cost_usd`, `days_of_inventory`, `inventory_value_usd`, each with `canonical_fact` and `canonical_sql`. `METRIC_BINDING` (26), `METRIC_DRIFT_RESULT`, `METRIC_DRIFT_BASELINE`, `METRIC_DRIFT_NEGATIVE_CONTROL`. Procedure `METRIC_DRIFT_TEST(FLOAT)` — runs each binding's semantic-view query, compares to `canonical_sql`, writes one row per metric per `RUN_ID`. Views `ONTOLOGY_ENTITY` / `ONTOLOGY_RELATIONSHIP` over `INFORMATION_SCHEMA.SEMANTIC_*`, deriving `ENTITY_ROLE` from the literal phrase `Conformed dimension` in the entity comment. `PERSONA_CATALOG` (5), `PERSONA_VIEW_ACCESS` (17), `PERSONA_REGION_SCOPE`, and a row access policy binding `SC_LOGISTICS_EU` to `ship_region='EU'`. `AGENT_IMPROVEMENT_CANDIDATE` view. |
| `sql/90_verify_base.sql` | Splice-anchor occurrence assertions (each `01`/`07` anchor must appear exactly once in `GET_DDL`), then `CALL METRIC_DRIFT_TEST()` and the 14-metric all-PASS check. |
| `sql/91_verify_personas.sql` | `SC_LOGISTICS` vs `SC_LOGISTICS_EU` OTD for Aug-2026 under one definition, proving row scope is live. |
| `sql/92_verify_counts.sql` | Row-count assertions against the four documented counts; assert exactly 24 distinct inventory snapshot dates; assert the future-dated share is near 2.8%. |
| `scripts/rebuild.mjs` | Splits each file on statement boundaries (respecting `$$` and `DECLARE…END`), executes `00a`→`00f`, then `01`→`08`, then `90`→`92`, stopping on first error with file, statement number and message. |

## Verification

1. Run `scripts/rebuild.mjs`. `08` may need a second pass: `SNOWFLAKE.ML.FORECAST` needs at least 12 monthly observations, which exist only after `00c`.
2. `sql/90_verify_base.sql` is **the gate** — 14 metrics, all `PASS`, zero spread. Anything else means a semantic view disagrees with its canonical fact, and I fix it before proceeding.
3. `sql/91` and `sql/92` must pass their assertions.
4. `npm run smoke`, `node scripts/probe-asof.mjs`, `node scripts/smoke-outlook.mjs`.
5. `npm test` — expect 145/151 with the **same 6** Windows-only path failures in `__tests__/lib/snowflake.test.ts`. Any other failure is real. Then `npm run typecheck`.
6. Point `app.yml` / env at the new account; rewrite `snowflake-objects.md` with counts I actually verified rather than carried over.

## Cost and risk

Generation is a handful of large `INSERT … SELECT FROM GENERATOR` statements on an XS warehouse — minutes, cents. The daily drift task (serverless XSMALL) and two alerts are resumed as `04`/`06` specify; both suspendable.

`SC_GOVERNANCE_EMAIL` hardcodes `mhiremath@mmm.com`, which matches your connection identity, so no change is needed — but note `06`'s alert starts emailing on drift failures once resumed.

Biggest risk is `01` and `07`'s string splices: they `REPLACE` on anchors that must occur exactly once in `GET_DDL` output. `sql/90_verify_base.sql` asserts those counts before the splices run, rather than letting a silent no-op surface later as a missing dimension.

## Critical Files

- [sql/01_calendar_dimension.sql](sql/01_calendar_dimension.sql) - its splice anchors dictate the exact entity, relationship and dimension names `00e` must emit
- [sql/05_exception_rules.sql](sql/05_exception_rules.sql) - `display_columns` is the authoritative column list for every CANONICAL fact in `00d`
- [sql/03_targets.sql](sql/03_targets.sql) - fixes the 14 `metric_id` values `00f` must seed
- [app/api/drilldown/route.ts](app/api/drilldown/route.ts) - the dimension-to-column map the facts must satisfy
- [lib/sc.ts](lib/sc.ts) - every GOVERNANCE column the app reads, so `00f`'s schema cannot be short
