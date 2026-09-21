-- ---------------------------------------------------------------------------
-- 00f — GOVERNANCE: metric registry, drift control, ontology catalogue, personas.
--
-- ---------------------------------------------------------------------------
-- METRIC_DEFINITION IS CREATED WITHOUT SIX COLUMNS ON PURPOSE
--
-- as_of_scope, as_of_rule, target_value, warn_threshold, fail_threshold and
-- target_source are NOT declared here. 02_as_of_rule.sql adds them with
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS and then populates as_of_scope and
-- as_of_rule; 03_targets.sql populates the rest.
--
-- Declaring them here would make 02's ADD COLUMN a silent no-op. That alone is
-- harmless, but 02's two UPDATE statements are what actually classify every
-- metric REALIZED or SNAPSHOT, and 03's nine UPDATEs are what set the targets --
-- so the columns would exist, stay NULL where 02/03 did not reach them, and the
-- application would render every metric with no as-of rule and no target while
-- appearing to work. The omission is what keeps 02 and 03 meaningful.
--
-- lib/sc.ts reads all six in one registry query (getMetricRegistry), so the
-- application cannot start until 02 has run. That ordering is enforced by
-- scripts/rebuild.mjs.
--
-- ---------------------------------------------------------------------------
-- WHY CANONICAL_SQL EXISTS AT ALL
--
-- Every metric carries the exact SQL that computes it from its atomic fact. That
-- is the independent second opinion: the semantic view says what the number is,
-- CANONICAL_SQL says what it should be, and METRIC_DRIFT_TEST runs both and
-- compares. Without it, "the views agree with each other" would be the strongest
-- claim available, and two views can agree while both being wrong.
--
-- Each statement must return exactly one row and one column named VAL. The drift
-- procedure relies on that shape, and on the semantic-view column being named
-- after the metric's last identifier segment.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE TABLE METRIC_DEFINITION (
  metric_id      STRING NOT NULL COMMENT 'Stable identifier. Referenced by METRIC_BINDING, METRIC_EXCEPTION_RULE, the evaluation set and the prediction layer.',
  business_name  STRING NOT NULL COMMENT 'Name a business reader would use.',
  domain         STRING NOT NULL COMMENT 'Supply chain domain the metric belongs to.',
  definition     STRING NOT NULL COMMENT 'Plain-language definition. The authoritative wording: the semantic view comments restate this, they do not extend it.',
  numerator      STRING          COMMENT 'Numerator in words, for rates and ratios. NULL for sums.',
  denominator    STRING          COMMENT 'Denominator in words. NULL for sums. Naming it explicitly is what distinguishes a line-weighted rate from an average of rates.',
  grain          STRING NOT NULL COMMENT 'Atomic grain the metric is computed over. 02_as_of_rule.sql switches on this value: material_node_snapshot becomes SNAPSHOT, everything else REALIZED.',
  canonical_fact STRING NOT NULL COMMENT 'Schema-qualified atomic fact. Must match METRIC_EXCEPTION_RULE.canonical_fact or the drill-down refuses to run.',
  canonical_sql  STRING NOT NULL COMMENT 'Independent SQL computing the metric from the canonical fact. Must return one row, one column, named VAL. This is what the drift test compares every semantic view against.',
  unit           STRING          COMMENT 'Unit of the value: ratio, usd, days, count.',
  direction      STRING          COMMENT 'higher, lower, or to_zero. Determines how targets and thresholds are interpreted.',
  owner_role     STRING          COMMENT 'Role accountable for the definition and its target.',
  version        NUMBER          COMMENT 'Definition version. Increment when the meaning changes, not when the wording does.',
  effective_from DATE            COMMENT 'Date this version took effect.',
  CONSTRAINT pk_metric_definition PRIMARY KEY (metric_id)
) COMMENT = 'The governed metric catalogue. One row per metric, carrying both the business definition and the canonical SQL that defines it independently of any semantic view.';

INSERT INTO METRIC_DEFINITION
  (metric_id, business_name, domain, definition, numerator, denominator, grain,
   canonical_fact, canonical_sql, unit, direction, owner_role, version, effective_from)
SELECT * FROM VALUES
 ('supplier_otd_pct','Supplier On-Time Delivery','SUPPLIER',
  'Share of purchase-order receipt lines received on or before the date the supplier promised. Weighted by receipt line, so a supplier with many lines influences the result in proportion to its volume.',
  'Receipt lines where RECEIPT_DATE <= PROMISED_DATE','All receipt lines in scope','po_receipt_line',
  'CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'SELECT AVG(is_on_time) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'ratio','higher','SC_PROCUREMENT_ANALYST',2,'2024-10-01'::DATE),

 ('supplier_fill_rate','Supplier Fill Rate','SUPPLIER',
  'Share of purchase-order receipt lines where the quantity received met the quantity ordered.',
  'Receipt lines where RECEIVED_QTY >= ORDERED_QTY','All receipt lines in scope','po_receipt_line',
  'CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'SELECT AVG(is_in_full) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'ratio','higher','SC_PROCUREMENT_ANALYST',1,'2024-10-01'::DATE),

 ('ppv','Purchase Price Variance','SUPPLIER',
  'Unfavourable dollars arising where the invoiced unit price exceeded standard cost, extended by the quantity actually received rather than ordered.',
  NULL,NULL,'po_receipt_line',
  'CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'SELECT SUM(extended_price_variance) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'usd','to_zero','SC_PROCUREMENT_ANALYST',1,'2024-10-01'::DATE),

 ('otd_pct','Customer On-Time Delivery','FULFILLMENT',
  'Share of customer order lines delivered on or before the promised date. Outbound: this measures delivery to customers and is not comparable with supplier OTD, which measures receipt from suppliers.',
  'Order lines where DELIVERY_DATE <= PROMISE_DATE','All order lines in scope','order_line',
  'CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'SELECT AVG(is_on_time) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'ratio','higher','SC_LOGISTICS_ANALYST',3,'2024-10-01'::DATE),

 ('otif_pct','On Time In Full','FULFILLMENT',
  'Share of customer order lines that were both delivered by the promised date and shipped complete. Necessarily at or below both OTD and fill rate taken separately.',
  'Order lines where IS_ON_TIME = 1 AND IS_IN_FULL = 1','All order lines in scope','order_line',
  'CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'SELECT AVG(is_otif) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'ratio','higher','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('fill_rate_pct','Customer Fill Rate','FULFILLMENT',
  'Share of customer order lines shipped in the full quantity ordered.',
  'Order lines where SHIPPED_QTY >= ORDERED_QTY','All order lines in scope','order_line',
  'CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'SELECT AVG(is_in_full) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'ratio','higher','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('perfect_order_pct','Perfect Order Rate','FULFILLMENT',
  'Share of customer order lines delivered on time, in full, and with the delivery date accepted by the customer. Strictly harder to satisfy than OTIF because of the third condition.',
  'Order lines where IS_OTIF = 1 AND IS_CDDA_MET = 1','All order lines in scope','order_line',
  'CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'SELECT AVG(is_perfect_order) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
  'ratio','higher','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('landed_cost_per_unit','Landed Cost per Unit','LANDED_COST',
  'Total landed cost divided by units shipped. A ratio of two sums, never an average of per-shipment ratios: averaging ratios would weight a one-unit shipment equally with a thousand-unit one.',
  'Sum of material, freight, duty and handling cost','Sum of shipped units','shipment',
  'CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'SELECT SUM(total_landed_cost) / NULLIF(SUM(shipped_qty), 0) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'usd','lower','SC_LOGISTICS_ANALYST',2,'2024-10-01'::DATE),

 ('landed_cost_usd','Total Landed Cost','LANDED_COST',
  'Total delivered cost of goods: material, freight, duty and handling. Excludes accessorial charges, which are billed separately.',
  NULL,NULL,'shipment',
  'CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'SELECT SUM(total_landed_cost) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'usd','lower','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('freight_cost_usd','Freight Cost','LANDED_COST',
  'Freight accrued on shipments.',
  NULL,NULL,'shipment',
  'CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'SELECT SUM(freight_cost) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'usd','lower','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('freight_invoiced_usd','Freight Invoiced','LANDED_COST',
  'Freight the carriers actually invoiced.',
  NULL,NULL,'shipment',
  'CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'SELECT SUM(invoiced_freight_amt) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'usd','lower','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('freight_bill_variance_usd','Freight Bill Variance','LANDED_COST',
  'Invoiced freight less accrued freight. Positive means carriers billed more than was accrued, which is the recoverable amount in a freight audit.',
  NULL,NULL,'shipment',
  'CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'SELECT SUM(freight_bill_var_amt) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
  'usd','to_zero','SC_LOGISTICS_ANALYST',1,'2024-10-01'::DATE),

 ('days_of_inventory','Days of Inventory','INVENTORY',
  'On-hand units divided by average daily demand, measured at a single month-end snapshot. A period filter must select one snapshot date: averaging this across months mixes balances observed at different points in time.',
  'Sum of on-hand units at the snapshot','Sum of average daily demand at the snapshot','material_node_snapshot',
  'CANONICAL.FCT_INVENTORY_SNAPSHOT',
  'SELECT SUM(on_hand_qty) / NULLIF(SUM(avg_daily_demand), 0) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT',
  'days','lower','SC_PLANNING_ANALYST',2,'2024-10-01'::DATE),

 ('inventory_value_usd','Inventory Value','INVENTORY',
  'On-hand quantity valued at standard cost, at a single month-end snapshot. Never sum across snapshot dates: the result is a plausible-looking multiple of the truth.',
  NULL,NULL,'material_node_snapshot',
  'CANONICAL.FCT_INVENTORY_SNAPSHOT',
  'SELECT SUM(inventory_value) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT',
  'usd','lower','SC_PLANNING_ANALYST',1,'2024-10-01'::DATE)
AS v(metric_id, business_name, domain, definition, numerator, denominator, grain,
     canonical_fact, canonical_sql, unit, direction, owner_role, version, effective_from);

-- ---------------------------------------------------------------------------
-- METRIC_BINDING — where each metric is exposed.
--
-- Every metric appears in SC_ONTOLOGY_360 and in exactly one domain view, so
-- 28 rows for 14 metrics. The previous build of this dataset recorded 26; two
-- metrics there evidently had a single binding. 28 is the more useful shape,
-- because a metric bound only once can never fail the drift test -- there is
-- nothing to disagree with -- so it would appear green while being untested.
--
-- 06_drift_notification.sql adds a 29th row binding SC_SUPPLIER_LEGACY_DEFECT
-- under the NEGATIVE_CONTROL persona, which is what makes a run fail on demand.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE METRIC_BINDING (
  metric_id        STRING NOT NULL COMMENT 'Metric being exposed.',
  semantic_view    STRING NOT NULL COMMENT 'Unqualified semantic view name.',
  metric_reference STRING NOT NULL COMMENT 'Entity-qualified metric reference as written inside SEMANTIC_VIEW(...), e.g. purchase_order.supplier_otd_pct. The drift test derives the output column name from the segment after the dot.',
  persona_role     STRING          COMMENT 'Persona this binding serves, where the binding exists for one. NEGATIVE_CONTROL marks a binding that is expected to disagree.',
  CONSTRAINT pk_metric_binding PRIMARY KEY (metric_id, semantic_view, metric_reference)
) COMMENT = 'Maps each governed metric to every semantic view that exposes it. A metric with two or more bindings is testable for drift; a metric with one is not.';

INSERT INTO METRIC_BINDING (metric_id, semantic_view, metric_reference, persona_role)
SELECT * FROM VALUES
 ('supplier_otd_pct','SC_ONTOLOGY_360','purchase_order.supplier_otd_pct',NULL),
 ('supplier_otd_pct','SC_SUPPLIER','supplier_delivery.supplier_otd_pct','SC_PROCUREMENT'),
 ('supplier_fill_rate','SC_ONTOLOGY_360','purchase_order.supplier_fill_rate',NULL),
 ('supplier_fill_rate','SC_SUPPLIER','supplier_delivery.supplier_fill_rate','SC_PROCUREMENT'),
 ('ppv','SC_ONTOLOGY_360','purchase_order.ppv',NULL),
 ('ppv','SC_SUPPLIER','supplier_delivery.ppv','SC_PROCUREMENT'),
 ('otd_pct','SC_ONTOLOGY_360','order_fulfillment.otd_pct',NULL),
 ('otd_pct','SC_FULFILLMENT','order_fulfillment.otd_pct','SC_LOGISTICS'),
 ('otif_pct','SC_ONTOLOGY_360','order_fulfillment.otif_pct',NULL),
 ('otif_pct','SC_FULFILLMENT','order_fulfillment.otif_pct','SC_LOGISTICS'),
 ('fill_rate_pct','SC_ONTOLOGY_360','order_fulfillment.fill_rate_pct',NULL),
 ('fill_rate_pct','SC_FULFILLMENT','order_fulfillment.fill_rate_pct','SC_LOGISTICS'),
 ('perfect_order_pct','SC_ONTOLOGY_360','order_fulfillment.perfect_order_pct',NULL),
 ('perfect_order_pct','SC_FULFILLMENT','order_fulfillment.perfect_order_pct','SC_LOGISTICS'),
 ('landed_cost_per_unit','SC_ONTOLOGY_360','landed_cost.landed_cost_per_unit',NULL),
 ('landed_cost_per_unit','SC_LANDED_COST','landed_cost.landed_cost_per_unit','SC_LOGISTICS'),
 ('landed_cost_usd','SC_ONTOLOGY_360','landed_cost.landed_cost_usd',NULL),
 ('landed_cost_usd','SC_LANDED_COST','landed_cost.landed_cost_usd','SC_LOGISTICS'),
 ('freight_cost_usd','SC_ONTOLOGY_360','landed_cost.freight_cost_usd',NULL),
 ('freight_cost_usd','SC_LANDED_COST','landed_cost.freight_cost_usd','SC_LOGISTICS'),
 ('freight_invoiced_usd','SC_ONTOLOGY_360','landed_cost.freight_invoiced_usd',NULL),
 ('freight_invoiced_usd','SC_LANDED_COST','landed_cost.freight_invoiced_usd','SC_LOGISTICS'),
 ('freight_bill_variance_usd','SC_ONTOLOGY_360','landed_cost.freight_bill_variance_usd',NULL),
 ('freight_bill_variance_usd','SC_LANDED_COST','landed_cost.freight_bill_variance_usd','SC_LOGISTICS'),
 ('days_of_inventory','SC_ONTOLOGY_360','inventory.days_of_inventory',NULL),
 ('days_of_inventory','SC_INVENTORY','inventory.days_of_inventory','SC_PLANNER'),
 ('inventory_value_usd','SC_ONTOLOGY_360','inventory.inventory_value_usd',NULL),
 ('inventory_value_usd','SC_INVENTORY','inventory.inventory_value_usd','SC_PLANNER')
AS v(metric_id, semantic_view, metric_reference, persona_role);

-- ---------------------------------------------------------------------------
-- Drift results.
--
-- RUN_ID IS THE KEY, NOT RUN_AT. lib/sc.ts selects a run by RUN_ID
-- (getLatestDrift) because an earlier version selected every row written within
-- 30 seconds of the newest, which silently merged two overlapping runs and could
-- split one run that straddled the boundary. The procedure stamps one UUID per
-- invocation, so a run is exactly identifiable.
--
-- RELATIVE_SPREAD, not absolute, is what the status is judged on. An absolute
-- spread of 50 is nothing on a $40M landed-cost total and catastrophic on an OTD
-- ratio, so a single absolute tolerance cannot serve both.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE METRIC_DRIFT_RESULT (
  run_id          STRING NOT NULL COMMENT 'One UUID per invocation of METRIC_DRIFT_TEST. Select a run by this, never by a time window.',
  run_at          TIMESTAMP_LTZ NOT NULL COMMENT 'When the run started.',
  metric_id       STRING NOT NULL COMMENT 'Metric checked.',
  business_name   STRING NOT NULL COMMENT 'Business name, copied so a result is readable without joining.',
  binding_count   NUMBER NOT NULL COMMENT 'Number of semantic-view bindings compared. A count of 1 means the metric is not actually testable.',
  canonical_value FLOAT           COMMENT 'Value from CANONICAL_SQL: the independent second opinion.',
  min_value       FLOAT           COMMENT 'Lowest value across the canonical value and all bindings.',
  max_value       FLOAT           COMMENT 'Highest value across the canonical value and all bindings.',
  value_spread    FLOAT           COMMENT 'max_value - min_value, in the metric unit.',
  relative_spread FLOAT           COMMENT 'value_spread / ABS(canonical_value). What the status is judged on, so that one tolerance works across ratios and dollar totals.',
  status          STRING NOT NULL COMMENT 'PASS, FAIL, or ERROR when a binding could not be evaluated.',
  detail          STRING          COMMENT 'Per-binding values, or the error, in readable form.'
) COMMENT = 'One row per metric per drift-test run. The track record of the control, not just its current state.';

CREATE OR REPLACE TABLE METRIC_DRIFT_BASELINE (
  metric_id       STRING COMMENT 'Metric that was diverging.',
  semantic_view   STRING COMMENT 'View the value came from.',
  metric_reference STRING COMMENT 'Metric reference inside that view.',
  observed_value  FLOAT  COMMENT 'Value observed at the time.',
  definition_sql  STRING COMMENT 'Expression that produced it.',
  root_cause      STRING COMMENT 'Why the two definitions disagreed.',
  captured_at     TIMESTAMP_LTZ COMMENT 'When the divergence was recorded.',
  note            STRING COMMENT 'What was done about it.'
) COMMENT = 'The recorded before-state: two views reporting different numbers for supplier OTD. Kept so the /consistency page can show the problem this project fixed, not merely assert that it is fixed.';

CREATE OR REPLACE TABLE METRIC_DRIFT_NEGATIVE_CONTROL (
  run_at          TIMESTAMP_LTZ COMMENT 'When the control was exercised.',
  metric_id       STRING COMMENT 'Metric used.',
  business_name   STRING COMMENT 'Business name.',
  canonical_value FLOAT  COMMENT 'Correct, line-weighted value.',
  min_value       FLOAT  COMMENT 'Lowest value across bindings.',
  max_value       FLOAT  COMMENT 'Highest value across bindings.',
  value_spread    FLOAT  COMMENT 'Observed disagreement.',
  status          STRING COMMENT 'Expected to be FAIL. A PASS here would mean the control is not working.',
  detail          STRING COMMENT 'The competing values.',
  purpose         STRING COMMENT 'Why this row exists.'
) COMMENT = 'Evidence that METRIC_DRIFT_TEST is capable of failing. A control that has only ever passed is indistinguishable from one that is not running.';

-- ---------------------------------------------------------------------------
-- METRIC_DRIFT_TEST — the control itself.
--
-- For each metric: evaluate CANONICAL_SQL, evaluate every binding through
-- SEMANTIC_VIEW(...), and compare all of them. PASS requires the relative spread
-- to be within tolerance.
--
-- HOW THE BINDING QUERY IS BUILT. A semantic-view query returns its metric in a
-- column named after the last segment of the reference, so
-- `landed_cost.landed_cost_per_unit` yields a column LANDED_COST_PER_UNIT. The
-- procedure aliases that to VAL, matching the shape CANONICAL_SQL is required to
-- return, so both sides can be fetched by the same code path.
--
-- SCOPE IS DELIBERATELY ALL-HISTORY AND UNFILTERED. No period, and no exclusion
-- of future-dated rows. This looks inconsistent with 02_as_of_rule.sql, which
-- requires the application to exclude future rows -- and the difference is the
-- point: this test asks whether two definitions agree, not whether a reporting
-- period is right. Narrowing the scope would shrink the row population the
-- comparison runs over and weaken the test for no gain.
--
-- A FAILING BINDING DOES NOT ABORT THE RUN. Each binding is wrapped so that an
-- error is recorded as ERROR against that metric and the loop continues. A run
-- that stops at the first broken metric reports nothing about the other thirteen,
-- which is the opposite of what a control is for.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE METRIC_DRIFT_TEST(TOLERANCE FLOAT)
RETURNS TABLE()
LANGUAGE SQL
COMMENT = 'Compares every semantic-view binding of every governed metric against the metric CANONICAL_SQL. Writes one row per metric to METRIC_DRIFT_RESULT under a single RUN_ID and returns that run. TOLERANCE is a relative spread.'
AS $$
DECLARE
  v_run_id    STRING;
  v_run_at    TIMESTAMP_LTZ;
  v_canon     FLOAT;
  v_min       FLOAT;
  v_max       FLOAT;
  v_n         NUMBER;
  v_detail    STRING;
  v_status    STRING;
  v_spread    FLOAT;
  v_rel       FLOAT;
  v_sql       STRING;
  v_val       FLOAT;
  -- Loop fields must be copied into locals before use as binds: Snowflake
  -- Scripting does not accept a qualified loop variable (:m.metric_id) as a bind
  -- inside a SQL statement, only a plain local (:v_mid).
  v_mid       STRING;
  v_bname     STRING;
  v_csql      STRING;
  v_view      STRING;
  v_ref       STRING;
  res         RESULTSET;
  metrics CURSOR FOR
    SELECT metric_id, business_name, canonical_sql
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
     ORDER BY metric_id;
BEGIN
  v_run_id := UUID_STRING();
  v_run_at := CURRENT_TIMESTAMP();

  FOR m IN metrics DO
    v_mid    := m.metric_id;
    v_bname  := m.business_name;
    v_csql   := m.canonical_sql;
    v_canon  := NULL;
    v_min    := NULL;
    v_max    := NULL;
    v_n      := 0;
    v_detail := '';
    v_status := 'PASS';

    -- The canonical value. If this fails the metric is unusable, so record ERROR
    -- and move on rather than letting one bad registry row end the run.
    BEGIN
      v_sql := v_csql;
      LET cres RESULTSET := (EXECUTE IMMEDIATE :v_sql);
      LET ccur CURSOR FOR cres;
      OPEN ccur;
      FETCH ccur INTO v_val;
      CLOSE ccur;
      v_canon  := v_val;
      v_min    := v_val;
      v_max    := v_val;
      v_detail := 'canonical=' || COALESCE(TO_VARCHAR(v_canon), 'NULL');
    EXCEPTION
      WHEN OTHER THEN
        v_status := 'ERROR';
        v_detail := 'canonical_sql failed: ' || SQLERRM;
    END;

    IF (v_status <> 'ERROR') THEN
      LET bres RESULTSET := (
        SELECT semantic_view, metric_reference
          FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
         WHERE metric_id = :v_mid
         ORDER BY semantic_view, metric_reference
      );
      LET bcur CURSOR FOR bres;
      FOR b IN bcur DO
        v_view := b.semantic_view;
        v_ref  := b.metric_reference;
        BEGIN
          -- Alias the metric column to VAL so both sides fetch identically.
          v_sql := 'SELECT ' || UPPER(SPLIT_PART(v_ref, '.', 2))
                   || ' AS VAL FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.'
                   || v_view || ' METRICS ' || v_ref || ')';
          LET vres RESULTSET := (EXECUTE IMMEDIATE :v_sql);
          LET vcur CURSOR FOR vres;
          OPEN vcur;
          FETCH vcur INTO v_val;
          CLOSE vcur;
          v_n      := v_n + 1;
          v_min    := LEAST(COALESCE(v_min, v_val), COALESCE(v_val, v_min));
          v_max    := GREATEST(COALESCE(v_max, v_val), COALESCE(v_val, v_max));
          v_detail := v_detail || ' | ' || v_view || '.'
                      || SPLIT_PART(v_ref, '.', 2) || '='
                      || COALESCE(TO_VARCHAR(v_val), 'NULL');
        EXCEPTION
          WHEN OTHER THEN
            v_status := 'ERROR';
            v_detail := v_detail || ' | ' || v_view || ' FAILED: ' || SQLERRM;
        END;
      END FOR;
    END IF;

    v_spread := CASE WHEN v_min IS NULL OR v_max IS NULL THEN NULL ELSE v_max - v_min END;
    v_rel    := CASE WHEN v_spread IS NULL OR v_canon IS NULL OR ABS(v_canon) = 0
                     THEN v_spread ELSE v_spread / ABS(v_canon) END;

    IF (v_status <> 'ERROR') THEN
      -- A metric bound only once has nothing to disagree with. Saying PASS would
      -- overstate what was verified, so it is called out explicitly.
      IF (v_n < 2) THEN
        v_status := 'UNTESTED';
        v_detail := v_detail || ' | only ' || v_n || ' binding: nothing to compare against';
      ELSEIF (COALESCE(v_rel, 0) > :TOLERANCE) THEN
        v_status := 'FAIL';
      ELSE
        v_status := 'PASS';
      END IF;
    END IF;

    INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
      (run_id, run_at, metric_id, business_name, binding_count,
       canonical_value, min_value, max_value, value_spread, relative_spread, status, detail)
    SELECT :v_run_id, :v_run_at, :v_mid, :v_bname, :v_n,
           :v_canon, :v_min, :v_max, :v_spread, :v_rel, :v_status, :v_detail;
  END FOR;

  res := (
    SELECT metric_id, business_name, binding_count, canonical_value,
           value_spread, relative_spread, status, detail, run_at, run_id
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     WHERE run_id = :v_run_id
     ORDER BY status DESC, metric_id
  );
  RETURN TABLE(res);
END;
$$;

-- Zero-argument overload. lib/sc.ts and components/drift-runner.tsx both call
-- METRIC_DRIFT_TEST() with no arguments, and 04/06/07/08 do the same.
-- Tolerance 1e-6: bindings that share an expression agree exactly, so anything
-- looser would let a genuine rounding divergence pass unnoticed.
CREATE OR REPLACE PROCEDURE METRIC_DRIFT_TEST()
RETURNS TABLE()
LANGUAGE SQL
COMMENT = 'Runs METRIC_DRIFT_TEST with a relative tolerance of 1e-6.'
AS $$
DECLARE
  res RESULTSET;
BEGIN
  CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST(0.000001);
  res := (
    SELECT metric_id, business_name, binding_count, canonical_value,
           value_spread, relative_spread, status, detail, run_at, run_id
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     WHERE run_id = (SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
                      ORDER BY run_at DESC LIMIT 1)
     ORDER BY status DESC, metric_id
  );
  RETURN TABLE(res);
END;
$$;

-- ---------------------------------------------------------------------------
-- Ontology catalogue.
--
-- VIEWS OVER INFORMATION_SCHEMA, NOT TABLES. This is the whole design: the
-- catalogue rendered on /ontology is derived from the deployed semantic views, so
-- it is structurally incapable of drifting from them. A table would need to be
-- maintained alongside every view change, and the first missed update would make
-- the page describe an ontology that no longer exists.
--
-- ONTOLOGY_CLASS and ENTITY_ROLE are parsed out of the entity comment -- the
-- 'sco:' token and the exact phrase 'Conformed dimension.' respectively. That is
-- why 00e's comments are worded the way they are, and why 01 insists on the same
-- phrasing for CALENDAR.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ONTOLOGY_ENTITY
  COMMENT = 'Entities of each semantic view, derived from INFORMATION_SCHEMA so the catalogue cannot drift from the deployed definition. ONTOLOGY_CLASS and ENTITY_ROLE are parsed from the entity comment.'
AS
SELECT
  t.semantic_view_name                                             AS semantic_view,
  t.name                                                           AS entity,
  NULLIF(REGEXP_SUBSTR(t.comment, 'sco:([A-Za-z]+)', 1, 1, 'e', 1), '') AS ontology_class,
  -- 'DIMENSION', NOT 'CONFORMED_DIMENSION'. app/ontology/page.tsx:25 filters
  --   entities.filter((e) => e.entityRole === "DIMENSION")
  -- to count the conformed dimensions for its stat tile. Emitting
  -- 'CONFORMED_DIMENSION' here -- which reads better and is what the comment
  -- phrase literally says -- made that filter match nothing, so /ontology
  -- displayed "Conformed dimensions 0" while the catalogue table directly below
  -- it tagged five entities as conformed. Nothing failed; the page just quietly
  -- contradicted itself, and only a visual check caught it.
  --
  -- 01_calendar_dimension.sql assumes the same two values: its header warns that
  -- wording a comment as "conformed time dimension" classifies CALENDAR "as a
  -- bare ENTITY instead", i.e. not as the DIMENSION this expression produces.
  IFF(t.comment ILIKE '%Conformed dimension.%', 'DIMENSION', 'FACT')  AS entity_role,
  t.base_table_catalog || '.' || t.base_table_schema || '.' || t.base_table_name AS base_object,
  t.primary_keys,
  t.synonyms,
  t.comment                                                        AS description,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS d
    WHERE d.semantic_view_name = t.semantic_view_name AND d.table_name = t.name) AS dimension_count,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_METRICS mt
    WHERE mt.semantic_view_name = t.semantic_view_name AND mt.table_name = t.name) AS metric_count
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_TABLES t;

CREATE OR REPLACE VIEW ONTOLOGY_RELATIONSHIP
  COMMENT = 'Relationships of each semantic view, derived from INFORMATION_SCHEMA. The join graph as deployed, not as documented.'
AS
SELECT
  r.semantic_view_name AS semantic_view,
  r.name               AS relationship_name,
  r.table_name         AS from_entity,
  r.ref_table_name     AS to_entity,
  r.foreign_keys       AS from_columns,
  r.ref_keys           AS to_columns
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_RELATIONSHIPS r;

-- ---------------------------------------------------------------------------
-- Personas.
--
-- PERSONA_VIEW_ACCESS MUST MIRROR THE ACTUAL GRANTS IN 00e. The application reads
-- this table to decide which views to offer a persona; if it lists a view the
-- role cannot query, /ask offers a tool that fails at run time. 19 rows here, and
-- 19 GRANT statements at the end of 00e.
--
-- PERSONA_CATALOG is a view, for the same reason the ontology catalogue is: it
-- derives accessible_semantic_views and view_count from PERSONA_VIEW_ACCESS, so
-- the count on screen cannot disagree with the list beside it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE PERSONA_DEFINITION (
  role_name     STRING NOT NULL COMMENT 'Snowflake role the application assumes for this persona.',
  persona_label STRING NOT NULL COMMENT 'Display name.',
  focus         STRING NOT NULL COMMENT 'What this persona is accountable for.',
  sort_order    NUMBER NOT NULL COMMENT 'Display order.',
  row_scope     STRING NOT NULL COMMENT 'Row scope in words. MUST be the exact literal "ALL REGIONS" for an unrestricted persona: app/api/consistency/route.ts compares against that string to decide which personas are comparable. Anything else, and the metric reads as UNPROVEN.',
  CONSTRAINT pk_persona_definition PRIMARY KEY (role_name)
) COMMENT = 'The personas the application can assume. One row per Snowflake role.';

-- ROW_SCOPE IS A STRING THE APPLICATION MATCHES ON, NOT FREE TEXT.
-- app/api/consistency/route.ts:77 keeps only personas whose rowScope equals the
-- literal 'ALL REGIONS' when judging whether the personas agree, because a
-- row-scoped persona legitimately returns a different number without the
-- definition having changed.
--
-- This was first seeded as 'ALL_ROWS', which reads identically to a human and is
-- invisible to every SQL assertion. The effect was that no persona qualified as
-- comparable, so /consistency observed zero values and reported the metric
-- UNPROVEN -- on the one page whose entire purpose is to prove the numbers agree.
-- 91_verify_personas.sql now asserts the exact literal.
INSERT INTO PERSONA_DEFINITION (role_name, persona_label, focus, sort_order, row_scope)
SELECT * FROM VALUES
 ('SC_ONTOLOGY_STEWARD','Ontology Steward','Owns the semantic layer. The only persona that sees every view, the drift control and the consistency evidence.',1,'ALL REGIONS'),
 ('SC_PROCUREMENT','Procurement Analyst','Supplier delivery, fill and purchase price variance on the inbound side.',2,'ALL REGIONS'),
 ('SC_LOGISTICS','Logistics Manager','Outbound delivery performance and cost to serve, all regions.',3,'ALL REGIONS'),
 ('SC_LOGISTICS_EU','Logistics Manager, EU','The same accountability as SC_LOGISTICS, restricted to EU destinations. Same metric definitions, different rows.',4,'SHIP_REGION = EU'),
 ('SC_PLANNER','Demand & Inventory Planner','Inventory cover, stock value and demand plan accuracy.',5,'ALL REGIONS')
AS v(role_name, persona_label, focus, sort_order, row_scope);

CREATE OR REPLACE TABLE PERSONA_VIEW_ACCESS (
  role_name     STRING NOT NULL COMMENT 'Persona role.',
  semantic_view STRING NOT NULL COMMENT 'Semantic view the role may query. Must correspond to an actual GRANT in 00e.',
  CONSTRAINT pk_persona_view_access PRIMARY KEY (role_name, semantic_view)
) COMMENT = 'Which semantic views each persona may query. Mirrors the grants issued in 00e: a row here with no matching grant makes the conversational layer offer a tool that fails.';

INSERT INTO PERSONA_VIEW_ACCESS (role_name, semantic_view)
SELECT * FROM VALUES
 ('SC_ONTOLOGY_STEWARD','SC_ONTOLOGY_360'),
 ('SC_ONTOLOGY_STEWARD','SC_SUPPLIER'),
 ('SC_ONTOLOGY_STEWARD','SC_FULFILLMENT'),
 ('SC_ONTOLOGY_STEWARD','SC_INVENTORY'),
 ('SC_ONTOLOGY_STEWARD','SC_LANDED_COST'),
 ('SC_ONTOLOGY_STEWARD','SC_DEMAND'),
 ('SC_ONTOLOGY_STEWARD','SC_MANUFACTURING'),
 ('SC_PROCUREMENT','SC_ONTOLOGY_360'),
 ('SC_PROCUREMENT','SC_SUPPLIER'),
 ('SC_LOGISTICS','SC_ONTOLOGY_360'),
 ('SC_LOGISTICS','SC_FULFILLMENT'),
 ('SC_LOGISTICS','SC_LANDED_COST'),
 ('SC_LOGISTICS_EU','SC_ONTOLOGY_360'),
 ('SC_LOGISTICS_EU','SC_FULFILLMENT'),
 ('SC_LOGISTICS_EU','SC_LANDED_COST'),
 ('SC_PLANNER','SC_ONTOLOGY_360'),
 ('SC_PLANNER','SC_INVENTORY'),
 ('SC_PLANNER','SC_DEMAND'),
 ('SC_PLANNER','SC_FULFILLMENT')
AS v(role_name, semantic_view);

CREATE OR REPLACE VIEW PERSONA_CATALOG
  COMMENT = 'The persona catalogue with its accessible-view list and count derived from PERSONA_VIEW_ACCESS, so the count shown can never disagree with the list shown beside it.'
AS
SELECT
  p.role_name,
  p.persona_label,
  p.focus,
  p.sort_order,
  p.row_scope,
  (SELECT LISTAGG(a.semantic_view, ', ') WITHIN GROUP (ORDER BY a.semantic_view)
     FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS a WHERE a.role_name = p.role_name) AS accessible_semantic_views,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS a WHERE a.role_name = p.role_name) AS view_count
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_DEFINITION p;

-- ---------------------------------------------------------------------------
-- Regional row scoping.
--
-- DRIVEN BY A MAPPING TABLE, NOT BY A ROLE NAME IN THE POLICY BODY. Hardcoding
-- `CURRENT_ROLE() = 'SC_LOGISTICS_EU'` would mean every new regional persona
-- requires a policy change, and a policy change is a privileged operation that
-- silently affects every attached table. With the mapping table, adding an APAC
-- persona is an INSERT that is reviewable like any other governance row.
--
-- The three-branch logic matters:
--   scoped role, region matches   -> visible
--   scoped role, region does not  -> hidden
--   role not scoped at all        -> everything visible
-- Collapsing the last two would hide every row from every unscoped role, which
-- looks exactly like a broken warehouse rather than a policy mistake.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE PERSONA_REGION_SCOPE (
  role_name    STRING NOT NULL COMMENT 'Role to restrict.',
  region_value STRING NOT NULL COMMENT 'Region value the role may see. A role absent from this table sees all regions.',
  CONSTRAINT pk_persona_region_scope PRIMARY KEY (role_name, region_value)
) COMMENT = 'Row-scope mapping consumed by RAP_SHIP_REGION. Adding a regional persona is an INSERT here, not a policy edit.';

INSERT INTO PERSONA_REGION_SCOPE (role_name, region_value)
SELECT * FROM VALUES ('SC_LOGISTICS_EU','EU') AS v(role_name, region_value);

-- DETACH BEFORE REPLACING. Snowflake refuses to replace a row access policy that
-- is still attached to anything: "Policy RAP_SHIP_REGION cannot be dropped/
-- replaced as it is associated with one or more entities."
--
-- So the order is detach, replace, re-attach. An earlier version of this file put
-- the CREATE OR REPLACE first and the detach afterwards, which worked on a fresh
-- account and failed on every subsequent run -- the worst shape of bug for a
-- script whose whole purpose is to be re-runnable.
--
-- DROP ALL rather than DROP <name> so this is safe whether a policy is attached or
-- not, and regardless of which one. A table may carry only one row access policy,
-- so there is nothing else to preserve.
ALTER TABLE SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT DROP ALL ROW ACCESS POLICIES;
ALTER TABLE SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT   DROP ALL ROW ACCESS POLICIES;

CREATE OR REPLACE ROW ACCESS POLICY RAP_SHIP_REGION
  AS (ship_region STRING) RETURNS BOOLEAN ->
    CASE
      WHEN EXISTS (
        SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE s
         WHERE s.role_name = CURRENT_ROLE() AND s.region_value = ship_region
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE s
         WHERE s.role_name = CURRENT_ROLE()
      ) THEN FALSE
      ELSE TRUE
    END
  COMMENT = 'Restricts outbound rows by destination region for roles listed in PERSONA_REGION_SCOPE. Roles not listed are unrestricted.';

ALTER TABLE SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
  ADD ROW ACCESS POLICY RAP_SHIP_REGION ON (SHIP_REGION);
ALTER TABLE SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT
  ADD ROW ACCESS POLICY RAP_SHIP_REGION ON (SHIP_REGION);

-- ---------------------------------------------------------------------------
-- Agent feedback loop.
--
-- AGENT_QUESTION_LOG is created here rather than in 07 because
-- AGENT_IMPROVEMENT_CANDIDATE reads it and 00f runs first. 07 creates it with
-- CREATE TABLE IF NOT EXISTS, so it is a no-op there once this has run.
--
-- The ranking puts an UNSTABLE_RESOLUTION first: the same question answered two
-- different ways is the exact failure this project exists to prevent, showing up
-- in the conversational layer. A refusal is second -- it is a worse experience but
-- an honest one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE AGENT_QUESTION_LOG (
  asked_at            TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  source              STRING  COMMENT 'Which surface asked: app, agent, evaluation harness.',
  persona_role        STRING  COMMENT 'Role in effect.',
  question            STRING  COMMENT 'Question as asked.',
  resolved_metric_ids STRING  COMMENT 'Pipe-delimited metric ids resolved to.',
  semantic_view       STRING  COMMENT 'View chosen.',
  refused             BOOLEAN COMMENT 'TRUE when the question was declined.',
  refusal_reason      STRING  COMMENT 'Why it was declined.',
  latency_ms          NUMBER  COMMENT 'End-to-end latency.',
  user_corrected      BOOLEAN COMMENT 'TRUE when the user corrected the answer.',
  correction_note     STRING  COMMENT 'What the user said was wrong.'
) COMMENT = 'Every question asked of the conversational layer. Real questions are a better source of the next synonym or verified query than imagined ones.';

CREATE OR REPLACE VIEW AGENT_IMPROVEMENT_CANDIDATE
  COMMENT = 'Questions ranked by how much they need attention. An unstable resolution ranks above a refusal: being answered two different ways is worse than not being answered.'
AS
WITH agg AS (
  SELECT
    question,
    COUNT(*)                                           AS times_asked,
    COUNT(DISTINCT COALESCE(resolved_metric_ids, ''))   AS distinct_resolutions,
    COUNT_IF(refused)                                   AS refusals,
    COUNT_IF(user_corrected)                            AS corrections,
    MAX(asked_at)                                       AS last_asked
  FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_QUESTION_LOG
  GROUP BY question
)
SELECT
  question, times_asked, distinct_resolutions, refusals, corrections, last_asked,
  CASE
    WHEN distinct_resolutions > 1 THEN 'UNSTABLE_RESOLUTION'
    WHEN refusals > 0            THEN 'REFUSED'
    WHEN corrections > 0         THEN 'USER_CORRECTED'
    ELSE 'OK'
  END AS candidate_reason,
  CASE
    WHEN distinct_resolutions > 1 THEN 1
    WHEN refusals > 0            THEN 2
    WHEN corrections > 0         THEN 3
    ELSE 4
  END AS priority
FROM agg;

-- ---------------------------------------------------------------------------
-- Seed the evidence tables from the live views.
--
-- COMPUTED, NOT TYPED IN. Both tables are populated by querying the correct and
-- the deliberately-defective views right now, rather than by inserting literals
-- recorded from some earlier run. Hardcoded evidence is evidence that can quietly
-- become false: if the data is regenerated with different distributions, a typed
-- "observed_value" would still be displayed on /consistency as though it had been
-- measured. Deriving it means the numbers shown are always the numbers this
-- account actually produces.
--
-- The divergence being recorded is real and reproducible: SC_SUPPLIER computes
-- supplier OTD across receipt lines, SC_SUPPLIER_LEGACY_DEFECT averages
-- per-supplier-per-month rates, and the two disagree by roughly 0.7 percentage
-- points on identical underlying data.
-- ---------------------------------------------------------------------------

TRUNCATE TABLE METRIC_DRIFT_BASELINE;

INSERT INTO METRIC_DRIFT_BASELINE
  (metric_id, semantic_view, metric_reference, observed_value, definition_sql, root_cause, captured_at, note)
SELECT
  'supplier_otd_pct', 'SC_SUPPLIER', 'supplier_delivery.supplier_otd_pct',
  (SELECT supplier_otd_pct FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER METRICS supplier_delivery.supplier_otd_pct)),
  'AVG(is_on_time) over CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',
  'Correct definition: averages the on-time flag across receipt lines, so every line carries equal weight.',
  CURRENT_TIMESTAMP(),
  'This is the governed definition. Retained as the reference side of the comparison.'
UNION ALL
SELECT
  'supplier_otd_pct', 'SC_SUPPLIER_LEGACY_DEFECT', 'supplier.supplier_otd_pct',
  (SELECT supplier_otd_pct FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT METRICS supplier.supplier_otd_pct)),
  'AVG(otd_rate) over CANONICAL.V_SUPPLIER_OTD_BY_MONTH, where otd_rate is already AVG(is_on_time) per supplier per month',
  'Average of averages: the monthly rate is averaged again without weighting by receipt lines, so a supplier with 3 lines in a month counts as much as one with 900.',
  CURRENT_TIMESTAMP(),
  'Kept deployed on purpose as a negative control. Never fix it: it is the only proof the drift test can fail.';

TRUNCATE TABLE METRIC_DRIFT_NEGATIVE_CONTROL;

INSERT INTO METRIC_DRIFT_NEGATIVE_CONTROL
  (run_at, metric_id, business_name, canonical_value, min_value, max_value,
   value_spread, status, detail, purpose)
WITH v AS (
  SELECT
    (SELECT SUM(is_on_time) / COUNT(*) FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE) AS canon,
    (SELECT supplier_otd_pct FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER METRICS supplier_delivery.supplier_otd_pct)) AS correct_v,
    (SELECT supplier_otd_pct FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT METRICS supplier.supplier_otd_pct)) AS defect_v
)
SELECT
  CURRENT_TIMESTAMP(),
  'supplier_otd_pct',
  'Supplier On-Time Delivery',
  canon,
  LEAST(correct_v, defect_v),
  GREATEST(correct_v, defect_v),
  ABS(defect_v - correct_v),
  'FAIL',
  'SC_SUPPLIER.supplier_otd_pct=' || TO_VARCHAR(correct_v)
    || ' | SC_SUPPLIER_LEGACY_DEFECT.supplier.supplier_otd_pct=' || TO_VARCHAR(defect_v)
    || ' | canonical=' || TO_VARCHAR(canon),
  'Proves METRIC_DRIFT_TEST is capable of failing. Both views claim to report supplier on-time delivery over the same receipt lines; one weights by line and one averages monthly rates. A control that has only ever passed cannot be distinguished from a control that is not running.'
FROM v;

-- ---------------------------------------------------------------------------
-- Read access. SELECT only: no persona may write to this schema.
--
-- This is the trust boundary 05_exception_rules.sql depends on.
-- METRIC_EXCEPTION_RULE.exception_where and .order_by are interpolated into SQL
-- by app/api/drilldown/route.ts without escaping, which is safe only while this
-- schema is admin-owned configuration. Granting INSERT or UPDATE on GOVERNANCE to
-- an application role turns that interpolation into SQL injection.
-- ---------------------------------------------------------------------------

GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_PLANNER;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_PROCUREMENT;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_LOGISTICS;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_ONTOLOGY_STEWARD;

GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_PLANNER;
GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_PROCUREMENT;
GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_LOGISTICS;
GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_ONTOLOGY_STEWARD;

-- The steward triggers the drift control from /consistency.
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST() TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST(FLOAT) TO ROLE SC_ONTOLOGY_STEWARD;
