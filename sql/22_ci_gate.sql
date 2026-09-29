-- ---------------------------------------------------------------------------
-- 22 - The governance gate, for CI.
--
-- Every other control in this project runs on a schedule. A schedule finds a
-- broken definition the morning after it merged. This procedure lets the same
-- controls run on a pull request, so a change that would make two teams get two
-- answers is blocked before it merges instead of reported after.
--
-- It RAISES on failure. `snow sql -q "CALL ..."` then exits non-zero, GitHub
-- marks the check red, and branch protection blocks the merge. A gate that
-- returned 'FAIL' as a string would be green in CI while saying red in its output.
--
-- What it asserts (each already exists elsewhere; the gate only composes them):
--   1. METRIC_DRIFT_TEST: every binding resolves to its canonical value.
--   2. RUN_DQ_CHECKS: every data quality check on every canonical fact passes.
--   3. The negative control is still wrong AND still uncertified - a gate that
--      only ever passes is indistinguishable from one that is not running, so
--      the deliberately defective view must keep drifting, and must never carry
--      the trusted-source tag.
--   4. Contract extraction accuracy has not regressed below 98%.
--   5. Every registered metric has a SCOR alignment.
--
-- The CI principal gets USAGE on this procedure and nothing else. The procedure
-- runs as its owner, so CI needs no grants on the data it checks.
-- The service user itself is created separately, after review:
-- sql/ci/create_ci_user.sql.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE PROCEDURE CI_GOVERNANCE_GATE()
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'CI governance gate: drift, data quality, negative control, extraction accuracy, SCOR coverage. Raises on any failure so the CI job fails.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  drift_fail NUMBER;
  drift_total NUMBER;
  control_spread FLOAT;
  control_cert STRING;
  dq_fail NUMBER;
  dq_total NUMBER;
  extraction FLOAT;
  unmapped NUMBER;
  failures ARRAY DEFAULT ARRAY_CONSTRUCT();
  gate_failed EXCEPTION (-20001, 'Governance gate failed - see the failures list in the procedure output.');
BEGIN
  CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();
  SELECT COUNT_IF(status <> 'PASS'), COUNT(*) INTO :drift_fail, :drift_total
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
   WHERE run_id = (SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT ORDER BY run_at DESC LIMIT 1);
  IF (drift_fail > 0 OR drift_total = 0) THEN
    failures := ARRAY_APPEND(failures, drift_fail || ' of ' || drift_total || ' metric bindings drifted from their canonical value');
  END IF;

  -- The negative control must still be caught: it is the proof the drift test can fail.
  SELECT MAX(ABS(legacy_otd - governed_otd)) INTO :control_spread FROM SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_OTD_VERDICT;
  IF (control_spread IS NULL OR control_spread = 0) THEN
    failures := ARRAY_APPEND(failures, 'negative control no longer diverges - the drift test has lost its proof that it can fail');
  END IF;

  CALL SUPPLY_CHAIN.GOVERNANCE.RUN_DQ_CHECKS();
  SELECT COUNT_IF(NOT passed), COUNT(*) INTO :dq_fail, :dq_total
    FROM SUPPLY_CHAIN.GOVERNANCE.DQ_CHECK_RESULT
   WHERE run_id = (SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.DQ_CHECK_RESULT ORDER BY run_at DESC LIMIT 1);
  IF (dq_fail > 0 OR dq_total = 0) THEN
    failures := ARRAY_APPEND(failures, dq_fail || ' of ' || dq_total || ' data quality checks failed');
  END IF;

  SELECT MAX(certification) INTO :control_cert
    FROM SUPPLY_CHAIN.GOVERNANCE.V_TRUST_SIGNALS WHERE semantic_view = 'SC_SUPPLIER_LEGACY_DEFECT';
  IF (control_cert = 'CERTIFIED') THEN
    failures := ARRAY_APPEND(failures, 'the deliberately defective view carries the CERTIFIED tag');
  END IF;

  SELECT extraction_accuracy INTO :extraction FROM SUPPLY_CHAIN.GOVERNANCE.V_CONTRACT_IMPACT;
  IF (extraction IS NULL OR extraction < 0.98) THEN
    failures := ARRAY_APPEND(failures, 'contract extraction accuracy ' || COALESCE(extraction::STRING, 'unknown') || ' is below 0.98');
  END IF;

  SELECT COUNT(*) INTO :unmapped FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d
   WHERE NOT EXISTS (SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_SCOR_ALIGNMENT a WHERE a.metric_id = d.metric_id);
  IF (unmapped > 0) THEN
    failures := ARRAY_APPEND(failures, unmapped || ' registered metric(s) have no SCOR alignment');
  END IF;

  IF (ARRAY_SIZE(failures) > 0) THEN
    -- Recorded before raising, so the failed run is inspectable after CI has gone red.
    INSERT INTO SUPPLY_CHAIN.GOVERNANCE.CI_GATE_RUN (run_at, passed, failures)
      SELECT CURRENT_TIMESTAMP(), FALSE, :failures;
    RAISE gate_failed;
  END IF;

  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.CI_GATE_RUN (run_at, passed, failures)
    SELECT CURRENT_TIMESTAMP(), TRUE, ARRAY_CONSTRUCT();
  RETURN OBJECT_CONSTRUCT('passed', TRUE,
    'drift', (drift_total - drift_fail) || '/' || drift_total,
    'data_quality', (dq_total - dq_fail) || '/' || dq_total,
    'negative_control_spread', control_spread,
    'extraction_accuracy', extraction);
END;
$$;

CREATE TABLE IF NOT EXISTS CI_GATE_RUN (
  run_at   TIMESTAMP_LTZ NOT NULL,
  passed   BOOLEAN NOT NULL,
  failures ARRAY
) COMMENT = 'Every CI_GOVERNANCE_GATE run, including the failures of a red run.';

-- The CI role: may run the gate, nothing more.
CREATE ROLE IF NOT EXISTS SC_CI_GATE COMMENT = 'CI principal role. USAGE on the governance gate only.';
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE SC_CI_GATE;
GRANT USAGE ON DATABASE SUPPLY_CHAIN TO ROLE SC_CI_GATE;
GRANT USAGE ON SCHEMA SUPPLY_CHAIN.GOVERNANCE TO ROLE SC_CI_GATE;
GRANT USAGE ON PROCEDURE CI_GOVERNANCE_GATE() TO ROLE SC_CI_GATE;
GRANT SELECT ON TABLE CI_GATE_RUN TO ROLE SC_ONTOLOGY_STEWARD;

CALL CI_GOVERNANCE_GATE();
