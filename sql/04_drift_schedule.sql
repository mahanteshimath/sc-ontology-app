-- ---------------------------------------------------------------------------
-- Phase 7 — Run the drift test as a control, not as a button.
--
-- Before this, METRIC_DRIFT_TEST only ran when somebody opened the Metric
-- Registry page and clicked. A governance control that only runs when observed
-- is not a control: a definition could drift on a Tuesday and nobody would know
-- until the next demo.
--
-- Three objects:
--   1. TASK  METRIC_DRIFT_TEST_DAILY  - runs the test every morning.
--   2. TABLE METRIC_DRIFT_ALERT_LOG   - append-only record of detected failures,
--                                       so a failure survives even if nobody is
--                                       watching email.
--   3. ALERT METRIC_DRIFT_FAILED      - fires when the newest run has any FAIL,
--                                       writes to the log, and emails if an
--                                       email integration is configured.
--
-- COST. The task is serverless on the smallest size and the procedure takes
-- ~25 seconds, so this is a fraction of a credit per day. Suspend it with:
--   ALTER TASK SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST_DAILY SUSPEND;
--   ALTER ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED SUSPEND;
--
-- EMAIL. Snowflake email notifications only deliver to verified email addresses
-- of users in this account. If the address below is not verified the alert still
-- runs and still writes to METRIC_DRIFT_ALERT_LOG; only the email is dropped.
-- ---------------------------------------------------------------------------

-- 1. Daily execution of the governed drift test.
CREATE OR REPLACE TASK SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST_DAILY
  SCHEDULE = 'USING CRON 0 6 * * * UTC'
  USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
  COMMENT = 'Runs METRIC_DRIFT_TEST every day at 06:00 UTC so a definition that drifts is detected without anyone opening the app.'
AS
  CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();

-- 2. Durable record of every detected failure.
CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG (
  detected_at    TIMESTAMP_LTZ NOT NULL,
  run_id         STRING        NOT NULL,
  failed_metrics NUMBER        NOT NULL,
  max_spread     FLOAT,
  detail         STRING
) COMMENT = 'Append-only log of drift-test runs that contained at least one FAIL. Separate from METRIC_DRIFT_RESULT so the alerting history is not lost if result rows are ever pruned.';

-- 3. Alert on the newest run containing a failure.
CREATE OR REPLACE ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED
  SCHEDULE = '60 MINUTE'
  IF (EXISTS (
    WITH latest_run AS (
      SELECT run_id
        FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
       QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
    )
    SELECT 1
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
      JOIN latest_run l ON l.run_id = r.run_id
     WHERE r.status <> 'PASS'
       -- Only alert on a run that has not already been logged, so one failure does
       -- not produce an email every hour until it is fixed.
       AND NOT EXISTS (
         SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG a
          WHERE a.run_id = r.run_id
       )
  ))
THEN
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG
    (detected_at, run_id, failed_metrics, max_spread, detail)
  WITH latest_run AS (
    SELECT run_id
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
  )
  SELECT CURRENT_TIMESTAMP(),
         r.run_id,
         COUNT(*),
         MAX(r.relative_spread),
         LISTAGG(r.metric_id || ' spread=' || TO_VARCHAR(ROUND(r.value_spread, 10)), '; ')
  FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
  JOIN latest_run l ON l.run_id = r.run_id
  WHERE r.status <> 'PASS'
  GROUP BY r.run_id;

ALTER TASK  SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST_DAILY RESUME;
ALTER ALERT SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED     RESUME;
