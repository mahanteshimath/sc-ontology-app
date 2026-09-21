-- ---------------------------------------------------------------------------
-- Phase 3 — Governed targets and thresholds.
--
-- METRIC_DEFINITION already carried DIRECTION (higher / lower / to zero), which
-- says which way is good but never said what good is. Without a target the app
-- could only describe the data, not judge it.
--
-- Two deliberate decisions:
--
-- 1. TARGETS ARE ILLUSTRATIVE. These are not committed 3M business targets. They
--    are plausible values seeded so the red/amber/green logic is exercised
--    against real data, and every row says so in TARGET_SOURCE. Replace them
--    with the real commitments before anyone makes a decision on this screen.
--
-- 2. ABSOLUTE-DOLLAR METRICS GET NO TARGET, ON PURPOSE. Freight cost, freight
--    invoiced, landed cost, inventory value, PPV and freight bill variance all
--    scale with volume and with the length of the reporting period. A fixed
--    dollar threshold would turn "we shipped more this quarter" into a red
--    light, which is worse than no light at all. They are left NULL and the app
--    renders them without a target rather than inventing one. To make these
--    judgeable they would need to be normalised first (per unit, per shipment,
--    or as a percentage of accrued freight) and registered as their own metric.
--
-- Threshold semantics, interpreted against DIRECTION:
--   higher-is-better: value >= target is green, >= warn is amber, < fail is red
--   lower-is-better:  value <= target is green, <= warn is amber, > fail is red
--   to zero:          judged on |value| against |warn| and |fail|
-- ---------------------------------------------------------------------------

-- Rate and ratio metrics: period-independent, so a fixed threshold is meaningful.
UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.90, warn_threshold = 0.87, fail_threshold = 0.85,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_PROCUREMENT_ANALYST.'
WHERE metric_id = 'supplier_otd_pct';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.98, warn_threshold = 0.97, fail_threshold = 0.95,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_PROCUREMENT_ANALYST.'
WHERE metric_id = 'supplier_fill_rate';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.95, warn_threshold = 0.92, fail_threshold = 0.90,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.'
WHERE metric_id = 'otd_pct';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.90, warn_threshold = 0.85, fail_threshold = 0.80,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.'
WHERE metric_id = 'otif_pct';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.98, warn_threshold = 0.97, fail_threshold = 0.95,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.'
WHERE metric_id = 'fill_rate_pct';

UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 0.85, warn_threshold = 0.80, fail_threshold = 0.75,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.'
WHERE metric_id = 'perfect_order_pct';

-- Days of inventory: a duration, independent of volume and period length.
UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 30, warn_threshold = 35, fail_threshold = 40,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_PLANNING_ANALYST.'
WHERE metric_id = 'days_of_inventory';

-- Landed cost per unit: already normalised per unit, so comparable across periods.
UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = 10.00, warn_threshold = 10.50, fail_threshold = 11.00,
  target_source = 'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.'
WHERE metric_id = 'landed_cost_per_unit';

-- Absolute-dollar metrics: explicitly no target, with the reason recorded.
UPDATE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION SET
  target_value = NULL, warn_threshold = NULL, fail_threshold = NULL,
  target_source = 'NO TARGET BY DESIGN - an absolute dollar amount that scales with volume and with the length of the reporting period, so a fixed threshold would misreport growth as a failure. Normalise it (per unit, per shipment, or as a share of accrued freight) and register that as its own metric before setting a target.'
WHERE metric_id IN (
  'freight_cost_usd', 'freight_invoiced_usd', 'freight_bill_variance_usd',
  'landed_cost_usd', 'inventory_value_usd', 'ppv'
);
