-- ---------------------------------------------------------------------------
-- 93 — Execute every verified query.
--
-- WHY THIS IS NOT OPTIONAL. A verified query is stored as metadata and is NOT
-- validated when the semantic view is created. A broken one is therefore
-- invisible until Cortex Analyst picks it — and when it does, it uses it in
-- preference to deriving its own SQL, so a broken verified query is worse than no
-- verified query at all: it converts a question the agent could have answered
-- into a question the agent now fails.
--
-- This already caught a real defect. A verified query filtering on
-- `forecast.actual_units_total > 0` created cleanly and failed on execution with
--   "Requested semantic expression 'FORECAST.ACTUAL_UNITS_TOTAL' in WHERE clause
--    must be one of the following types: (DIMENSION, FACT)"
-- because that name is a METRIC, and a semantic-view WHERE accepts only a
-- dimension or a fact. Nothing else in this directory would have found it.
--
-- HOW. For each view, pull GET_DDL, extract every SQL '...' payload, run it, and
-- record the outcome. Results land in a real table rather than being printed, so a
-- failure can be inspected after the fact instead of re-derived from a log.
--
-- The extraction regex assumes no verified query contains an escaped single quote.
-- That holds by construction: the queries in 00e deliberately use no string
-- literals. The final assertion below fails loudly if the extracted count does not
-- match the declared count, which is what catches a regex that silently stopped
-- early.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;
USE WAREHOUSE COMPUTE_WH;

CREATE OR REPLACE TABLE VERIFIED_QUERY_CHECK (
  checked_at    TIMESTAMP_LTZ,
  semantic_view STRING,
  query_index   NUMBER,
  status        STRING COMMENT 'PASS or FAIL.',
  rows_returned NUMBER,
  error         STRING,
  query_sql     STRING
) COMMENT = 'Execution result for every verified query declared on every semantic view. A verified query is stored metadata and is not validated at create time, so it has to be run to be trusted.';

DECLARE
  views   ARRAY := ARRAY_CONSTRUCT(
            'SC_ONTOLOGY_360', 'SC_SUPPLIER', 'SC_FULFILLMENT', 'SC_INVENTORY',
            'SC_LANDED_COST', 'SC_DEMAND', 'SC_MANUFACTURING', 'SC_OUTLOOK');
  v_name  STRING;
  v_ddl   STRING;
  v_q     STRING;
  v_i     NUMBER;
  v_n     NUMBER;
  v_at    TIMESTAMP_LTZ;
BEGIN
  v_at := CURRENT_TIMESTAMP();

  FOR j IN 0 TO ARRAY_SIZE(:views) - 1 DO
    v_name := GET(:views, j)::STRING;

    -- GET_DDL requires constant arguments, so the call is built as text rather
    -- than passed a bind. Passing :v_name directly fails with
    -- "constant arguments expected".
    LET ddl_stmt STRING := 'SELECT GET_DDL(''SEMANTIC_VIEW'', ''SUPPLY_CHAIN.SEMANTIC.' || v_name || ''')';
    LET dres RESULTSET := (EXECUTE IMMEDIATE :ddl_stmt);
    LET dcur CURSOR FOR dres;
    OPEN dcur;
    FETCH dcur INTO v_ddl;
    CLOSE dcur;

    v_i := 1;
    LOOP
      v_q := REGEXP_SUBSTR(v_ddl, 'SQL ''([^'']*)''', 1, v_i, 'e', 1);
      IF (v_q IS NULL) THEN
        BREAK;
      END IF;

      BEGIN
        LET qres RESULTSET := (EXECUTE IMMEDIATE :v_q);
        LET qcur CURSOR FOR qres;
        v_n := 0;
        FOR r IN qcur DO
          v_n := v_n + 1;
        END FOR;
        INSERT INTO SUPPLY_CHAIN.GOVERNANCE.VERIFIED_QUERY_CHECK
          (checked_at, semantic_view, query_index, status, rows_returned, error, query_sql)
        SELECT :v_at, :v_name, :v_i, 'PASS', :v_n, NULL, :v_q;
      EXCEPTION
        WHEN OTHER THEN
          INSERT INTO SUPPLY_CHAIN.GOVERNANCE.VERIFIED_QUERY_CHECK
            (checked_at, semantic_view, query_index, status, rows_returned, error, query_sql)
          SELECT :v_at, :v_name, :v_i, 'FAIL', NULL, SQLERRM, :v_q;
      END;

      v_i := v_i + 1;
    END LOOP;
  END FOR;

  RETURN 'verified queries executed';
END;

-- ---------------------------------------------------------------------------
-- Verdicts.
-- ---------------------------------------------------------------------------

SELECT
  semantic_view,
  COUNT(*)                   AS verified_queries,
  COUNT_IF(status = 'PASS')  AS passed,
  COUNT_IF(status = 'FAIL')  AS failed,
  IFF(COUNT_IF(status = 'FAIL') = 0, 'PASS', 'FAIL') AS verdict
FROM VERIFIED_QUERY_CHECK
GROUP BY semantic_view
ORDER BY semantic_view;

-- Any failure, with its error, so the cause is on screen and not in a log.
SELECT semantic_view, query_index, error, query_sql
FROM VERIFIED_QUERY_CHECK
WHERE status = 'FAIL'
ORDER BY semantic_view, query_index;

SELECT
  'ALL VERIFIED QUERIES EXECUTE' AS check_name,
  COUNT(*)                       AS total,
  COUNT_IF(status = 'FAIL')      AS failed,
  38                             AS expected_total,
  IFF(COUNT(*) = 38 AND COUNT_IF(status = 'FAIL') = 0, 'PASS',
      'FAIL - a stored verified query is broken, or the extraction found the wrong number') AS verdict
FROM VERIFIED_QUERY_CHECK;

-- A verified query that returns no rows is not an error, but it is a poor teaching
-- example: Analyst will reuse it and the user gets an empty answer.
SELECT
  'no verified query returns zero rows' AS check_name,
  COUNT(*)                             AS found,
  0                                    AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM VERIFIED_QUERY_CHECK
WHERE status = 'PASS' AND COALESCE(rows_returned, 0) = 0;

GRANT SELECT ON TABLE VERIFIED_QUERY_CHECK TO ROLE SC_ONTOLOGY_STEWARD;
