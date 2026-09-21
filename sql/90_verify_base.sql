-- ---------------------------------------------------------------------------
-- 90 — Base-layer verification. THE GATE.
--
-- Run after 00a-00f and after 01-08. Every query below returns a VERDICT column
-- that reads PASS or FAIL. Nothing here mutates anything.
--
-- WHY THE ANCHOR ASSERTIONS COME FIRST. 01_calendar_dimension.sql and
-- 07_verified_queries.sql both extend a deployed semantic view by REPLACE-ing a
-- substring of its GET_DDL output. A REPLACE on a string that does not occur is a
-- SILENT NO-OP: the statement succeeds, the view is rewritten without the
-- addition, and nothing fails until some later page queries a dimension that was
-- never added. Asserting the occurrence count is the only way to distinguish
-- "the splice worked" from "the splice did nothing".
--
-- Each anchor must occur exactly once. More than once and REPLACE would insert
-- the same block several times; zero and it inserts nothing.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. Splice anchors in SC_ONTOLOGY_360.
--
-- Note the PART anchor carries no `PART as` alias. GET_DDL omits an alias that is
-- identical to the base table name, so the deployed text really is
-- `SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)`. Confirmed against this
-- account, not assumed.
-- ---------------------------------------------------------------------------

WITH d AS (SELECT GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360') AS ddl),
a AS (
  SELECT 'anchor: PART logical table'  AS check_name, REGEXP_COUNT(ddl, 'SUPPLY_CHAIN\\.RAW\\.PART primary key \\(MATERIAL_ID\\)') AS n FROM d
  UNION ALL SELECT 'anchor: PO_TO_PART relationship', REGEXP_COUNT(ddl, 'PO_TO_PART as PURCHASE_ORDER\\(MATERIAL_ID\\)') FROM d
  UNION ALL SELECT 'anchor: PART.MATERIAL dimension', REGEXP_COUNT(ddl, 'PART\\.MATERIAL as part\\.material_id') FROM d
)
SELECT check_name, n AS occurrences, 1 AS expected,
       IFF(n = 1, 'PASS', 'FAIL') AS verdict
FROM a ORDER BY check_name;

-- ---------------------------------------------------------------------------
-- 2. The CALENDAR dimension survived. Run this AFTER 01.
--
-- Guards the single most damaging ordering mistake in this directory: re-running
-- 00e after 01 reverts SC_ONTOLOGY_360 to 10 entities and removes CALENDAR, which
-- lib/period.ts needs for every reporting period. See sql/00_README.md.
-- ---------------------------------------------------------------------------

SELECT
  'SC_ONTOLOGY_360 has CALENDAR entity'                            AS check_name,
  COUNT(*)                                                         AS found,
  1                                                                AS expected,
  IFF(COUNT(*) = 1, 'PASS', 'FAIL - run 00e then 01, in that order') AS verdict
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_TABLES
WHERE semantic_view_name = 'SC_ONTOLOGY_360' AND name = 'CALENDAR';

SELECT
  'CALENDAR classified as a conformed dimension'                    AS check_name,
  MAX(entity_role)                                                 AS found,
  'DIMENSION'                                                      AS expected,
  IFF(MAX(entity_role) = 'DIMENSION', 'PASS',
      'FAIL - the entity comment must contain the exact phrase "Conformed dimension."') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_ENTITY
WHERE semantic_view = 'SC_ONTOLOGY_360' AND entity = 'CALENDAR';

-- The count the /ontology stat tile renders. Asserted because the tile reading
-- zero against a populated catalogue is a silent self-contradiction, not an
-- error: five conformed dimensions (CALENDAR, PART, SUPPLIER, CUSTOMER, NODE)
-- and six facts.
SELECT
  'SC_ONTOLOGY_360 entity role split'                              AS check_name,
  COUNT_IF(entity_role = 'DIMENSION')                              AS dimensions,
  COUNT_IF(entity_role = 'FACT')                                   AS facts,
  IFF(COUNT_IF(entity_role = 'DIMENSION') = 5
      AND COUNT_IF(entity_role = 'FACT') = 6, 'PASS',
      'FAIL - /ontology will misreport its own entity counts') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_ENTITY
WHERE semantic_view = 'SC_ONTOLOGY_360';

-- The calendar dimensions lib/period.ts filters on must exist by these names.
WITH need AS (
  SELECT * FROM VALUES ('CAL_DATE'),('CAL_MONTH'),('CAL_PERIOD'),('CAL_QUARTER'),('CAL_YEAR'),('IS_FUTURE'),('IS_WEEKDAY') AS v(name)
)
SELECT
  'CALENDAR dimension ' || need.name AS check_name,
  IFF(d.name IS NULL, 'missing', 'present') AS found,
  'present' AS expected,
  IFF(d.name IS NULL, 'FAIL', 'PASS') AS verdict
FROM need
LEFT JOIN SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS d
       ON d.semantic_view_name = 'SC_ONTOLOGY_360'
      AND d.table_name = 'CALENDAR'
      AND d.name = need.name
ORDER BY check_name;

-- ---------------------------------------------------------------------------
-- 3. Registry shape. Run AFTER 02 and 03.
--
-- 02 adds six columns to METRIC_DEFINITION and populates two of them; 03
-- populates the rest. If 00f had declared those columns itself, 02's
-- ADD COLUMN IF NOT EXISTS would no-op and the UPDATEs would be the only thing
-- doing real work -- so these checks are what prove 02 and 03 actually ran.
-- ---------------------------------------------------------------------------

SELECT 'metric count' AS check_name, COUNT(*) AS found, 14 AS expected,
       IFF(COUNT(*) = 14, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION;

SELECT 'every metric has an as_of_scope (02 ran)' AS check_name,
       COUNT_IF(as_of_scope IS NULL) AS found, 0 AS expected,
       IFF(COUNT_IF(as_of_scope IS NULL) = 0, 'PASS', 'FAIL - 02_as_of_rule.sql has not run') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION;

SELECT 'inventory metrics scoped SNAPSHOT' AS check_name,
       COUNT_IF(as_of_scope = 'SNAPSHOT') AS found, 2 AS expected,
       IFF(COUNT_IF(as_of_scope = 'SNAPSHOT') = 2, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
WHERE grain = 'material_node_snapshot';

-- Eight metrics carry a target; the six absolute-dollar metrics deliberately do
-- not, because a fixed dollar threshold would report higher volume as a failure.
SELECT 'metrics with a target (03 ran)' AS check_name,
       COUNT_IF(target_value IS NOT NULL) AS found, 8 AS expected,
       IFF(COUNT_IF(target_value IS NOT NULL) = 8, 'PASS', 'FAIL - 03_targets.sql has not run') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION;

SELECT 'every target is labelled ILLUSTRATIVE or NO TARGET' AS check_name,
       COUNT_IF(target_source IS NULL) AS found, 0 AS expected,
       IFF(COUNT_IF(target_source IS NULL) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION;

-- ---------------------------------------------------------------------------
-- 4. Referential integrity between the registry and the exception rules.
--
-- app/api/drilldown/route.ts refuses a drill-down when
-- METRIC_EXCEPTION_RULE.canonical_fact disagrees with
-- METRIC_DEFINITION.canonical_fact, because rows from a different fact would not
-- add up to the number being explained. A mismatch here is a silent dead end in
-- the UI, so it is asserted rather than discovered by clicking.
-- ---------------------------------------------------------------------------

SELECT 'exception rules pointing at an unknown metric' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE r
WHERE NOT EXISTS (SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d WHERE d.metric_id = r.metric_id);

SELECT 'exception rule fact disagrees with registry fact' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL - the drill-down will refuse these metrics') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE r
JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d ON d.metric_id = r.metric_id
WHERE r.canonical_fact <> d.canonical_fact;

-- Every column an exception rule displays, orders by or dates on must really
-- exist on the fact. The route validates this at request time; asserting it here
-- turns a broken drill-down into a build failure instead of a user-facing one.
WITH cols AS (
  SELECT r.metric_id, r.canonical_fact,
         TRIM(c.value) AS col_name
  FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE r,
       LATERAL SPLIT_TO_TABLE(r.display_columns || ',' || r.date_column, ',') c
)
SELECT 'exception display/date columns missing from the fact' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM cols
WHERE NOT EXISTS (
  SELECT 1 FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.COLUMNS ic
   WHERE ic.table_schema = SPLIT_PART(cols.canonical_fact, '.', 1)
     AND ic.table_name   = SPLIT_PART(cols.canonical_fact, '.', 2)
     AND ic.column_name  = UPPER(cols.col_name)
);

-- ---------------------------------------------------------------------------
-- 5. Bindings resolve to real semantic-view metrics.
--
-- A binding naming a metric the view does not expose fails only when the drift
-- test reaches it, which is a slow way to find a typo.
-- ---------------------------------------------------------------------------

SELECT 'bindings whose metric does not exist in the view' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING b
WHERE NOT EXISTS (
  SELECT 1 FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_METRICS m
   WHERE m.semantic_view_name = b.semantic_view
     AND m.table_name = UPPER(SPLIT_PART(b.metric_reference, '.', 1))
     AND m.name       = UPPER(SPLIT_PART(b.metric_reference, '.', 2))
);

-- A metric with a single binding has nothing to be compared against, so it can
-- never fail drift. It would show as verified while being untested.
SELECT 'metrics with fewer than 2 bindings' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL - these metrics are untestable for drift') AS verdict
FROM (
  SELECT metric_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
   WHERE COALESCE(persona_role, '') <> 'NEGATIVE_CONTROL'
   GROUP BY metric_id HAVING COUNT(*) < 2
);

-- ---------------------------------------------------------------------------
-- 6. PERSONA_VIEW_ACCESS is consistent with the semantic layer.
--
-- The application reads this table to decide which views to offer a persona. A
-- row naming a view that does not exist makes /ask advertise a tool that fails at
-- run time, which reads to a user as the agent being broken rather than as a
-- configuration error.
--
-- WHAT THIS CHECKS AND WHAT IT DOES NOT. It asserts that every named view exists
-- and that the row count matches the 19 GRANT statements at the end of 00e. It
-- does NOT read the grants themselves: there is no INFORMATION_SCHEMA table
-- function for object privileges (an earlier version of this file called a
-- non-existent OBJECT_PRIVILEGES and failed), and SNOWFLAKE.ACCOUNT_USAGE.
-- GRANTS_TO_ROLES lags by up to two hours, so on a freshly rebuilt account it
-- would report an empty grant set and fail every row.
--
-- Functional proof that a persona can actually query its views is 91's job: it
-- assumes the roles and runs real queries through them.
-- ---------------------------------------------------------------------------

SELECT 'persona view access naming a non-existent semantic view' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL - /ask will offer a tool that cannot resolve') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS a
WHERE NOT EXISTS (
  SELECT 1 FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_VIEWS v
   WHERE v.name = a.semantic_view
);

SELECT 'persona view access row count matches the grants in 00e' AS check_name,
       COUNT(*) AS found, 19 AS expected,
       IFF(COUNT(*) = 19, 'PASS', 'FAIL - PERSONA_VIEW_ACCESS and the GRANTs in 00e have diverged') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS;

-- The negative control must be reachable by no persona. It is bound in
-- METRIC_BINDING so the drift test reaches it with owner's rights; a human
-- persona able to query it could read a knowingly wrong number as though governed.
SELECT 'no persona can reach the defective control view' AS check_name,
       COUNT(*) AS found, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS
WHERE semantic_view = 'SC_SUPPLIER_LEGACY_DEFECT';

-- ---------------------------------------------------------------------------
-- 7. Verified queries are present on every view, in the expected number.
--
-- THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL LOSS. A previous build
-- added verified queries by splicing GET_DDL output with
--   REPLACE(ddl, 'ai_verified_queries (', ...)
-- which is a silent no-op against a view that has no such block yet. 37 of 38
-- queries vanished and nothing failed. They are now declared inline in
-- 00e_semantic.sql and 07b_prediction_objects.sql, and counted here.
--
-- GET_DDL requires constant arguments, so each view is named literally rather
-- than joined from a list.
--
-- Counting is not sufficient on its own: a verified query is stored metadata and
-- is never validated at create time, so sql/93_verify_verified_queries.sql
-- EXECUTES every one of them. Run both.
-- ---------------------------------------------------------------------------

WITH c AS (
  SELECT 'SC_ONTOLOGY_360'  AS view_name, 9 AS expected, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360'),  'QUESTION\\s+''', 1, 'i') AS found
  UNION ALL SELECT 'SC_SUPPLIER',      5, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER'),      'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_FULFILLMENT',   6, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT'),   'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_INVENTORY',     6, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY'),     'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_LANDED_COST',   5, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST'),   'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_DEMAND',        3, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_DEMAND'),        'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_MANUFACTURING', 2, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_MANUFACTURING'), 'QUESTION\\s+''', 1, 'i')
  UNION ALL SELECT 'SC_OUTLOOK',       2, REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK'),       'QUESTION\\s+''', 1, 'i')
)
SELECT 'verified queries on ' || view_name AS check_name, found, expected,
       IFF(found = expected, 'PASS', 'FAIL') AS verdict
FROM c
UNION ALL
SELECT 'verified queries, total', SUM(found), SUM(expected),
       IFF(SUM(found) = SUM(expected), 'PASS', 'FAIL') FROM c
ORDER BY check_name;

-- The negative control must carry none. A verified query on the deliberately
-- defective view would hand Cortex Analyst a knowingly wrong number as a
-- pre-approved answer.
SELECT
  'no verified query on the defective control view' AS check_name,
  REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT'), 'QUESTION\\s+''', 1, 'i') AS found,
  0 AS expected,
  IFF(REGEXP_COUNT(GET_DDL('SEMANTIC_VIEW','SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT'), 'QUESTION\\s+''', 1, 'i') = 0,
      'PASS', 'FAIL') AS verdict;

-- ---------------------------------------------------------------------------
-- 8. The agent exists, with the tools it is supposed to have.
--
-- lib/constants.ts renders SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT as
-- provenance on /ask. Before 10_agent.sql that name resolved to nothing, and the
-- page cited an object that did not exist.
-- ---------------------------------------------------------------------------

SHOW AGENTS IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS;

SELECT
  'Cortex Agent SC_ONTOLOGIST_AGENT exists' AS check_name,
  COUNT(*)                                  AS found,
  1                                         AS expected,
  IFF(COUNT(*) = 1, 'PASS', 'FAIL - 10_agent.sql has not run') AS verdict
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
WHERE "name" = 'SC_ONTOLOGIST_AGENT';

-- ---------------------------------------------------------------------------
-- 9. THE DRIFT GATE. Run last.
--
-- All 14 metrics must PASS with zero spread. This is the only check that proves
-- the semantic views and the canonical facts agree, and therefore the only one
-- that proves a number in the UI means what the registry says it means.
--
-- Scope is all-history and unfiltered on purpose. See the procedure header in
-- 00f: this asks whether two definitions agree, not whether a reporting period is
-- correct.
-- ---------------------------------------------------------------------------

CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();

WITH latest AS (
  SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
   QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
)
SELECT
  'DRIFT GATE: all metrics agree with their canonical fact' AS check_name,
  COUNT(*)                        AS metrics_checked,
  COUNT_IF(status = 'PASS')       AS passed,
  COUNT_IF(status <> 'PASS')      AS not_passed,
  MAX(relative_spread)            AS worst_relative_spread,
  IFF(COUNT(*) = 14 AND COUNT_IF(status <> 'PASS') = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
JOIN latest l ON l.run_id = r.run_id;

-- ---------------------------------------------------------------------------
-- 10. The negative control is still failing.
--
-- A drift test that has only ever passed is indistinguishable from one that is
-- not running. This asserts the control still diverges -- i.e. that somebody has
-- not "helpfully" fixed SC_SUPPLIER_LEGACY_DEFECT.
-- ---------------------------------------------------------------------------

SELECT
  'negative control still diverges' AS check_name,
  ROUND(MAX(value_spread), 6)       AS observed_spread,
  '> 0'                             AS expected,
  IFF(MAX(value_spread) > 0, 'PASS', 'FAIL - the defective view has been fixed; the control no longer proves anything') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_NEGATIVE_CONTROL;
