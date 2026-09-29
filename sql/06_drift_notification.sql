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

-- WHO RECEIVES IT is account-specific, so it is not written into the alert or the
-- digest. It lives in NOTIFICATION_SETTING and is chosen, in order, from:
--   1. SET SC_NOTIFY_EMAIL = 'someone@example.com';   before running this file
--      (scripts/rebuild.mjs --notify-email does this)
--   2. the value already stored, so a re-run keeps it
--   3. the email of the user running the build
-- scripts/migrate.mjs deliberately does not copy this table between accounts.
CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.NOTIFICATION_SETTING (
  setting_key   STRING NOT NULL,
  setting_value STRING,
  set_at        TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  set_by        STRING DEFAULT CURRENT_USER()
) COMMENT = 'Account-specific notification settings (steward email). Not migrated between accounts.';

DECLARE
  recipient STRING DEFAULT NULLIF(TRIM(GETVARIABLE('SC_NOTIFY_EMAIL')), '');
BEGIN
  IF (recipient IS NULL) THEN
    SELECT MAX(setting_value) INTO :recipient
      FROM SUPPLY_CHAIN.GOVERNANCE.NOTIFICATION_SETTING WHERE setting_key = 'STEWARD_EMAIL';
  END IF;
  IF (recipient IS NULL) THEN
    EXECUTE IMMEDIATE 'DESC USER "' || REPLACE(CURRENT_USER(), '"', '') || '"';
    SELECT MAX(NULLIF("value", 'null')) INTO :recipient
      FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE "property" = 'EMAIL';
  END IF;

  DELETE FROM SUPPLY_CHAIN.GOVERNANCE.NOTIFICATION_SETTING WHERE setting_key = 'STEWARD_EMAIL';
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.NOTIFICATION_SETTING (setting_key, setting_value)
    SELECT 'STEWARD_EMAIL', :recipient;

  -- ALLOWED_RECIPIENTS takes a literal list, hence EXECUTE IMMEDIATE. With no
  -- address at all the integration is still created, and the alert still logs.
  EXECUTE IMMEDIATE
    'CREATE OR REPLACE NOTIFICATION INTEGRATION SC_GOVERNANCE_EMAIL TYPE = EMAIL ENABLED = TRUE'
    || IFF(recipient IS NULL, '', ' ALLOWED_RECIPIENTS = (''' || REPLACE(recipient, '''', '') || ''')')
    || ' COMMENT = ''Delivers governed-metric drift failures to the ontology steward. Snowflake only delivers to verified email addresses of users in this account.''';
  RETURN OBJECT_CONSTRUCT('steward_email', :recipient);
END;

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
  LET v_to STRING;

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

  SELECT MAX(setting_value) INTO :v_to
    FROM SUPPLY_CHAIN.GOVERNANCE.NOTIFICATION_SETTING WHERE setting_key = 'STEWARD_EMAIL';
  IF (v_to IS NOT NULL) THEN
  CALL SYSTEM$SEND_EMAIL(
    'SC_GOVERNANCE_EMAIL',
    :v_to,
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
  END IF;
END;

ALTER ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED RESUME;
