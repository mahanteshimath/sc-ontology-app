-- ---------------------------------------------------------------------------
-- 92 — Data-shape verification.
--
-- Asserts the properties the application, its tests and its narrative depend on.
-- Each of these has a specific failure mode attached, which is why it is checked
-- rather than trusted.
--
-- Read-only. Run after 00a-00f.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. Row counts.
-- ---------------------------------------------------------------------------

WITH c AS (
  SELECT 'RAW.PO_RECEIPT_LINE'              AS object_name, COUNT(*) AS n, 420000  AS expected FROM SUPPLY_CHAIN.RAW.PO_RECEIPT_LINE
  UNION ALL SELECT 'RAW.SALES_ORDER_LINE',       COUNT(*), 1500000 FROM SUPPLY_CHAIN.RAW.SALES_ORDER_LINE
  UNION ALL SELECT 'RAW.SHIPMENT_COST',          COUNT(*), 1480499 FROM SUPPLY_CHAIN.RAW.SHIPMENT_COST
  UNION ALL SELECT 'RAW.INVENTORY_POSITION',     COUNT(*), 137088  FROM SUPPLY_CHAIN.RAW.INVENTORY_POSITION
  UNION ALL SELECT 'RAW.PRODUCTION_ORDER',       COUNT(*), 240000  FROM SUPPLY_CHAIN.RAW.PRODUCTION_ORDER
  UNION ALL SELECT 'RAW.DEMAND_FORECAST',        COUNT(*), 52000   FROM SUPPLY_CHAIN.RAW.DEMAND_FORECAST
  UNION ALL SELECT 'RAW.DATE_DIM',               COUNT(*), 1096    FROM SUPPLY_CHAIN.RAW.DATE_DIM
  UNION ALL SELECT 'RAW.PART',                   COUNT(*), 2000    FROM SUPPLY_CHAIN.RAW.PART
  UNION ALL SELECT 'RAW.SUPPLIER',               COUNT(*), 300     FROM SUPPLY_CHAIN.RAW.SUPPLIER
  UNION ALL SELECT 'RAW.CUSTOMER',               COUNT(*), 1200    FROM SUPPLY_CHAIN.RAW.CUSTOMER
  UNION ALL SELECT 'RAW.NODE',                   COUNT(*), 24      FROM SUPPLY_CHAIN.RAW.NODE
  UNION ALL SELECT 'RAW.CARRIER',                COUNT(*), 8       FROM SUPPLY_CHAIN.RAW.CARRIER
  UNION ALL SELECT 'RAW.LANE',                   COUNT(*), 96      FROM SUPPLY_CHAIN.RAW.LANE
  UNION ALL SELECT 'RAW.GEO_NODE',               COUNT(*), 24      FROM SUPPLY_CHAIN.RAW.GEO_NODE
  UNION ALL SELECT 'RAW.GEO_REGION_HUB',         COUNT(*), 4       FROM SUPPLY_CHAIN.RAW.GEO_REGION_HUB
  UNION ALL SELECT 'RAW.GEO_CHOKEPOINT',         COUNT(*), 5       FROM SUPPLY_CHAIN.RAW.GEO_CHOKEPOINT
  UNION ALL SELECT 'RAW.GEO_LANE',               COUNT(*), 96      FROM SUPPLY_CHAIN.RAW.GEO_LANE
  UNION ALL SELECT 'GOVERNANCE.NETWORK_RISK_SCENARIO', COUNT(*), 1 FROM SUPPLY_CHAIN.GOVERNANCE.NETWORK_RISK_SCENARIO
  UNION ALL SELECT 'CANONICAL.FCT_SUPPLIER_DELIVERY_LINE',  COUNT(*), 420000  FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
  UNION ALL SELECT 'CANONICAL.FCT_ORDER_LINE_FULFILLMENT',  COUNT(*), 1500000 FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
  UNION ALL SELECT 'CANONICAL.FCT_LANDED_COST_SHIPMENT',    COUNT(*), 1480499 FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT
  UNION ALL SELECT 'CANONICAL.FCT_INVENTORY_SNAPSHOT',      COUNT(*), 137088  FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
  UNION ALL SELECT 'CANONICAL.FCT_REQUISITION_LINE',        COUNT(*), 420000  FROM SUPPLY_CHAIN.CANONICAL.FCT_REQUISITION_LINE
)
SELECT object_name, n AS found, expected, IFF(n = expected, 'PASS', 'FAIL') AS verdict
FROM c ORDER BY object_name;

-- Scenario lane coverage is derived from the synthetic lane population. Require
-- at least one impact rather than freezing a generated count into this contract.
SELECT
  'simulated network-risk lane impacts' AS check_name,
  COUNT(*) AS found,
  1 AS expected_minimum,
  IFF(COUNT(*) >= 1, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.SCENARIO_LANE_IMPACT
WHERE scenario_id = 'SCN-HORMUZ-001';

-- ---------------------------------------------------------------------------
-- 2. Inventory snapshot cardinality. EXACTLY 24 MONTH-END DATES.
--
-- The most consequential shape assertion in this file. A snapshot is a balance,
-- not a flow. If daily snapshots were emitted instead of month-end ones, a
-- perfectly reasonable-looking SUM(inventory_value) over a quarter would return a
-- figure roughly ninety times the truth, and nothing in the UI would look wrong.
-- The 24 dates are what make "select the latest snapshot in the period" a
-- well-defined instruction.
-- ---------------------------------------------------------------------------

SELECT
  'distinct inventory snapshot dates' AS check_name,
  COUNT(DISTINCT snapshot_date)       AS found,
  24                                  AS expected,
  MIN(snapshot_date)::STRING          AS first_snapshot,
  MAX(snapshot_date)::STRING          AS last_snapshot,
  IFF(COUNT(DISTINCT snapshot_date) = 24
      AND MIN(snapshot_date) = DATE '2024-10-31'
      AND MAX(snapshot_date) = DATE '2026-09-30', 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT;

SELECT
  'every snapshot date is a month end' AS check_name,
  COUNT(*)                            AS non_month_end_dates,
  0                                   AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM (SELECT DISTINCT snapshot_date FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT)
WHERE snapshot_date <> LAST_DAY(snapshot_date);

-- The snapshot series must not run ahead into the future window that the receipt
-- and delivery facts deliberately occupy.
--
-- The bound is the end of the CURRENT month, not today. The last snapshot is
-- 2026-09-30 while today is 2026-09-20, so the current month's close is dated a
-- few days ahead -- and that is intended: 02_as_of_rule.sql states that inventory
-- snapshots stop at 2026-09-30 and therefore need no future-row exclusion, and the
-- 24-date contract depends on September being present.
--
-- An earlier version of this check used CURRENT_DATE() and failed all 5,712 rows
-- of the September close. That assertion was wrong, not the data: it would have
-- forced the series back to 23 dates, contradicting both 02 and the snapshot
-- cardinality check above. What genuinely must not happen is a snapshot in
-- October or November 2026, which would put a balance inside the future window.
SELECT
  'no inventory snapshot beyond the current month end' AS check_name,
  COUNT(*)                              AS found,
  0                                     AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
WHERE snapshot_date > LAST_DAY(CURRENT_DATE());

-- Balanced panel: every material-node pair present at every snapshot. A ragged
-- panel would make a month-over-month comparison of days-of-inventory move for
-- reasons of coverage rather than of stock.
SELECT
  'inventory panel is balanced' AS check_name,
  COUNT(DISTINCT pairs)         AS distinct_pair_counts_per_date,
  1                             AS expected,
  IFF(COUNT(DISTINCT pairs) = 1, 'PASS', 'FAIL') AS verdict
FROM (
  SELECT snapshot_date, COUNT(*) AS pairs
  FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
  GROUP BY snapshot_date
);

-- ---------------------------------------------------------------------------
-- 3. Date span and the future-dated share.
--
-- ~2.8% of receipt and delivery rows must fall after today. 02_as_of_rule.sql
-- records the rule that excludes them and scripts/probe-asof.mjs asserts the
-- effect is observable. If the share were zero the as-of rule would be untestable;
-- if it were the 8.4% a uniform spread produces, several recent months would read
-- as catastrophic failures rather than as incomplete periods.
--
-- Tolerance is 2.5%-3.1%, which is wide enough for hash-bucket granularity and
-- narrow enough to catch a switch to a uniform distribution.
-- ---------------------------------------------------------------------------

WITH f AS (
  SELECT
    MIN(receipt_date) AS lo, MAX(receipt_date) AS hi,
    AVG(IFF(receipt_date > DATE '2026-09-20', 1, 0)) AS future_share
  FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
)
SELECT
  'inbound receipts: span and future share' AS check_name,
  lo::STRING AS first_event, hi::STRING AS last_event,
  ROUND(future_share, 5) AS future_share,
  IFF(lo = DATE '2024-10-03' AND hi = DATE '2026-11-25'
      AND future_share BETWEEN 0.025 AND 0.031, 'PASS', 'FAIL') AS verdict
FROM f;

WITH f AS (
  SELECT
    MIN(delivery_date) AS lo, MAX(delivery_date) AS hi,
    AVG(IFF(delivery_date > DATE '2026-09-20', 1, 0)) AS future_share
  FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
)
SELECT
  'outbound deliveries: span and future share' AS check_name,
  lo::STRING AS first_event, hi::STRING AS last_event,
  ROUND(future_share, 5) AS future_share,
  IFF(lo = DATE '2024-10-03' AND hi = DATE '2026-11-25'
      AND future_share BETWEEN 0.025 AND 0.031, 'PASS', 'FAIL') AS verdict
FROM f;

-- A future-dated row must never be recorded as late. A promise that has not come
-- due cannot have been missed, and treating it as a miss would be the single
-- largest source of a wrong number on the dashboard.
SELECT
  'no future-dated row is marked late' AS check_name,
  COUNT(*) AS found, 0 AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
WHERE delivery_date > DATE '2026-09-20' AND is_on_time = 0;

-- ---------------------------------------------------------------------------
-- 4. Flag hierarchy integrity.
--
-- IS_OTIF must equal IS_ON_TIME AND IS_IN_FULL, and IS_PERFECT_ORDER must equal
-- IS_OTIF AND IS_CDDA_MET. These are stored separately so that one table can serve
-- a different exception predicate per metric, and stored flags can disagree with
-- their own definitions -- which would make OTIF exceed OTD and turn the metric
-- hierarchy on the operations page into nonsense.
-- ---------------------------------------------------------------------------

SELECT 'IS_OTIF = ON_TIME AND IN_FULL' AS check_name,
       COUNT(*) AS violations, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
WHERE is_otif <> (is_on_time * is_in_full);

SELECT 'IS_PERFECT_ORDER = OTIF AND CDDA' AS check_name,
       COUNT(*) AS violations, 0 AS expected,
       IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
WHERE is_perfect_order <> (is_otif * is_cdda_met);

-- Ordering follows from the above, and is what the operations page displays.
WITH m AS (
  SELECT AVG(is_on_time) AS otd, AVG(is_in_full) AS fill,
         AVG(is_otif) AS otif, AVG(is_perfect_order) AS perfect
  FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
)
SELECT 'perfect <= OTIF <= min(OTD, fill)' AS check_name,
       ROUND(otd,6) AS otd, ROUND(fill,6) AS fill_rate,
       ROUND(otif,6) AS otif, ROUND(perfect,6) AS perfect_order,
       IFF(perfect <= otif AND otif <= LEAST(otd, fill), 'PASS', 'FAIL') AS verdict
FROM m;

-- ---------------------------------------------------------------------------
-- 5. Every exception rule actually selects rows.
--
-- A predicate that matches nothing produces a drill-down that is permanently
-- empty: the metric looks explainable and is not. This already caught a real
-- defect -- days-of-inventory used a uniform cover distribution capped below 60
-- days while the rule selects positions above 60, so it matched zero of 137,088
-- rows. See the header of 00c.
-- ---------------------------------------------------------------------------

SELECT 'supplier_otd_pct exceptions'       AS rule_name, COUNT(*) AS exception_rows, IFF(COUNT(*) > 0,'PASS','FAIL') AS verdict FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE WHERE IS_ON_TIME = 0
UNION ALL SELECT 'supplier_fill_rate exceptions',  COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE WHERE RECEIVED_QTY < ORDERED_QTY
UNION ALL SELECT 'ppv exceptions',                 COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE WHERE EXTENDED_PRICE_VARIANCE > 0
UNION ALL SELECT 'otd_pct exceptions',             COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT WHERE IS_ON_TIME = 0
UNION ALL SELECT 'otif_pct exceptions',            COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT WHERE IS_OTIF = 0
UNION ALL SELECT 'fill_rate_pct exceptions',       COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT WHERE SHIPPED_QTY < ORDERED_QTY
UNION ALL SELECT 'perfect_order_pct exceptions',   COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT WHERE IS_PERFECT_ORDER = 0
UNION ALL SELECT 'freight_bill_variance exceptions',COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT WHERE FREIGHT_BILL_VAR_AMT > 0
UNION ALL SELECT 'landed_cost_per_unit exceptions', COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT WHERE SHIPPED_QTY > 0 AND TOTAL_LANDED_COST / SHIPPED_QTY > 15
UNION ALL SELECT 'days_of_inventory exceptions',   COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT WHERE AVG_DAILY_DEMAND > 0 AND ON_HAND_QTY / AVG_DAILY_DEMAND > 60
UNION ALL SELECT 'inventory_value_usd exceptions', COUNT(*), IFF(COUNT(*) > 0,'PASS','FAIL') FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT WHERE IS_STOCKED_OUT = 1 OR ON_HAND_QTY < SAFETY_STOCK
ORDER BY rule_name;

-- ---------------------------------------------------------------------------
-- 6. Metric values sit near their thresholds.
--
-- Not a correctness check -- a usefulness one. A target the data never approaches
-- leaves the red/amber/green logic in the application permanently untested and
-- silently broken. Each of these was tuned in 00c to land in the band that
-- exercises both the warn and the fail comparison.
-- ---------------------------------------------------------------------------

WITH v AS (
  SELECT
    (SELECT AVG(is_on_time) FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE) AS supplier_otd,
    (SELECT AVG(is_on_time) FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT) AS otd,
    (SELECT SUM(total_landed_cost)/NULLIF(SUM(shipped_qty),0) FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT) AS lcpu,
    (SELECT SUM(on_hand_qty)/NULLIF(SUM(avg_daily_demand),0) FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT)) AS doi,
    (SELECT SUM(extended_price_variance) FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE) AS ppv
)
SELECT 'supplier OTD between fail 0.85 and target 0.90' AS check_name, ROUND(supplier_otd,6) AS value,
       IFF(supplier_otd BETWEEN 0.85 AND 0.90, 'PASS','FAIL') AS verdict FROM v
UNION ALL
SELECT 'customer OTD below target 0.95', ROUND(otd,6),
       IFF(otd < 0.95, 'PASS','FAIL') FROM v
UNION ALL
SELECT 'landed cost per unit in the amber band (10.00-10.50)', ROUND(lcpu,4),
       IFF(lcpu BETWEEN 10.00 AND 10.50, 'PASS','FAIL') FROM v
UNION ALL
SELECT 'days of inventory in the amber band (30-35)', ROUND(doi,4),
       IFF(doi BETWEEN 30 AND 35, 'PASS','FAIL') FROM v
UNION ALL
SELECT 'PPV nets unfavourable (positive)', ROUND(ppv,2),
       IFF(ppv > 0, 'PASS','FAIL - the exception list is not worth chasing if the aggregate is favourable') FROM v;
