-- ---------------------------------------------------------------------------
-- Phase 7b — Make a drift failure actually reach someone.
--
-- The alert created in 04_drift_schedule.sql wrote to a table and stopped there.
-- A control whose output nobody receives is a log, not an alert, so this adds
-- email delivery and — more importantly — proves the whole chain fires.
--
-- EMAIL DELIVERY CAVEAT. Snowflake only delivers to email addresses that are
-- verified on a user in this account. If the address is unverified, the alert
-- still runs and still writes METRIC_DRIFT_ALERT_LOG; only the email is dropped.
-- That ordering is deliberate: the body logs first and notifies second, so a
-- delivery problem never loses the finding.
--
-- PROVEN, NOT ASSUMED. This chain was verified end to end by re-binding
-- SC_SUPPLIER_LEGACY_DEFECT (the recorded average-of-averages defect) to
-- supplier_otd_pct, which made METRIC_DRIFT_TEST fail with a relative spread of
-- 0.0113. The alert triggered (state TRIGGERED, error code 0), wrote to
-- METRIC_DRIFT_ALERT_LOG and sent the email. The binding was then removed and
-- the test re-run clean. The failing run is kept in
-- METRIC_DRIFT_NEGATIVE_CONTROL as evidence.
--
-- To repeat that verification:
--   INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
--     (metric_id, semantic_view, metric_reference, persona_role)
--   SELECT 'supplier_otd_pct','SC_SUPPLIER_LEGACY_DEFECT','supplier.supplier_otd_pct','NEGATIVE_CONTROL';
--   CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();
--   EXECUTE ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED;
--   DELETE FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING WHERE semantic_view = 'SC_SUPPLIER_LEGACY_DEFECT';
--   CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();   -- restores all-PASS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE NOTIFICATION INTEGRATION SC_GOVERNANCE_EMAIL
  TYPE = EMAIL
  ENABLED = TRUE
  ALLOWED_RECIPIENTS = ('mhiremath@mmm.com')
  COMMENT = 'Delivers governed-metric drift failures to the ontology steward. Snowflake only delivers to verified email addresses of users in this account.';

CREATE OR REPLACE ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED
  SCHEDULE = '60 MINUTE'
  IF (EXISTS (
    WITH latest_run AS (
      SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
       QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
    )
    SELECT 1
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
      JOIN latest_run l ON l.run_id = r.run_id
     WHERE r.status <> 'PASS'
       -- Only alert on a run not already logged, so one unfixed failure does not
       -- produce an identical email every hour until someone attends to it.
       AND NOT EXISTS (SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG a WHERE a.run_id = r.run_id)
  ))
THEN
BEGIN
  LET v_run_id STRING;
  LET v_failed INTEGER;
  LET v_spread FLOAT;
  LET v_detail STRING;

  WITH latest_run AS (
    SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
  )
  SELECT r.run_id, COUNT(*), MAX(r.relative_spread),
         LISTAGG(r.metric_id || ' spread=' || TO_VARCHAR(ROUND(r.value_spread, 10)), '; ')
    INTO :v_run_id, :v_failed, :v_spread, :v_detail
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
    JOIN latest_run l ON l.run_id = r.run_id
   WHERE r.status <> 'PASS'
   GROUP BY r.run_id;

  -- Log first, then notify. If the email fails (unverified address, integration disabled) the
  -- failure is still recorded and visible on /metrics, rather than being lost with the email.
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG
    (detected_at, run_id, failed_metrics, max_spread, detail)
  SELECT CURRENT_TIMESTAMP(), :v_run_id, :v_failed, :v_spread, :v_detail;

  CALL SYSTEM$SEND_EMAIL(
    'SC_GOVERNANCE_EMAIL',
    'mhiremath@mmm.com',
    '[Supply Chain Ontology] Metric drift detected: ' || :v_failed || ' metric(s) FAILED',
    'The governed drift test found metrics whose semantic views no longer agree with the canonical fact.'
      || '\n\nRun id: ' || :v_run_id
      || '\nFailing metrics: ' || :v_failed
      || '\nMax relative spread: ' || TO_VARCHAR(:v_spread)
      || '\n\nDetail: ' || :v_detail
      || '\n\nThis means the same question can now return different answers depending on which view'
      || ' answers it. Investigate before trusting any affected figure.'
      || '\n\nFull history: GOVERNANCE.METRIC_DRIFT_RESULT (run_id above) and the Metric Registry page.'
  );
END;

ALTER ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED RESUME;
