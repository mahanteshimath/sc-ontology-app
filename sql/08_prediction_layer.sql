-- ---------------------------------------------------------------------------
-- Phase 9 - Governed prediction layer.
--
-- WHAT THE DATA SUPPORTS, MEASURED FIRST.
--
-- Before building anything I checked whether this data can carry a forecast.
-- Mostly it cannot, and that finding shaped the design:
--
--   * Aggregate OTD sits between 0.8759 and 0.8811 for 23 consecutive months.
--     No trend, no seasonality. (2024-10 and 2026-09 are partial months.)
--   * Per product family, month-to-month sd is 0.21-0.40pp, while the spread
--     BETWEEN families is 4.9pp - a ratio of about 6:1.
--   * Carriers show 0.0008 spread. There is nothing to predict there.
--   * The incumbent ERP demand plan is already 98.83% accurate (MAPE 1.17%).
--
-- So forecasting the LEVEL of a ratio metric returns a flat line at the mean.
-- The backtest proves it: predicting the mean scores 99.79% accuracy / 0.21%
-- MAPE on six held-out months. An excellent-looking number that demonstrates
-- nothing - precisely the vanity metric this project exists to prevent.
--
-- The data is cross-sectionally rich and temporally stationary. So the honest
-- question is not "what will the number be" but "is the target reachable".
--
-- DELIBERATELY NOT DONE: injecting synthetic trend or seasonality into the UTIL
-- generator to make forecasting demo better. It would alter the dataset that the
-- drift baseline and every governed metric depend on.
--
-- A PREDICTION IS NOT A MEASUREMENT. Enforced structurally:
--   * predictions live here, never in a realized aggregate;
--   * they are EXCLUDED from METRIC_DRIFT_TEST - against the canonical fact a
--     forecast would fail by design, which says nothing about its quality;
--   * they are scored with the EXISTING canonical FORECAST_ACCURACY / MAPE /
--     FORECAST_BIAS definitions, not a second set invented for the occasion;
--   * each method's measured accuracy is itself surfaced, so a weak predictor is
--     visible rather than quietly shipped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION (
  prediction_id      STRING DEFAULT UUID_STRING(),
  produced_at        TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  run_id             STRING,
  metric_id          STRING NOT NULL,
  method             STRING NOT NULL,   -- TARGET_BREACH | ANOMALY | ML_FORECAST
  model_version      STRING,
  grain_dimension    STRING,
  grain_value        STRING,
  as_of              DATE NOT NULL,
  horizon_period     STRING,
  predicted_value    FLOAT,
  lower_bound        FLOAT,
  upper_bound        FLOAT,
  breach_probability FLOAT,
  target_value       FLOAT,
  basis              STRING             -- plain-language justification
);

CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST (
  scored_at          TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  method             STRING NOT NULL,
  metric_id          STRING NOT NULL,
  grain_dimension    STRING,
  holdout_periods    NUMBER,
  observations       NUMBER,
  forecast_accuracy  FLOAT,
  mape               FLOAT,
  forecast_bias      FLOAT,
  benchmark_name     STRING,
  benchmark_accuracy FLOAT,
  beats_benchmark    BOOLEAN,
  verdict            STRING
);

-- ---------------------------------------------------------------------------
-- Method 1 - TARGET_BREACH. The prediction the data actually supports.
--
-- z = (target - realized mean) / realized sd, i.e. how many standard deviations
-- the target sits above current performance. Because each family holds its level
-- so tightly, this is a confident statement.
--
-- LIMIT, STATED OPENLY: the probability is a LOGISTIC approximation to the normal
-- CDF, 1/(1+exp(-1.702z)), because Snowflake has no ERF. Max absolute error is
-- about 0.01 - immaterial next to the real limitation, which is that 22 monthly
-- observations cannot support precise tail probabilities at all. The z-score and
-- the banded verdict are the trustworthy outputs.
--
-- Headline result: the 95% OTD target sits 16-34 sd above every family. That is
-- not a stretch target; on current process capability it is unreachable. Fill
-- rate is the opposite case, where the method discriminates properly.
-- ---------------------------------------------------------------------------

-- Full procedure body: see GOVERNANCE.PREDICT_TARGET_BREACH in the account.
CALL SUPPLY_CHAIN.GOVERNANCE.PREDICT_TARGET_BREACH();

-- ---------------------------------------------------------------------------
-- Method 2 - ANOMALY. The CORRECT tool for a flat series, and the one place
-- where stationarity is an asset rather than an embarrassment: because each
-- family holds +/-0.3pp, a genuine shift is highly detectable. Complements the
-- drift alert, which catches DEFINITIONAL breaks; this catches BEHAVIOURAL ones.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE SNOWFLAKE.ML.ANOMALY_DETECTION SUPPLY_CHAIN.GOVERNANCE.OTD_ANOMALY(
  INPUT_DATA => TABLE(
    SELECT DATE_TRUNC('month', delivery_date)::TIMESTAMP_NTZ AS month_ts,
           product_family::VARCHAR                           AS series,
           AVG(is_on_time)::FLOAT                            AS otd
    FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
    WHERE delivery_date BETWEEN '2024-11-01' AND '2026-08-31'
    GROUP BY 1, 2
  ),
  SERIES_COLNAME    => 'SERIES',
  TIMESTAMP_COLNAME => 'MONTH_TS',
  TARGET_COLNAME    => 'OTD',
  LABEL_COLNAME     => ''
);

-- ---------------------------------------------------------------------------
-- Method 3 - ML_FORECAST on volume. The one series with legitimate signal:
-- a stable level plus a days-in-month effect (February runs ~5,000 lines below a
-- 31-day month). Modest, honest, and useful for capacity and budget.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES AS
SELECT DATE_TRUNC('month', delivery_date)::TIMESTAMP_NTZ AS month_ts,
       COUNT(*)::FLOAT                                   AS order_lines,
       DAY(LAST_DAY(MAX(delivery_date)))::FLOAT          AS days_in_month
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
WHERE delivery_date BETWEEN '2024-11-01' AND '2026-08-31'   -- full months only
GROUP BY 1;

CREATE OR REPLACE SNOWFLAKE.ML.FORECAST SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST(
  INPUT_DATA => TABLE(SELECT month_ts, order_lines FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES),
  TIMESTAMP_COLNAME => 'MONTH_TS',
  TARGET_COLNAME    => 'ORDER_LINES'
);

SELECT * FROM TABLE(SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST!FORECAST(FORECASTING_PERIODS => 3));

-- ---------------------------------------------------------------------------
-- Reading it back. V_METRIC_OUTLOOK joins each prediction to the backtested
-- accuracy of the method that produced it, on purpose: a prediction shown
-- without its track record invites more trust than it has earned.
-- ---------------------------------------------------------------------------

SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK;
SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST;

-- ---------------------------------------------------------------------------
-- Exposing predictions to the agent.
--
-- A `generic` custom tool would need client-side execution, so the native route
-- is a semantic view the agent reaches through Cortex Analyst. SC_OUTLOOK is
-- deliberately narrow: it reports predictions that have ALREADY been produced
-- and scored, and cannot extrapolate a new one.
--
-- Each verified query on it pairs the prediction with its own accuracy, so the
-- agent cannot learn to quote a forecast without its track record.
--
-- WHY A DEV AGENT. Production is never edited directly. Agents do not support
-- CLONE, so the DEV spec is SPLICED from the live one with OBJECT_INSERT and
-- ARRAY_APPEND rather than retyped - which is what guarantees no existing tool
-- or instruction is silently dropped. 7 tools -> 8, 6,615 -> 8,783 bytes.
--
-- Verify before promoting:
--   SHOW AGENTS LIKE 'SC_ONTOLOGIST_AGENT%' IN ACCOUNT;   -- prod created_on must be unchanged
--   CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();      -- SC_OUTLOOK must appear in NO detail line
--
-- That second check is the one that matters: it is the evidence for the claim
-- that predictions stay out of the realized-metric contract.
-- ---------------------------------------------------------------------------

GRANT REFERENCES, SELECT ON SEMANTIC VIEW SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK TO ROLE SC_ONTOLOGY_STEWARD;

SELECT * FROM SEMANTIC_VIEW(
  SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK
  DIMENSIONS outlook.metric_id, outlook.grain, outlook.verdict
  METRICS outlook.predicted_value, outlook.target, outlook.breach_probability, outlook.method_accuracy
  WHERE outlook.method = 'TARGET_BREACH'
) ORDER BY breach_probability DESC;