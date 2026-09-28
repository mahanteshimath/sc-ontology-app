-- ---------------------------------------------------------------------------
-- 17 - The impact scorecard.
--
-- Every claim this project makes about its own value already exists somewhere
-- as a measured row: the drift run, the eval run, the parity run, the
-- divergence verdicts, the contract compliance view. What did not exist is one
-- place that states them together, with the source object beside each number
-- and an explicit label saying whether it was MEASURED or is an ASSUMPTION.
--
-- That label is the point. A hackathon impact slide is usually a column of
-- confident figures with no provenance. Here the only assumption is the one a
-- reader can check against their own organisation -- how long a cross-team
-- metric question takes to settle today -- and it is labelled as such, next to
-- the measured latency it is compared with.
--
-- Recomputed on read. Nothing here is stored, so it cannot go stale.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE VIEW V_IMPACT_SCORECARD
  COMMENT = 'Measured outcomes of the governed ontology, one row per claim, each with its source object and a MEASURED/ASSUMPTION basis label. Recomputed on read.'
AS
WITH
drift AS (
  SELECT COUNT(*) AS bindings_tested, COUNT_IF(status = 'PASS') AS passed, MAX(value_spread) AS max_spread, MAX(run_at) AS run_at
    FROM METRIC_DRIFT_RESULT
   WHERE run_id = (SELECT run_id FROM METRIC_DRIFT_RESULT ORDER BY run_at DESC LIMIT 1)
),
ev AS (SELECT * FROM AGENT_EVAL_RUN ORDER BY run_at DESC LIMIT 1),
par AS (
  SELECT COUNT(*) AS questions, COUNT_IF(status = 'MATCH') AS matched, COUNT_IF(status = 'AS_OF_GAP') AS as_of_gap, COUNT_IF(status = 'DIVERGE') AS diverged, MAX(run_at) AS run_at
    FROM AGENT_PARITY_RESULT
   WHERE run_id = (SELECT run_id FROM AGENT_PARITY_RESULT ORDER BY run_at DESC LIMIT 1)
),
dv AS (SELECT * FROM V_DIVERGENCE_IMPACT),
ct AS (SELECT * FROM V_CONTRACT_IMPACT),
-- The one assumption. Four hours is a conservative reading of "someone
-- notices two decks disagree, two analysts reconcile, a steward rules" --
-- replace it with your own figure; every row that uses it says so.
baseline AS (SELECT 4.0 AS manual_reconciliation_hours)
SELECT * FROM (
  SELECT 1 AS ord, 'Consistency' AS pillar, 'Metric bindings resolving to the canonical value' AS measure,
         d.passed || ' / ' || d.bindings_tested AS value, 'MEASURED' AS basis,
         'METRIC_DRIFT_RESULT (run ' || TO_VARCHAR(d.run_at, 'YYYY-MM-DD') || ')' AS source_object FROM drift d
  UNION ALL
  SELECT 2, 'Consistency', 'Largest spread between personas on the same metric',
         TO_VARCHAR(d.max_spread), 'MEASURED', 'METRIC_DRIFT_RESULT' FROM drift d
  UNION ALL
  SELECT 3, 'Accuracy', 'Conversational eval pass rate (golden questions, run as each persona)',
         ROUND(e.accuracy * 100, 1) || '% (' || e.passed || ' / ' || e.questions || ')', 'MEASURED',
         'AGENT_EVAL_RUN (' || e.resolver_model || ')' FROM ev e
  UNION ALL
  SELECT 4, 'Accuracy', 'Invented-metric questions correctly refused',
         e.refusals_correct || ' / ' || e.refusals_expected, 'MEASURED', 'AGENT_EVAL_RUN' FROM ev e
  UNION ALL
  SELECT 5, 'Accuracy', 'Cortex Agent reproduces the canonical definition (agent vs. app vs. registry SQL)',
         (p.matched + p.as_of_gap) || ' / ' || p.questions || ' reconciled, ' || p.diverged || ' diverge (' || p.as_of_gap || ' differ only by the governed as-of rule)', 'MEASURED', 'AGENT_PARITY_RESULT' FROM par p
  UNION ALL
  SELECT 6, 'Accuracy', 'Contract terms extracted correctly by AI_EXTRACT',
         ROUND(c.extraction_accuracy * 100, 1) || '% of fields', 'MEASURED', 'V_CONTRACT_EXTRACTION_ACCURACY' FROM ct c
  UNION ALL
  SELECT 7, 'Decisions', 'Suppliers the legacy definition wrongly clears',
         dv.false_passes || ' of ' || dv.suppliers || ' (compliant list inflated ' || ROUND(dv.compliant_list_inflation * 100) || '%)',
         'MEASURED', 'V_DIVERGENCE_IMPACT' FROM dv
  UNION ALL
  SELECT 8, 'Money', 'Claimable contract penalties on governed breaches',
         '$' || TRIM(TO_VARCHAR(c.penalty_exposure_usd, '999,999,999')) || ' across ' || c.breaches_governed || ' suppliers',
         'MEASURED', 'V_CONTRACT_IMPACT' FROM ct c
  UNION ALL
  SELECT 9, 'Money', 'Penalties hidden by the legacy definition (breached, shown compliant)',
         '$' || TRIM(TO_VARCHAR(c.penalty_missed_by_legacy_usd, '999,999,999')) || ' across ' || c.hidden_breaches || ' suppliers',
         'MEASURED', 'V_CONTRACT_IMPACT' FROM ct c
  UNION ALL
  SELECT 10, 'Governance', 'Contracts measuring OTD with the non-governed definition',
         c.definition_conflicts || ' of ' || c.contracts, 'MEASURED', 'V_CONTRACT_IMPACT' FROM ct c
  UNION ALL
  SELECT 11, 'Time', 'Mean time to a governed, persona-scoped answer',
         ROUND(e.mean_latency_ms / 1000, 1) || ' s (p95 ' || ROUND(e.p95_latency_ms / 1000, 1) || ' s)', 'MEASURED', 'AGENT_EVAL_RUN' FROM ev e
  UNION ALL
  SELECT 12, 'Time', 'Manual reconciliation of a disputed cross-team metric (baseline)',
         b.manual_reconciliation_hours || ' h', 'ASSUMPTION', 'replace with your own figure' FROM baseline b
  UNION ALL
  SELECT 13, 'Time', 'Speed-up versus the manual baseline',
         ROUND(b.manual_reconciliation_hours * 3600000 / NULLIF(e.mean_latency_ms, 0)) || 'x faster',
         'ASSUMPTION', 'row 11 measured / row 12 assumed' FROM ev e, baseline b
)
ORDER BY ord;

GRANT SELECT ON VIEW V_IMPACT_SCORECARD TO ROLE SC_PLANNER;
GRANT SELECT ON VIEW V_IMPACT_SCORECARD TO ROLE SC_PROCUREMENT;
GRANT SELECT ON VIEW V_IMPACT_SCORECARD TO ROLE SC_LOGISTICS;
GRANT SELECT ON VIEW V_IMPACT_SCORECARD TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON VIEW V_IMPACT_SCORECARD TO ROLE SC_ONTOLOGY_STEWARD;

SELECT * FROM V_IMPACT_SCORECARD;
