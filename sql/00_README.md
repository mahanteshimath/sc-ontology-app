# sql/ — build order

This directory is the complete, replayable record of the `SUPPLY_CHAIN` database. Nothing is
built by hand: if a query had to be run against the account, it is a file here.

## Why the 00* files exist

`01`–`08` are **increments**. They mutate an existing base layer and cannot run against an empty
account:

- `01` calls `GET_DDL('SEMANTIC_VIEW','SC_ONTOLOGY_360')` and string-splices a `CALENDAR` entity
  into the result. No view, no splice.
- `02` runs `ALTER TABLE GOVERNANCE.METRIC_DEFINITION ADD COLUMN`.
- `03` runs nine `UPDATE`s keyed on existing `metric_id` values.
- `07` splices `GET_DDL` output for six semantic views.
- `08` builds `SNOWFLAKE.ML` models over `CANONICAL.FCT_ORDER_LINE_FULFILLMENT`.

The base layer they assume was originally built ad-hoc in a previous account and existed in no
file. The `00*` scripts are that base layer, reconstructed so a rebuild is never ad-hoc again.

## Run order

Run with `node scripts/rebuild.mjs`, which enforces this order and stops on the first
error. `scripts/rebuild.mjs` is the authoritative order, not the filenames.

It does not split statements client-side. `snow sql -f` splits on semicolons, which
corrupts every `DECLARE … END` body in this directory — the `METRIC_DRIFT_TEST`
procedure in `00f` and the `GET_DDL` splice blocks in `01` and `07`. The runner submits
each file whole and lets Snowflake's own parser find the statement boundaries.

Useful flags: `--dry-run`, `--only 00c`, `--from 01`, `--verify`.

| Order | File | Builds |
|---|---|---|
| 1 | `00a_foundation.sql` | database, 6 schemas, 8 roles, warehouse grants |
| 2 | `00b_raw_dimensions.sql` | `RAW.DATE_DIM`, `PART`, `SUPPLIER`, `CUSTOMER`, `NODE`, `CARRIER`, `LANE` |
| 3 | `00c_raw_transactions.sql` | the 6 RAW transactional sources, full scale |
| 4 | `00d_canonical.sql` | the 5 `CANONICAL.FCT_*` atomic-grain facts |
| 5 | `00e_semantic.sql` | the 8 `SEMANTIC.SC_*` views |
| 6 | `00f_governance.sql` | metric registry, drift procedure, ontology views, personas |
| 7 | `01`–`07` | the increments, unchanged |
| 8 | `07b_prediction_objects.sql` | `PREDICT_TARGET_BREACH`, `V_METRIC_OUTLOOK`, `SC_OUTLOOK` — objects `08` calls but never creates |
| 9 | `08_prediction_layer.sql` | ML forecast, anomaly detection (~95s) |
| 10 | `10b_geospatial_reference.sql` | geocoded nodes, lane geometry and chokepoint reference data |
| 11 | `90_verify_base.sql` | splice-anchor assertions, registry shape, the drift gate |
| 12 | `91_verify_personas.sql` | proves the EU row scope is live |
| 13 | `92_verify_counts.sql` | row counts, snapshot cardinality, future-dated share |

### Why 07b is named that way

`08_prediction_layer.sql` calls `GOVERNANCE.PREDICT_TARGET_BREACH()`, reads
`GOVERNANCE.V_METRIC_OUTLOOK` and grants on `SEMANTIC.SC_OUTLOOK` — none of which it
creates. Its own comment admits it: "Full procedure body: see
GOVERNANCE.PREDICT_TARGET_BREACH in the account." That body was never committed, so on a
fresh account `08` fails with `Unknown user-defined function`. `07b` supplies all three.

The prefix puts it in the right place in a directory listing: `_` (0x5F) sorts before `b`
(0x61), so `07_` < `07b` < `08_`. An `08a` name would sort *after* `08` and read as
something that runs later.

It cannot move earlier than `03`: `PREDICT_TARGET_BREACH` reads
`METRIC_DEFINITION.target_value`, which `02` adds and `03` populates. Run it sooner and
every z-score is NULL while the procedure still reports success.

## Hazard: never run 00e after 01

`00e` creates `SC_ONTOLOGY_360` with 10 entities. `01` then rewrites it to `create or alter` and
adds the `CALENDAR` entity plus 4 relationships, reaching 11 entities and 16 relationships.

Re-running `00e` **after** `01` silently reverts the view to 10 entities. `CALENDAR` disappears,
and because `lib/period.ts` filters on `calendar.cal_date` and `calendar.is_future`, every page
that applies a reporting period starts failing with an unresolved-dimension error.

If you need to rebuild the semantic layer, run `00e` and then `01` again, in that order. The
runner does this automatically; the danger is only in running a single file by hand.

## Data fidelity

The transactional data in `00c` is synthetic and generated from fixed seeds, so a rebuild is
reproducible. It is shaped to satisfy the properties the application and its tests depend on:

- RAW spans 2024-10-03..2026-11-25, so roughly 2.8% of receipt and shipment rows are dated after
  2026-09-20. This is deliberate: `02_as_of_rule.sql` records the as-of rule that excludes them,
  and `scripts/probe-asof.mjs` exercises it.
- Inventory snapshots are month-end only, 2024-10-31..2026-09-30 — exactly 24 dates. The
  non-additive-over-time behaviour of a snapshot depends on this.
- Customer OTD differs slightly between the all-region and EU-only row scopes, so
  `91_verify_personas.sql` can prove row scoping is active rather than assumed.

These are not reproductions of any real 3M figures, and the targets in `03_targets.sql` are
labelled `ILLUSTRATIVE` for the same reason.
