-- ---------------------------------------------------------------------------
-- Phase 1b — Record the as-of rule, and the target columns, as governed metadata.
--
-- The source data runs to 2026-11-25 while today is 2026-09-20, so ~2.8% of
-- shipment and receipt rows are dated in the future. Before this change those
-- rows were silently inside every "current" service metric. With the CALENDAR
-- dimension in place the effect is visible: unfiltered, supplier OTD for
-- 2026-11 reads 0.0000 — not because suppliers failed, but because none of
-- those promised receipts have happened yet.
--
-- The rule is recorded here rather than hardcoded in the application so that
-- the conversational layer, the UI and any future consumer all apply the same
-- scope, and so that the scope is reviewable alongside the definition itself.
--
--   REALIZED — event-grain measure of something that has already happened.
--              Must be filtered to calendar.is_future = 0.
--   SNAPSHOT — balance measured at a point in time. Not additive across
--              periods: a period filter must select the latest snapshot in
--              range rather than aggregate over it. Inventory snapshots stop
--              at 2026-09-30, so no future exclusion is needed.
--
-- NOTE ON THE DRIFT TEST: METRIC_DRIFT_TEST deliberately keeps comparing
-- unfiltered, all-history values. Drift is a test of definitional agreement
-- between views, not of reporting period — narrowing its scope would weaken it.
-- The registry therefore shows the all-history canonical value, and the
-- application labels its own period-scoped figures as such.
--
-- The target columns are added here too (populated in 03_targets.sql), because
-- lib/sc.ts reads all six columns in one registry query and would fail if only
-- some existed.
--
-- One ADD COLUMN per statement: Snowflake does not accept IF NOT EXISTS on a
-- multi-column ADD.
-- ---------------------------------------------------------------------------

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS as_of_scope STRING
  COMMENT 'REALIZED = event already occurred, must exclude future-dated rows. SNAPSHOT = point-in-time balance, non-additive across periods.';

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS as_of_rule STRING
  COMMENT 'The filter or selection rule the application must apply for this metric to be a measure of realized performance.';

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS target_value FLOAT
  COMMENT 'Governed target for this metric, in the same unit as the metric itself.';

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS warn_threshold FLOAT
  COMMENT 'Amber boundary. Interpreted using DIRECTION: for higher-is-better a value at or above this is amber, below FAIL_THRESHOLD is red.';

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS fail_threshold FLOAT
  COMMENT 'Red boundary, interpreted using DIRECTION.';

ALTER TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
  ADD COLUMN IF NOT EXISTS target_source STRING
  COMMENT 'Provenance of the target: who set it and on what basis. ILLUSTRATIVE means it was seeded for demonstration and is not a committed business target.';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
   SET as_of_scope = 'SNAPSHOT',
       as_of_rule  = 'Balance at a point in time. Do not aggregate across periods; select the latest snapshot within the requested period.'
 WHERE grain = 'material_node_snapshot';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
   SET as_of_scope = 'REALIZED',
       as_of_rule  = 'Exclude future-dated rows: WHERE calendar.is_future = 0. Rows dated after today are promised future activity, not measured performance.'
 WHERE grain <> 'material_node_snapshot';
