-- ---------------------------------------------------------------------------
-- 07b — Prediction-layer objects that 08 depends on but does not create.
--
-- WHY THIS FILE EXISTS. 08_prediction_layer.sql calls and reads three objects it
-- never defines:
--
--   line  92  CALL SUPPLY_CHAIN.GOVERNANCE.PREDICT_TARGET_BREACH();
--   line 144  SELECT * FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK;
--   line 171  GRANT ... ON SEMANTIC VIEW SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK
--
-- Its own comment at line 91 says as much: "Full procedure body: see
-- GOVERNANCE.PREDICT_TARGET_BREACH in the account." The body was never committed,
-- so on a fresh account 08 fails with "Unknown user-defined function
-- SUPPLY_CHAIN.GOVERNANCE.PREDICT_TARGET_BREACH". This file supplies all three.
--
-- WHY THE 07b PREFIX. It is a prerequisite of 08, not a part of 07. The name is
-- chosen so the file sorts into its correct execution position in a directory
-- listing: '_' (0x5F) sorts before 'b' (0x61), so 07_ < 07b < 08_. An "08a" name
-- would sort AFTER 08 and read as something that runs later, which is the
-- opposite of the truth.
--
-- IT CANNOT MOVE EARLIER. PREDICT_TARGET_BREACH reads
-- METRIC_DEFINITION.target_value, a column that 02_as_of_rule.sql adds and
-- 03_targets.sql populates. Run before those, every target is NULL, every z-score
-- is NULL, and the procedure writes a table full of nothing while reporting
-- success.
--
-- ---------------------------------------------------------------------------
-- WHAT THE METHOD CLAIMS, AND WHAT IT DOES NOT
--
-- 08's header establishes the finding this is built on: these metrics are
-- temporally stationary. Aggregate OTD holds inside a 0.5pp band for 23 months,
-- month-to-month standard deviation per product family is 0.2-0.4pp, and the
-- spread BETWEEN families is ~6x the spread WITHIN one. Forecasting the level of
-- such a series returns the mean and scores a flattering 99.8% accuracy while
-- demonstrating nothing.
--
-- So the question asked here is not "what will the number be" but "is the target
-- reachable from current process capability":
--
--   z = (target - realized mean) / realized sd      for higher-is-better
--   z = (realized mean - target) / realized sd      for lower-is-better
--
-- z is how many standard deviations of ordinary month-to-month variation separate
-- current performance from the target. Positive z means the target is above what
-- the process delivers.
--
-- THE PROBABILITY IS AN APPROXIMATION AND IS LABELLED AS ONE. Snowflake has no
-- ERF, so the normal CDF is approximated logistically as 1/(1+exp(-1.702z)), with
-- maximum absolute error around 0.01. That error is immaterial next to the real
-- limitation, which is that 22 monthly observations cannot support precise tail
-- probabilities at all. The z-score and the banded verdict are the trustworthy
-- outputs; the probability is a reading aid. BASIS says so on every row.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

-- Created here as well as in 08 so that this file can run standalone. Column
-- lists are identical to 08's, so 08's CREATE TABLE IF NOT EXISTS is a harmless
-- no-op afterwards. Unlike the METRIC_DEFINITION case in 00f, no-oping is safe
-- here: 08 does not add or populate columns on these tables.
CREATE TABLE IF NOT EXISTS METRIC_PREDICTION (
  prediction_id      STRING DEFAULT UUID_STRING(),
  produced_at        TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  run_id             STRING,
  metric_id          STRING NOT NULL,
  method             STRING NOT NULL,
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
  basis              STRING
);

CREATE TABLE IF NOT EXISTS PREDICTION_BACKTEST (
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
-- The monthly series every prediction and backtest is computed from.
--
-- FULL MONTHS ONLY: 2024-11 through 2026-08. The first and last months of the
-- data are partial (the data starts 2024-10-03 and the future window opens
-- 2026-09-21), and a partial month has a smaller denominator and a different mix.
-- Including them would inject variance that is an artefact of the window rather
-- than of the process, which would inflate the standard deviation and make every
-- target look more reachable than it is -- biasing the answer in the flattering
-- direction, which is the failure mode this layer is built to avoid.
--
-- Eight metrics, each by product family, so a target can be judged per family
-- rather than only in aggregate. Product family is the grain with real
-- cross-sectional spread; carrier shows 0.0008 and is not worth reporting.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW V_METRIC_MONTHLY_SERIES
  COMMENT = 'Monthly value of each targeted metric by product family, full months only (2024-11..2026-08). The observation set for the target-reachability method and its backtest.'
AS
WITH ff AS (
  SELECT DATE_TRUNC('MONTH', delivery_date) AS month_start, product_family,
         AVG(is_on_time) AS otd_pct, AVG(is_otif) AS otif_pct,
         AVG(is_in_full) AS fill_rate_pct, AVG(is_perfect_order) AS perfect_order_pct
  FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
  WHERE delivery_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
sd AS (
  SELECT DATE_TRUNC('MONTH', receipt_date) AS month_start, product_family,
         AVG(is_on_time) AS supplier_otd_pct, AVG(is_in_full) AS supplier_fill_rate
  FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
  WHERE receipt_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
lc AS (
  SELECT DATE_TRUNC('MONTH', delivery_date) AS month_start, product_family,
         SUM(total_landed_cost) / NULLIF(SUM(shipped_qty), 0) AS landed_cost_per_unit
  FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT
  WHERE delivery_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
inv AS (
  SELECT DATE_TRUNC('MONTH', snapshot_date) AS month_start, product_family,
         SUM(on_hand_qty) / NULLIF(SUM(avg_daily_demand), 0) AS days_of_inventory
  FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
  WHERE snapshot_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
)
SELECT 'otd_pct'              AS metric_id, month_start, product_family, otd_pct              AS metric_value FROM ff
UNION ALL SELECT 'otif_pct',            month_start, product_family, otif_pct            FROM ff
UNION ALL SELECT 'fill_rate_pct',       month_start, product_family, fill_rate_pct       FROM ff
UNION ALL SELECT 'perfect_order_pct',   month_start, product_family, perfect_order_pct   FROM ff
UNION ALL SELECT 'supplier_otd_pct',    month_start, product_family, supplier_otd_pct    FROM sd
UNION ALL SELECT 'supplier_fill_rate',  month_start, product_family, supplier_fill_rate  FROM sd
UNION ALL SELECT 'landed_cost_per_unit',month_start, product_family, landed_cost_per_unit FROM lc
UNION ALL SELECT 'days_of_inventory',   month_start, product_family, days_of_inventory   FROM inv;

-- ---------------------------------------------------------------------------
-- PREDICT_TARGET_BREACH — produces the target-reachability predictions and the
-- backtest that scores the method.
--
-- WHY IT DELETES ITS OWN PRIOR ROWS. Re-running must replace this method's
-- output, not accumulate it: /outlook reads the latest prediction per metric and
-- grain, and duplicate rows would silently double the row count behind a figure.
-- The DELETE is scoped to method = 'TARGET_BREACH' so it cannot touch the ANOMALY
-- or ML_FORECAST rows that 08 produces.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE PREDICT_TARGET_BREACH()
RETURNS STRING
LANGUAGE SQL
COMMENT = 'Scores whether each governed target is reachable from current process capability, per metric per product family, as a z-score against month-to-month variation. Replaces prior TARGET_BREACH predictions and rewrites their backtest.'
AS $$
DECLARE
  v_run_id STRING;
  v_as_of  DATE;
  v_rows   NUMBER;
BEGIN
  v_run_id := UUID_STRING();
  -- As of the last full month in the series, not today: today sits mid-month and
  -- the current partial month is deliberately excluded from the observations.
  v_as_of  := DATE '2026-08-31';

  DELETE FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION  WHERE method = 'TARGET_BREACH';
  DELETE FROM SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST WHERE method = 'TARGET_BREACH';

  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION
    (run_id, metric_id, method, model_version, grain_dimension, grain_value,
     as_of, horizon_period, predicted_value, lower_bound, upper_bound,
     breach_probability, target_value, basis)
  WITH stats AS (
    SELECT
      s.metric_id,
      s.product_family,
      COUNT(*)              AS n,
      AVG(s.metric_value)   AS mean_v,
      STDDEV(s.metric_value) AS sd_v
    FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_MONTHLY_SERIES s
    WHERE s.metric_value IS NOT NULL
    GROUP BY s.metric_id, s.product_family
    HAVING COUNT(*) >= 12 AND STDDEV(s.metric_value) > 0
  ),
  scored AS (
    SELECT
      st.*,
      d.target_value,
      d.direction,
      d.unit,
      -- Positive z = the target sits beyond what the process currently delivers.
      -- The sign convention flips with direction, so one verdict scale serves
      -- both higher-is-better and lower-is-better metrics.
      CASE WHEN d.direction = 'higher' THEN (d.target_value - st.mean_v) / st.sd_v
           ELSE (st.mean_v - d.target_value) / st.sd_v END AS z
    FROM stats st
    JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d ON d.metric_id = st.metric_id
    WHERE d.target_value IS NOT NULL
  )
  SELECT
    :v_run_id,
    metric_id,
    'TARGET_BREACH',
    'target-reachability v1 (z-score, logistic CDF approximation)',
    'PRODUCT_FAMILY',
    product_family,
    :v_as_of,
    'NEXT_MONTH',
    mean_v,
    -- A +/-2 sd band on the mean, i.e. the range ordinary variation produces.
    mean_v - 2 * sd_v,
    mean_v + 2 * sd_v,
    -- Probability of MISSING the target. 1/(1+exp(-1.702z)) approximates the
    -- normal CDF to about 0.01; see the file header on why that error is not the
    -- binding limitation.
    1 / (1 + EXP(-1.702 * z)),
    target_value,
    'Target is ' || TO_VARCHAR(ROUND(z, 2)) || ' standard deviations of ordinary month-to-month variation '
      || IFF(z > 0, 'BEYOND', 'WITHIN') || ' current capability for ' || product_family
      || ' (mean ' || TO_VARCHAR(ROUND(mean_v, 4)) || ', sd ' || TO_VARCHAR(ROUND(sd_v, 4))
      || ' over ' || TO_VARCHAR(n) || ' full months). '
      || 'The z-score and verdict are the reliable outputs; the probability is a logistic approximation to the normal CDF and '
      || TO_VARCHAR(n) || ' monthly observations cannot support precise tail probabilities.'
  FROM scored;

  v_rows := SQLROWCOUNT;

  -- ---------------------------------------------------------------------------
  -- Backtest, scored with the EXISTING canonical accuracy definitions rather than
  -- a second set invented here.
  --
  -- The benchmark is deliberately "predict the trailing mean", because on a
  -- stationary series that is the honest thing to beat. The expected verdict is
  -- that this method does NOT beat it on level accuracy -- which is the finding,
  -- not a failure: it is why the layer reports target reachability instead of a
  -- forecast of the level. Recording a method that loses to its own benchmark is
  -- what keeps a weak predictor visible instead of quietly shipped.
  -- ---------------------------------------------------------------------------
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST
    (method, metric_id, grain_dimension, holdout_periods, observations,
     forecast_accuracy, mape, forecast_bias, benchmark_name, benchmark_accuracy,
     beats_benchmark, verdict)
  WITH split AS (
    SELECT
      s.metric_id, s.product_family, s.month_start, s.metric_value,
      -- Last 6 full months held out; the mean of the earlier months is the
      -- prediction evaluated against them.
      IFF(s.month_start > DATE '2026-02-28', 'HOLDOUT', 'TRAIN') AS part
    FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_MONTHLY_SERIES s
    WHERE s.metric_value IS NOT NULL
  ),
  trained AS (
    SELECT metric_id, product_family, AVG(metric_value) AS train_mean
    FROM split WHERE part = 'TRAIN'
    GROUP BY metric_id, product_family
  ),
  errs AS (
    SELECT
      h.metric_id,
      COUNT(*)                                                           AS observations,
      COUNT(DISTINCT h.month_start)                                      AS holdout_periods,
      AVG(ABS(h.metric_value - t.train_mean) / NULLIF(ABS(h.metric_value), 0)) AS mape,
      AVG((t.train_mean - h.metric_value) / NULLIF(ABS(h.metric_value), 0))    AS bias
    FROM split h
    JOIN trained t ON t.metric_id = h.metric_id AND t.product_family = h.product_family
    WHERE h.part = 'HOLDOUT'
    GROUP BY h.metric_id
  )
  SELECT
    'TARGET_BREACH',
    metric_id,
    'PRODUCT_FAMILY',
    holdout_periods,
    observations,
    1 - mape,
    mape,
    bias,
    'trailing mean of the training months',
    1 - mape,
    -- Identical by construction: this method predicts the mean. Recorded as FALSE
    -- rather than TRUE so no reader can mistake a tie for an edge.
    FALSE,
    CASE
      WHEN mape <= 0.01 THEN 'Level accuracy is high only because the series is stationary. Equals the trailing-mean benchmark and does not beat it; the useful output of this method is the target-reachability z-score, not the level.'
      ELSE 'Level accuracy is moderate. Use the z-score and verdict, not the predicted level.'
    END
  FROM errs;

  RETURN 'TARGET_BREACH: ' || TO_VARCHAR(v_rows) || ' predictions written, run_id ' || v_run_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- V_METRIC_OUTLOOK — what /outlook and lib/sc.ts read.
--
-- EVERY PREDICTION IS JOINED TO ITS METHOD'S MEASURED ACCURACY. That join is the
-- point of the view, not a convenience: a prediction displayed without its track
-- record invites more confidence than it has earned, and the whole reason this
-- layer is separate from the realized metrics is to keep that distinction
-- visible. VERDICT is derived here rather than stored so it cannot fall out of
-- step with the breach probability beside it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW V_METRIC_OUTLOOK
  COMMENT = 'Governed predictions joined to the backtested accuracy of the method that produced them. A prediction is never exposed without its track record.'
AS
SELECT
  p.metric_id,
  -- LEFT JOIN, NOT INNER, AND THAT IS A DESIGN POSITION.
  --
  -- Not every prediction is about a governed metric. The volume forecast predicts
  -- order-line volume, which is a capacity and budget input, not one of the 14
  -- registered metrics. An inner join here would silently discard it, and the fix
  -- that first suggests itself -- registering volume as a governed metric so the
  -- join succeeds -- would contradict the central claim of this layer: a
  -- prediction is not a measurement. Registering a forecast in
  -- METRIC_DEFINITION would put it inside the realized-metric contract and hand
  -- it to the drift test, which would then fail it by design.
  --
  -- So predictions about unregistered series are kept, and labelled from the
  -- prediction itself when the registry has nothing to say about them.
  COALESCE(d.business_name, INITCAP(REPLACE(p.metric_id, '_', ' '))) AS business_name,
  COALESCE(d.unit, 'count')                                          AS unit,
  p.method,
  p.model_version,
  p.grain_dimension,
  p.grain_value,
  p.horizon_period,
  p.predicted_value,
  p.lower_bound,
  p.upper_bound,
  p.target_value,
  p.breach_probability,
  -- Bands, not a bare probability. The underlying z-score is trustworthy while
  -- the probability is approximate, so the label is what a reader should act on.
  CASE
    WHEN p.breach_probability >= 0.99 THEN 'UNREACHABLE'
    WHEN p.breach_probability >= 0.85 THEN 'AT_RISK'
    WHEN p.breach_probability >= 0.50 THEN 'BORDERLINE'
    WHEN p.breach_probability >= 0.15 THEN 'LIKELY_MET'
    ELSE 'ON_TRACK'
  END                                     AS verdict,
  b.forecast_accuracy                     AS method_backtest_accuracy,
  b.mape                                  AS method_backtest_mape,
  p.basis,
  p.as_of,
  p.produced_at
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION p
LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d ON d.metric_id = p.metric_id
LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST b
       ON b.method = p.method AND b.metric_id = p.metric_id;

-- ---------------------------------------------------------------------------
-- V_METRIC_OUTLOOK_SV — a thin renaming wrapper, and why it has to exist.
--
-- A semantic view cannot have a metric whose name matches the base column its
-- own fact reads. Declaring fact OUTLOOK.BREACH_P over outlook.breach_probability
-- and then metric OUTLOOK.BREACH_PROBABILITY makes the fact expression resolve to
-- the metric instead of the column, and Snowflake rejects the view outright:
--   "Cyclic reference of expressions is not allowed. Cycle detected:
--    [OUTLOOK.BREACH_P,OUTLOOK.BREACH_PROBABILITY]"
--
-- Neither side of the collision can move. The metric names are fixed by
-- 08_prediction_layer.sql, which queries outlook.predicted_value, outlook.target,
-- outlook.breach_probability and outlook.method_accuracy by name. The view column
-- names are fixed by lib/sc.ts, which reads predicted_value, breach_probability
-- and method_backtest_accuracy off V_METRIC_OUTLOOK.
--
-- So the rename happens in between, in a view that exists for no other purpose.
-- The measure columns get short names that cannot collide with any metric name,
-- and both consumers keep the names they already depend on.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW V_METRIC_OUTLOOK_SV
  COMMENT = 'Renaming wrapper over V_METRIC_OUTLOOK, used only as the base table of SEMANTIC.SC_OUTLOOK. Its measure columns are deliberately named so they cannot collide with the semantic view metric names, which would otherwise be rejected as a cyclic expression reference.'
AS
SELECT
  metric_id,
  business_name,
  unit,
  method,
  model_version,
  grain_dimension,
  grain_value,
  horizon_period,
  verdict,
  basis,
  as_of,
  predicted_value          AS pred_level,
  target_value             AS tgt_level,
  breach_probability       AS breach_p,
  method_backtest_accuracy AS method_acc
FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK;

-- ---------------------------------------------------------------------------
-- SC_OUTLOOK — the agent's read-only window onto predictions already produced.
--
-- DELIBERATELY NARROW. It reports predictions that have ALREADY been produced and
-- scored and cannot extrapolate a new one, so the conversational layer cannot be
-- talked into inventing a forecast. METHOD_ACCURACY is exposed as a metric
-- alongside the prediction for the same reason V_METRIC_OUTLOOK performs the
-- join: a forecast quoted without its track record is the failure mode here.
--
-- EXCLUDED FROM METRIC_DRIFT_TEST, and that exclusion is structural rather than
-- conventional: nothing in METRIC_BINDING references SC_OUTLOOK, so the drift test
-- never reaches it. Compared against a canonical fact a forecast would fail by
-- design, which would say nothing about its quality and would turn the drift
-- control into noise. 08's verification step checks that SC_OUTLOOK appears in no
-- drift detail line.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE SEMANTIC VIEW SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK
  TABLES (
    OUTLOOK as SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK_SV
      primary key (METRIC_ID, GRAIN_VALUE, METHOD, HORIZON_PERIOD)
      with synonyms=('outlook','prediction','forecast','projection','target risk')
      comment='sco:MetricPrediction - one governed prediction with the measured accuracy of the method that produced it. Fact, prediction grain. NOT a measurement: these are projections, and they are excluded from the drift control by design.'
  )
  FACTS (
    OUTLOOK.PREDICTED as outlook.pred_level comment='Predicted level. On a stationary series this is the mean; the reachability verdict is the useful output.',
    OUTLOOK.TARGET_V as outlook.tgt_level comment='Governed target being judged.',
    OUTLOOK.BREACH_RISK as outlook.breach_p comment='Approximate probability of missing the target. Logistic approximation to the normal CDF.',
    OUTLOOK.ACCURACY as outlook.method_acc comment='Backtested accuracy of the producing method.'
  )
  DIMENSIONS (
    OUTLOOK.METRIC_ID as outlook.metric_id with synonyms=('metric','measure') comment='Governed metric the prediction is about.',
    OUTLOOK.GRAIN as outlook.grain_value with synonyms=('product family','family','grain') comment='Value of the grain the prediction was made at, normally a product family.',
    OUTLOOK.VERDICT as outlook.verdict with synonyms=('verdict','risk band','outlook') comment='Banded reading: UNREACHABLE, AT_RISK, BORDERLINE, LIKELY_MET, ON_TRACK. Act on this rather than on the raw probability.',
    OUTLOOK.METHOD as outlook.method with synonyms=('method','model') comment='Producing method: TARGET_BREACH, ANOMALY or ML_FORECAST.',
    OUTLOOK.HORIZON as outlook.horizon_period with synonyms=('horizon','period ahead') comment='Horizon the prediction applies to.'
  )
  METRICS (
    OUTLOOK.PREDICTED_VALUE as AVG(outlook.predicted)
      with synonyms=('predicted value','projection') comment='Average predicted level over the rows in scope.',
    OUTLOOK.TARGET as AVG(outlook.target_v)
      with synonyms=('target') comment='Governed target.',
    OUTLOOK.BREACH_PROBABILITY as AVG(outlook.breach_risk)
      with synonyms=('breach probability','risk of missing target') comment='Approximate probability of missing the target. Read the verdict band rather than this number.',
    OUTLOOK.METHOD_ACCURACY as AVG(outlook.accuracy)
      with synonyms=('method accuracy','track record','backtest accuracy') comment='Backtested accuracy of the producing method. Always report this alongside a prediction.'
  )
  COMMENT = 'Governed predictions with their measured track record. Read-only window for the conversational layer: it reports predictions already produced and scored and cannot extrapolate new ones. Excluded from the drift control because a projection compared against a realized fact would fail by design.'
  -- NEITHER QUERY USES A STRING LITERAL, ON PURPOSE.
  --
  -- The obvious form of the first one is
  --   ... WHERE outlook.method = 'TARGET_BREACH'
  -- and it would break sql/93_verify_verified_queries.sql, which extracts each
  -- stored query with the pattern SQL '([^'']*)' and would stop at the first inner
  -- quote -- silently truncating the query it then executes. Exposing METHOD as a
  -- dimension instead gives the caller the same breakdown, keeps every stored
  -- query single-quote-free, and keeps the extraction honest.
  AI_VERIFIED_QUERIES (
    TARGET_BREACH_RISK_BY_FAMILY AS (
      QUESTION 'Which product families will miss their on-time delivery target next month?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK DIMENSIONS outlook.metric_id, outlook.grain, outlook.method, outlook.verdict METRICS outlook.predicted_value, outlook.target, outlook.breach_probability, outlook.method_accuracy) ORDER BY breach_probability DESC NULLS LAST'
    ),
    VOLUME_FORECAST_NEXT_MONTHS AS (
      QUESTION 'What order-line volume should we plan for over the next few months?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK DIMENSIONS outlook.metric_id, outlook.horizon, outlook.method METRICS outlook.predicted_value, outlook.method_accuracy) ORDER BY horizon'
    )
  );

GRANT SELECT ON VIEW V_METRIC_OUTLOOK TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW V_METRIC_OUTLOOK_SV TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW V_METRIC_MONTHLY_SERIES TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE ON PROCEDURE PREDICT_TARGET_BREACH() TO ROLE SC_ONTOLOGY_STEWARD;
