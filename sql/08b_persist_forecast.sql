-- ---------------------------------------------------------------------------
-- 08b — Persist the volume forecast, and measure it.
--
-- WHY THIS FILE EXISTS. 08_prediction_layer.sql trains
-- SNOWFLAKE.ML.FORECAST VOLUME_FORECAST and then, at line 136, merely SELECTs
-- from it:
--
--   SELECT * FROM TABLE(SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST!FORECAST(
--                         FORECASTING_PERIODS => 3));
--
-- The rows are displayed and discarded. Nothing writes them to
-- METRIC_PREDICTION, so app/outlook/page.tsx:35 --
--   const forecast = outlook.filter((o) => o.method === "ML_FORECAST")
-- -- is always empty and the entire "Order-line volume forecast" section is
-- hidden behind its `forecast.length > 0` guard. scripts/smoke-outlook.mjs
-- catches it as a missing section; nothing else does, because a hidden section
-- looks exactly like a section that is not meant to be there.
--
-- Must run AFTER 08: VOLUME_FORECAST does not exist until 08 trains it.
--
-- ---------------------------------------------------------------------------
-- THE ACCURACY FIGURE IS MEASURED HERE, NOT ASSERTED
--
-- A prediction is only exposed alongside its track record (see V_METRIC_OUTLOOK
-- in 07b), which means this forecast needs a real backtest number. The tempting
-- shortcut is to write a plausible accuracy into PREDICTION_BACKTEST as a
-- literal. That would be a fabricated measurement presented as a measured one --
-- the precise failure this project exists to prevent, and worse here than
-- anywhere else because the number's whole job is to tell a reader how much to
-- trust the forecast beside it.
--
-- So a second model is trained on a truncated series (through 2026-02), used to
-- forecast the six months that were withheld, and scored against what actually
-- happened. The benchmark is the trailing mean, which is the honest thing to beat
-- on a near-stationary series. BEATS_BENCHMARK records the outcome either way.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

-- ---------------------------------------------------------------------------
-- 1. Backtest: withhold the last six full months and forecast them.
--
-- V_MONTHLY_VOLUME_SERIES (created by 08) covers 2024-11..2026-08, 22 full
-- months. Training stops at 2026-02 so that 2026-03..2026-08 are genuinely
-- unseen. 16 training months is above the 12 SNOWFLAKE.ML.FORECAST requires.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW V_MONTHLY_VOLUME_TRAIN
  COMMENT = 'Training slice of V_MONTHLY_VOLUME_SERIES, 2024-11..2026-02. Exists only so the six months withheld from it can be used to measure the volume forecast rather than assert its accuracy.'
AS
SELECT month_ts, order_lines
FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES
WHERE month_ts <= '2026-02-01'::TIMESTAMP_NTZ;

CREATE OR REPLACE SNOWFLAKE.ML.FORECAST VOLUME_FORECAST_BACKTEST(
  INPUT_DATA        => TABLE(SELECT month_ts, order_lines FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_TRAIN),
  TIMESTAMP_COLNAME => 'MONTH_TS',
  TARGET_COLNAME    => 'ORDER_LINES'
);

-- The model's output has to be landed before it can be joined to actuals: a
-- model!FORECAST call cannot be referenced twice in one statement.
CREATE OR REPLACE TABLE VOLUME_BACKTEST_FORECAST (
  ts           TIMESTAMP_NTZ,
  forecast     FLOAT,
  lower_bound  FLOAT,
  upper_bound  FLOAT
) COMMENT = 'Raw output of VOLUME_FORECAST_BACKTEST over the six withheld months. Intermediate evidence for the PREDICTION_BACKTEST row; kept so the scoring can be re-checked by hand.';

INSERT INTO VOLUME_BACKTEST_FORECAST (ts, forecast, lower_bound, upper_bound)
SELECT TS::TIMESTAMP_NTZ, FORECAST, LOWER_BOUND, UPPER_BOUND
FROM TABLE(SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST_BACKTEST!FORECAST(FORECASTING_PERIODS => 6));

DELETE FROM PREDICTION_BACKTEST WHERE method = 'ML_FORECAST';

INSERT INTO PREDICTION_BACKTEST
  (method, metric_id, grain_dimension, holdout_periods, observations,
   forecast_accuracy, mape, forecast_bias, benchmark_name, benchmark_accuracy,
   beats_benchmark, verdict)
WITH actual AS (
  SELECT month_ts, order_lines
  FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES
  WHERE month_ts > '2026-02-01'::TIMESTAMP_NTZ
),
bench AS (
  SELECT AVG(order_lines) AS train_mean FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_TRAIN
),
scored AS (
  SELECT
    COUNT(*)                                                                   AS observations,
    AVG(ABS(f.forecast - a.order_lines) / NULLIF(a.order_lines, 0))            AS mape,
    AVG((f.forecast - a.order_lines) / NULLIF(a.order_lines, 0))               AS bias,
    AVG(ABS(b.train_mean - a.order_lines) / NULLIF(a.order_lines, 0))          AS bench_mape
  FROM actual a
  JOIN SUPPLY_CHAIN.GOVERNANCE.VOLUME_BACKTEST_FORECAST f ON f.ts = a.month_ts
  CROSS JOIN bench b
)
SELECT
  'ML_FORECAST',
  'order_line_volume',
  'NETWORK',
  6,
  observations,
  1 - mape,
  mape,
  bias,
  'trailing mean of the 16 training months',
  1 - bench_mape,
  (mape < bench_mape),
  CASE
    WHEN mape < bench_mape
      THEN 'Beats the trailing-mean benchmark on six withheld months. The signal it captures is the days-in-month effect, not a trend: use it for capacity and budget, not as evidence that volume is moving.'
    ELSE 'Does NOT beat the trailing-mean benchmark on six withheld months. The series is close enough to stationary that the mean is hard to improve on; treat the forecast as a capacity envelope rather than a point estimate.'
  END
FROM scored;

-- ---------------------------------------------------------------------------
-- 2. Persist the production forecast so /outlook can render it.
--
-- METRIC_ID IS DELIBERATELY NOT A REGISTERED METRIC. 'order_line_volume' does not
-- appear in METRIC_DEFINITION, and must not: registering it would place a
-- forecast inside the realized-metric contract, hand it to METRIC_DRIFT_TEST, and
-- guarantee a failure that says nothing about the forecast's quality.
-- V_METRIC_OUTLOOK left-joins the registry precisely so this row survives, and
-- labels it from the metric_id. See the join note in 07b.
--
-- GRAIN is NETWORK/ALL rather than per family: the model is trained on total
-- order lines, so reporting it at a family grain would imply a breakdown that was
-- never fitted.
-- ---------------------------------------------------------------------------

DELETE FROM METRIC_PREDICTION WHERE method = 'ML_FORECAST';

INSERT INTO METRIC_PREDICTION
  (run_id, metric_id, method, model_version, grain_dimension, grain_value,
   as_of, horizon_period, predicted_value, lower_bound, upper_bound,
   breach_probability, target_value, basis)
SELECT
  UUID_STRING(),
  'order_line_volume',
  'ML_FORECAST',
  'SNOWFLAKE.ML.FORECAST over 22 full months',
  'NETWORK',
  'ALL',
  DATE '2026-08-31',
  TO_CHAR(TS::DATE, 'YYYY-MM'),
  FORECAST,
  LOWER_BOUND,
  UPPER_BOUND,
  -- No target exists for volume, so there is nothing to breach. NULL rather than
  -- 0, which would render as "certain to meet target" on a metric that has none.
  NULL,
  NULL,
  'Order-line volume for ' || TO_CHAR(TS::DATE, 'YYYY-MM')
    || ', from SNOWFLAKE.ML.FORECAST trained on 22 full months. The only series here with legitimate signal: '
    || 'a stable level plus a days-in-month effect. Useful for capacity and budget planning. '
    || 'Volume is not a governed metric and carries no target, so no breach probability is reported.'
FROM TABLE(SUPPLY_CHAIN.GOVERNANCE.VOLUME_FORECAST!FORECAST(FORECASTING_PERIODS => 3));

GRANT SELECT ON VIEW V_MONTHLY_VOLUME_TRAIN TO ROLE SC_ONTOLOGY_STEWARD;

-- ---------------------------------------------------------------------------
-- 3. Evidence.
--
-- The second query is the assertion 08's own header calls for: predictions must
-- stay out of the realized-metric contract, so no drift-test detail line may ever
-- mention SC_OUTLOOK or a prediction method.
-- ---------------------------------------------------------------------------

SELECT method, metric_id, grain_value, horizon_period,
       ROUND(predicted_value) AS predicted, ROUND(lower_bound) AS lo, ROUND(upper_bound) AS hi
FROM METRIC_PREDICTION WHERE method = 'ML_FORECAST' ORDER BY horizon_period;

SELECT
  'predictions stay out of the drift contract' AS check_name,
  COUNT(*)                                    AS found,
  0                                           AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
WHERE semantic_view = 'SC_OUTLOOK';
