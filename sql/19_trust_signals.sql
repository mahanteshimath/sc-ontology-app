-- ---------------------------------------------------------------------------
-- 19 - Trust signals: certification, data quality, and one badge per answer.
--
-- Consistency proves that every team gets the same number. It does not prove
-- the number is built on data anyone should trust. This file adds the two
-- signals a consumer actually looks for, and folds them into one row per
-- semantic view that the conversational layer shows beside every answer:
--
--   CERTIFIED   SNOWFLAKE.CORE.CERTIFICATION_STATUS on each governed semantic
--               view and canonical fact - the platform's own trusted-source tag,
--               so the same signal appears in Snowsight search and the catalog.
--   CHECKED     Data Metric Functions on every canonical fact (nulls in keys and
--               measures, duplicate keys), each with an expectation of zero.
--   DRIFT-FREE  the latest METRIC_DRIFT_TEST result for the view's bindings.
--
-- THE NEGATIVE CONTROL IS NEVER CERTIFIED. SC_SUPPLIER_LEGACY_DEFECT is the
-- knowingly wrong view kept deployed so the drift test can fail. Certifying it
-- would put a trusted-source badge on the one number we know to be wrong, so
-- the tag is explicitly removed and the build asserts it stays removed.
--
-- WHY THE CHECKS ARE LISTED IN A TABLE. DQ_CHECK drives both halves: the
-- native DMF associations (scheduled daily, visible in Horizon and in
-- SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_*), and RUN_DQ_CHECKS, which
-- evaluates the same checks on demand so the badge has a value from the first
-- minute rather than after the first scheduled tick. One list, two consumers,
-- no chance of them disagreeing about what is checked.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. Certification.
-- ---------------------------------------------------------------------------
ALTER SEMANTIC VIEW SEMANTIC.SC_ONTOLOGY_360  SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_SUPPLIER      SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_FULFILLMENT   SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_INVENTORY     SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_LANDED_COST   SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_DEMAND        SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_MANUFACTURING SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_OUTLOOK       SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_TELEMETRY     SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_CONTRACT      SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER SEMANTIC VIEW SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT UNSET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS;

ALTER TABLE CANONICAL.FCT_SUPPLIER_DELIVERY_LINE SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER TABLE CANONICAL.FCT_ORDER_LINE_FULFILLMENT SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER TABLE CANONICAL.FCT_INVENTORY_SNAPSHOT     SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER TABLE CANONICAL.FCT_LANDED_COST_SHIPMENT   SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER TABLE CANONICAL.FCT_SHIPMENT_TELEMETRY     SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';
ALTER TABLE CANONICAL.DIM_SUPPLIER_CONTRACT      SET TAG SNOWFLAKE.CORE.CERTIFICATION_STATUS = 'CERTIFIED';

-- ---------------------------------------------------------------------------
-- 2. The checks. Nulls where a null would silently drop a row from a ratio;
--    duplicates where a duplicate key would double-count it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE GOVERNANCE.DQ_CHECK (
  check_id     STRING NOT NULL,
  fact_table   STRING NOT NULL COMMENT 'Unqualified table name in CANONICAL.',
  column_name  STRING NOT NULL,
  dmf          STRING NOT NULL COMMENT 'NULL_COUNT or DUPLICATE_COUNT (SNOWFLAKE.CORE).',
  why          STRING NOT NULL,
  CONSTRAINT pk_dq_check PRIMARY KEY (check_id)
) COMMENT = 'The data quality checks on every canonical fact. Drives both the native DMF associations and RUN_DQ_CHECKS; expectation is always VALUE = 0.';

INSERT INTO GOVERNANCE.DQ_CHECK
SELECT * FROM VALUES
 ('sup_supplier_nn',  'FCT_SUPPLIER_DELIVERY_LINE', 'SUPPLIER_ID',      'NULL_COUNT',      'A receipt with no supplier cannot be attributed and silently leaves supplier OTD.'),
 ('sup_on_time_nn',   'FCT_SUPPLIER_DELIVERY_LINE', 'IS_ON_TIME',       'NULL_COUNT',      'AVG ignores NULL, so a null flag shrinks the denominator of supplier OTD.'),
 ('sup_receipt_nn',   'FCT_SUPPLIER_DELIVERY_LINE', 'RECEIPT_DATE',     'NULL_COUNT',      'Undated receipts escape both the reporting period and the as-of rule.'),
 ('ful_order_nn',     'FCT_ORDER_LINE_FULFILLMENT', 'ORDER_ID',         'NULL_COUNT',      'Order lines without an order cannot be drilled to or reconciled.'),
 ('ful_on_time_nn',   'FCT_ORDER_LINE_FULFILLMENT', 'IS_ON_TIME',       'NULL_COUNT',      'Same denominator risk as supplier OTD, on the customer side.'),
 ('ful_customer_nn',  'FCT_ORDER_LINE_FULFILLMENT', 'CUSTOMER_ID',      'NULL_COUNT',      'Unattributed lines drop out of every customer-grain breakdown.'),
 ('ful_ship_region_nn','FCT_ORDER_LINE_FULFILLMENT','SHIP_REGION',      'NULL_COUNT',      'The row access policy keys on SHIP_REGION; a null region is invisible to every scoped persona.'),
 ('inv_on_hand_nn',   'FCT_INVENTORY_SNAPSHOT',     'ON_HAND_QTY',      'NULL_COUNT',      'Days of inventory is SUM(on hand) / SUM(demand); a null numerator understates cover.'),
 ('inv_demand_nn',    'FCT_INVENTORY_SNAPSHOT',     'AVG_DAILY_DEMAND', 'NULL_COUNT',      'A null denominator row overstates days of inventory.'),
 ('lc_shipment_uq',   'FCT_LANDED_COST_SHIPMENT',   'SHIPMENT_ID',      'DUPLICATE_COUNT', 'A duplicated shipment double-counts its landed cost.'),
 ('lc_total_nn',      'FCT_LANDED_COST_SHIPMENT',   'TOTAL_LANDED_COST','NULL_COUNT',      'Null cost rows understate total landed cost and distort cost per unit.'),
 ('tel_shipment_uq',  'FCT_SHIPMENT_TELEMETRY',     'SHIPMENT_ID',      'DUPLICATE_COUNT', 'One telemetry summary per shipment; a duplicate double-counts an excursion.'),
 ('tel_peak_nn',      'FCT_SHIPMENT_TELEMETRY',     'PEAK_TEMP_C',      'NULL_COUNT',      'A shipment with no reading cannot be classified as an excursion or not.'),
 ('ctr_supplier_uq',  'DIM_SUPPLIER_CONTRACT',      'SUPPLIER_ID',      'DUPLICATE_COUNT', 'One governing agreement per supplier; two would make the verdict ambiguous.'),
 ('ctr_commit_nn',    'DIM_SUPPLIER_CONTRACT',      'OTD_COMMITMENT',   'NULL_COUNT',      'A contract with no extracted commitment cannot be scored - it must be in NEEDS_REVIEW instead.');

-- ---------------------------------------------------------------------------
-- 3. Native DMF associations - scheduled, visible to Horizon, one expectation
--    each. Idempotent: an association that already exists is skipped.
--    Identifiers come from DQ_CHECK, a table this file owns, and are validated
--    against INFORMATION_SCHEMA before use, so nothing user-supplied is
--    concatenated into DDL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE GOVERNANCE.ATTACH_DQ_MONITORS()
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Attaches every DQ_CHECK as a native DMF with a VALUE = 0 expectation, scheduled daily before the drift test. Skips associations that already exist.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  attached NUMBER DEFAULT 0;
  skipped NUMBER DEFAULT 0;
  c CURSOR FOR
    SELECT k.check_id, k.fact_table, k.column_name, k.dmf
      FROM GOVERNANCE.DQ_CHECK k
      JOIN SUPPLY_CHAIN.INFORMATION_SCHEMA.COLUMNS col
        ON col.table_schema = 'CANONICAL' AND col.table_name = k.fact_table AND col.column_name = k.column_name
     WHERE k.dmf IN ('NULL_COUNT', 'DUPLICATE_COUNT');
  facts CURSOR FOR SELECT DISTINCT fact_table FROM GOVERNANCE.DQ_CHECK;
  tbl STRING;
BEGIN
  FOR t IN facts DO
    tbl := 'SUPPLY_CHAIN.CANONICAL.' || t.fact_table;
    -- 05:30 UTC daily: finishes before METRIC_DRIFT_TEST at 06:00, so a bad load is
    -- flagged as a data problem before it can surface as a definition problem.
    EXECUTE IMMEDIATE 'ALTER TABLE ' || tbl || ' SET DATA_METRIC_SCHEDULE = ''USING CRON 30 5 * * * UTC''';
  END FOR;
  FOR r IN c DO
    BEGIN
      EXECUTE IMMEDIATE 'ALTER TABLE SUPPLY_CHAIN.CANONICAL.' || r.fact_table
        || ' ADD DATA METRIC FUNCTION SNOWFLAKE.CORE.' || r.dmf || ' ON (' || r.column_name || ')'
        || ' EXPECTATION ' || r.check_id || ' (VALUE = 0)';
      attached := attached + 1;
    EXCEPTION
      WHEN OTHER THEN skipped := skipped + 1;
    END;
  END FOR;
  RETURN OBJECT_CONSTRUCT('attached', attached, 'already_present_or_skipped', skipped);
END;
$$;

CALL GOVERNANCE.ATTACH_DQ_MONITORS();

-- ---------------------------------------------------------------------------
-- 4. On-demand evaluation, recorded. The badge reads the latest run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS GOVERNANCE.DQ_CHECK_RESULT (
  run_id     STRING NOT NULL,
  run_at     TIMESTAMP_LTZ NOT NULL,
  check_id   STRING NOT NULL,
  fact_table STRING NOT NULL,
  value      NUMBER,
  passed     BOOLEAN NOT NULL
) COMMENT = 'Recorded evaluations of DQ_CHECK. The same checks the native DMFs run, evaluated on demand so the trust badge never waits for a scheduled tick.';

CREATE TABLE IF NOT EXISTS GOVERNANCE.CERTIFICATION_SNAPSHOT (
  run_id        STRING NOT NULL,
  run_at        TIMESTAMP_LTZ NOT NULL,
  semantic_view STRING NOT NULL,
  certification STRING
) COMMENT = 'SNOWFLAKE.CORE.CERTIFICATION_STATUS per semantic view, captured by RUN_DQ_CHECKS (GET_TAG needs constant arguments, so it cannot run per row in a view).';

CREATE OR REPLACE PROCEDURE GOVERNANCE.RUN_DQ_CHECKS()
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Evaluates every DQ_CHECK now with the SNOWFLAKE.CORE system DMFs and records the result in DQ_CHECK_RESULT.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  rid STRING DEFAULT UUID_STRING();
  started TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP();
  v NUMBER;
  failed NUMBER DEFAULT 0;
  total NUMBER DEFAULT 0;
  c CURSOR FOR
    SELECT k.check_id, k.fact_table, k.column_name, k.dmf
      FROM GOVERNANCE.DQ_CHECK k
      JOIN SUPPLY_CHAIN.INFORMATION_SCHEMA.COLUMNS col
        ON col.table_schema = 'CANONICAL' AND col.table_name = k.fact_table AND col.column_name = k.column_name
     WHERE k.dmf IN ('NULL_COUNT', 'DUPLICATE_COUNT');
  rs RESULTSET;
  cid STRING;
  ftab STRING;
  svname STRING;
  tagval STRING;
  views CURSOR FOR SELECT name FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_VIEWS WHERE schema = 'SEMANTIC';
BEGIN
  FOR r IN c DO
    -- Cursor-record fields cannot be bound as :r.field, so copy them first.
    cid := r.check_id;
    ftab := r.fact_table;
    rs := (EXECUTE IMMEDIATE 'SELECT SNOWFLAKE.CORE.' || r.dmf || '(SELECT ' || r.column_name
           || ' FROM SUPPLY_CHAIN.CANONICAL.' || r.fact_table || ') AS V');
    LET cur CURSOR FOR rs;
    FOR row_v IN cur DO
      v := row_v.V;
    END FOR;
    INSERT INTO GOVERNANCE.DQ_CHECK_RESULT (run_id, run_at, check_id, fact_table, value, passed)
      VALUES (:rid, :started, :cid, :ftab, :v, :v = 0);
    total := total + 1;
    IF (v <> 0) THEN failed := failed + 1; END IF;
  END FOR;

  -- Certification, snapshotted in the same run. SYSTEM$GET_TAG only accepts constant
  -- arguments, so it cannot be evaluated per row inside V_TRUST_SIGNALS; one literal call
  -- per semantic view, recorded here, is the reliable read. Names come from
  -- INFORMATION_SCHEMA and are validated as plain identifiers before being inlined.
  FOR sv IN views DO
    svname := sv.name;
    IF (REGEXP_LIKE(svname, '^[A-Z_][A-Z0-9_$]*$')) THEN
      rs := (EXECUTE IMMEDIATE 'SELECT SYSTEM$GET_TAG(''SNOWFLAKE.CORE.CERTIFICATION_STATUS'', ''SUPPLY_CHAIN.SEMANTIC.'
             || svname || ''', ''SEMANTIC VIEW'') AS T');
      LET cur2 CURSOR FOR rs;
      tagval := NULL;
      FOR row_t IN cur2 DO
        tagval := row_t.T;
      END FOR;
      INSERT INTO GOVERNANCE.CERTIFICATION_SNAPSHOT (run_id, run_at, semantic_view, certification)
        VALUES (:rid, :started, :svname, :tagval);
    END IF;
  END FOR;
  RETURN OBJECT_CONSTRUCT('run_id', rid, 'checks', total, 'failed', failed);
END;
$$;

CALL GOVERNANCE.RUN_DQ_CHECKS();

-- Daily, alongside the native schedule, so the badge's evidence is never stale.
CREATE OR REPLACE TASK GOVERNANCE.DQ_CHECK_DAILY
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 35 5 * * * UTC'
  COMMENT = 'Records RUN_DQ_CHECKS daily, just before the 06:00 drift test.'
AS
  CALL GOVERNANCE.RUN_DQ_CHECKS();
ALTER TASK GOVERNANCE.DQ_CHECK_DAILY RESUME;

-- ---------------------------------------------------------------------------
-- 5. One trust row per semantic view.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW GOVERNANCE.V_TRUST_SIGNALS
  COMMENT = 'Per semantic view: certification tag, data quality checks on the facts it reads, and the latest drift status of its metric bindings. The badge beside every conversational answer.'
AS
WITH latest_dq AS (
  SELECT * FROM GOVERNANCE.DQ_CHECK_RESULT
   WHERE run_id = (SELECT run_id FROM GOVERNANCE.DQ_CHECK_RESULT ORDER BY run_at DESC LIMIT 1)
),
latest_cert AS (
  SELECT semantic_view, certification FROM GOVERNANCE.CERTIFICATION_SNAPSHOT
   WHERE run_id = (SELECT run_id FROM GOVERNANCE.CERTIFICATION_SNAPSHOT ORDER BY run_at DESC LIMIT 1)
),
view_facts AS (
  SELECT DISTINCT semantic_view_name AS semantic_view, base_table_name AS fact_table
    FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_TABLES
   WHERE base_table_schema IN ('CANONICAL', 'GOVERNANCE')
),
dq AS (
  SELECT vf.semantic_view, COUNT(d.check_id) AS checks, COUNT_IF(d.passed) AS passed, MAX(d.run_at) AS checked_at
    FROM view_facts vf
    LEFT JOIN latest_dq d
      ON d.fact_table = vf.fact_table
      -- SC_CONTRACT reads the compliance view, which is built on DIM_SUPPLIER_CONTRACT.
      OR (vf.fact_table = 'V_SUPPLIER_CONTRACT_COMPLIANCE' AND d.fact_table = 'DIM_SUPPLIER_CONTRACT')
   GROUP BY vf.semantic_view
),
drift AS (
  SELECT b.semantic_view,
         COUNT(*) AS bindings,
         COUNT_IF(l.status = 'PASS') AS bindings_pass,
         MAX(l.run_at) AS drift_at
    FROM GOVERNANCE.METRIC_BINDING b
    LEFT JOIN (
      SELECT metric_id, status, run_at,
             ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY run_at DESC) AS rn
        FROM GOVERNANCE.METRIC_DRIFT_RESULT
    ) l ON l.metric_id = b.metric_id AND l.rn = 1
   GROUP BY b.semantic_view
)
SELECT
  v.name                                                                              AS semantic_view,
  cert.certification,
  COALESCE(dq.checks, 0)                                                              AS dq_checks,
  COALESCE(dq.passed, 0)                                                              AS dq_passed,
  dq.checked_at,
  COALESCE(drift.bindings, 0)                                                         AS metric_bindings,
  COALESCE(drift.bindings_pass, 0)                                                    AS bindings_drift_pass,
  drift.drift_at,
  -- Three states, not a boolean: "no checks exist" is different from "checks failed",
  -- and a badge that folded them together would under-report the gap it is meant to show.
  CASE
    WHEN COALESCE(cert.certification, '') <> 'CERTIFIED'                      THEN 'NOT_CERTIFIED'
    WHEN COALESCE(dq.checks, 0) = 0                                          THEN 'CERTIFIED_UNCHECKED'
    WHEN dq.passed < dq.checks                                               THEN 'DQ_FAILING'
    WHEN COALESCE(drift.bindings, 0) > 0 AND drift.bindings_pass < drift.bindings THEN 'DRIFTING'
    ELSE 'TRUSTED'
  END                                                                                 AS trust_level
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_VIEWS v
LEFT JOIN latest_cert cert ON cert.semantic_view = v.name
LEFT JOIN dq    ON dq.semantic_view = v.name
LEFT JOIN drift ON drift.semantic_view = v.name
WHERE v.schema = 'SEMANTIC';

GRANT SELECT ON VIEW  GOVERNANCE.V_TRUST_SIGNALS TO ROLE SC_PLANNER;
GRANT SELECT ON VIEW  GOVERNANCE.V_TRUST_SIGNALS TO ROLE SC_PROCUREMENT;
GRANT SELECT ON VIEW  GOVERNANCE.V_TRUST_SIGNALS TO ROLE SC_LOGISTICS;
GRANT SELECT ON VIEW  GOVERNANCE.V_TRUST_SIGNALS TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON VIEW  GOVERNANCE.V_TRUST_SIGNALS TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON TABLE GOVERNANCE.DQ_CHECK        TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON TABLE GOVERNANCE.DQ_CHECK_RESULT TO ROLE SC_ONTOLOGY_STEWARD;

-- Assertions.
SELECT 'negative control is not certified' AS check_name, certification AS found,
       IFF(certification IS NULL OR certification <> 'CERTIFIED', 'PASS', 'FAIL') AS status
  FROM GOVERNANCE.V_TRUST_SIGNALS WHERE semantic_view = 'SC_SUPPLIER_LEGACY_DEFECT';

SELECT semantic_view, certification, dq_passed || '/' || dq_checks AS dq, bindings_drift_pass || '/' || metric_bindings AS drift, trust_level
  FROM GOVERNANCE.V_TRUST_SIGNALS ORDER BY semantic_view;
