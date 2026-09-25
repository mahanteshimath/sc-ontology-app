-- ---------------------------------------------------------------------------
-- 13 — What the divergence actually costs.
--
-- The negative control records a spread of 0.006807 on supplier on-time
-- delivery. On its own that is a number, not a consequence: two thirds of a
-- percentage point sounds like rounding, and a judge or a steward is entitled to
-- ask why anyone should care.
--
-- This file answers that question by MEASUREMENT rather than by assertion. It
-- replays both definitions at supplier grain and asks the only question the
-- business actually acts on: does this supplier meet the governed target?
--
-- THE FINDING, AND WHY IT IS WORSE THAN THE HEADLINE SPREAD SUGGESTS
--
--   * 54 of 300 suppliers genuinely meet the 0.90 target under the governed,
--     line-weighted definition.
--   * The legacy average-of-averages definition reports 66 of them as meeting it.
--   * So 12 suppliers -- 22% of the compliant list -- are handed a pass they did
--     not earn.
--   * The error is ENTIRELY ONE-DIRECTIONAL: 12 false passes, 0 false fails.
--
-- That last line is the point. A defect that wrongly escalated a supplier would
-- be found within a week, because the supplier would dispute it and someone
-- would recheck the arithmetic. A defect that wrongly clears a supplier
-- generates no complaint from anyone, so it survives indefinitely. The cost of
-- an ungoverned metric is not a wrong dashboard; it is a review that never
-- happens.
--
-- SCOPE AND FRAMING. The target is ILLUSTRATIVE, the same convention as
-- sql/03_targets.sql, and the data is synthetic. What is NOT illustrative is the
-- arithmetic: these counts are computed from the same 420,000 receipt lines the
-- governed metric is defined over, against whatever target the registry
-- currently holds. Change the target and the counts recompute; they are not
-- stored.
--
-- WHY A VIEW AND NOT A FIGURE IN THE README. A number written in prose is a
-- number that stops being true the day the data changes. This reads the target
-- from METRIC_DEFINITION and the rates from the canonical fact, so the page can
-- only ever show what is currently the case.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

-- One row per supplier: the same population, scored by both definitions.
--
-- The legacy side reads V_SUPPLIER_OTD_BY_MONTH -- the very view the negative
-- control is built on -- rather than re-deriving the defect here. Re-deriving it
-- would be a second implementation of the bug, free to drift from the one that
-- is actually bound in METRIC_BINDING, and the whole subject of this project is
-- what happens when one definition is expressed twice.
CREATE OR REPLACE VIEW V_SUPPLIER_OTD_VERDICT
  COMMENT = 'Every supplier scored twice: once by the governed line-weighted definition, once by the legacy average-of-averages defect, against the registry target. MISCLASSIFIED marks suppliers the two definitions disagree about.'
AS
WITH tgt AS (
  SELECT target_value
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
   WHERE metric_id = 'supplier_otd_pct'
),
scored AS (
  SELECT
    m.supplier_id,
    m.supplier_name,
    m.supplier_region,
    COUNT(*)                                          AS months_observed,
    SUM(m.line_count)                                 AS receipt_lines,
    -- Governed: every receipt line counts once. Reconstituted from the monthly
    -- pre-aggregate by re-applying the weight the defect discards.
    SUM(m.otd_rate * m.line_count) / NULLIF(SUM(m.line_count), 0) AS governed_otd,
    -- Defective: every supplier-month counts once, whatever its size.
    AVG(m.otd_rate)                                   AS legacy_otd
  FROM SUPPLY_CHAIN.CANONICAL.V_SUPPLIER_OTD_BY_MONTH m
  GROUP BY m.supplier_id, m.supplier_name, m.supplier_region
)
SELECT
  s.supplier_id,
  s.supplier_name,
  s.supplier_region,
  s.months_observed,
  s.receipt_lines,
  s.governed_otd,
  s.legacy_otd,
  s.legacy_otd - s.governed_otd                   AS overstatement,
  t.target_value                                  AS target,
  s.governed_otd >= t.target_value                AS meets_target_governed,
  s.legacy_otd   >= t.target_value                AS meets_target_legacy,
  (s.governed_otd >= t.target_value) <> (s.legacy_otd >= t.target_value) AS misclassified,
  CASE
    WHEN s.legacy_otd >= t.target_value AND s.governed_otd < t.target_value THEN 'FALSE_PASS'
    WHEN s.legacy_otd <  t.target_value AND s.governed_otd >= t.target_value THEN 'FALSE_FAIL'
    ELSE 'AGREE'
  END                                             AS verdict_class
FROM scored s
CROSS JOIN tgt t;

-- The one-row summary the application renders. Kept separate from the per-supplier
-- view so a page showing the headline does not have to aggregate it itself --
-- app-layer arithmetic over a governed number is the failure mode this repository
-- exists to remove.
CREATE OR REPLACE VIEW V_DIVERGENCE_IMPACT
  COMMENT = 'Consequence of the supplier-OTD divergence, in decisions rather than decimal places. Recomputed from the registry target and the canonical fact on every read.'
AS
SELECT
  COUNT(*)                                          AS suppliers,
  MAX(target)                                       AS target,
  SUM(receipt_lines)                                AS receipt_lines,
  COUNT_IF(meets_target_governed)                   AS at_target_governed,
  COUNT_IF(meets_target_legacy)                     AS at_target_legacy,
  COUNT_IF(verdict_class = 'FALSE_PASS')            AS false_passes,
  COUNT_IF(verdict_class = 'FALSE_FAIL')            AS false_fails,
  COUNT_IF(misclassified)                           AS misclassified,
  ROUND(COUNT_IF(misclassified) / NULLIF(COUNT(*), 0), 6)                          AS misclassified_share,
  -- How badly the compliant list is inflated. This, not the raw spread, is the
  -- figure a procurement lead would act on.
  ROUND((COUNT_IF(meets_target_legacy) - COUNT_IF(meets_target_governed))
        / NULLIF(COUNT_IF(meets_target_governed), 0), 6)                            AS compliant_list_inflation,
  ROUND(AVG(overstatement), 6)                      AS mean_overstatement,
  ROUND(MAX(overstatement), 6)                      AS max_overstatement
FROM SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_OTD_VERDICT;

-- Assertions. Repeated in 90_verify_base.sql.
--
-- The one-directional claim is asserted rather than described: if a future data
-- change ever produces a false FAIL, the narrative above stops being true and
-- the build should say so instead of leaving a stale sentence on the page.
SELECT 'divergence impact is one-directional (no false fails)' AS check_name,
       false_fails,
       IFF(false_fails = 0, 'PASS', 'FAIL') AS status
  FROM V_DIVERGENCE_IMPACT;

SELECT 'the defect misclassifies at least one supplier' AS check_name,
       misclassified,
       IFF(misclassified > 0, 'PASS', 'FAIL') AS status
  FROM V_DIVERGENCE_IMPACT;
