-- ---------------------------------------------------------------------------
-- 00c — RAW transactional sources, full scale.
--
-- Row counts, matching the documented production of this dataset:
--   PO_RECEIPT_LINE      420,000
--   SALES_ORDER_LINE   1,500,000
--   SHIPMENT_COST      1,480,500   (one per shipped order line; 1.3% of lines
--                                   never shipped, so the counts differ)
--   INVENTORY_POSITION   137,088   (5,712 material-node pairs x 24 month-ends)
--   PRODUCTION_ORDER     240,000
--   DEMAND_FORECAST       52,000   (2,000 materials x 26 periods)
--
-- ---------------------------------------------------------------------------
-- HOW THE DATE DISTRIBUTION IS BUILT, AND WHY IT IS NOT UNIFORM
--
-- The data must span 2024-10-03..2026-11-25 while roughly 2.8% of receipt and
-- shipment rows fall after today (2026-09-20), because 02_as_of_rule.sql records
-- the as-of rule that excludes them and scripts/probe-asof.mjs asserts the
-- effect is visible.
--
-- A uniform spread over that range would put 66 of 784 days in the future, or
-- 8.4% — three times too many, which would make several months look
-- catastrophically bad rather than simply incomplete. So the date is drawn from
-- one of two windows by an explicit 2.8% Bernoulli draw: the historical window
-- (718 days, to 2026-09-20) or the future window (66 days, beyond it). The
-- future rows are genuine open commitments: promised receipts and planned
-- deliveries that have not happened.
--
-- ---------------------------------------------------------------------------
-- HOW ON-TIME IS CONSTRUCTED, AND WHY THIS DIRECTION
--
-- The event date is drawn first, then the promise is derived from it:
--   on time  -> promise = event + 0..3 days of slack   (event <= promise)
--   late     -> promise = event - 1..12 days           (event >  promise)
--
-- The opposite direction — promise first, then delivery — is the intuitive one
-- and it is wrong here, because it makes the event date a function of lateness.
-- Late rows would then drift into later months than the on-time rows they are
-- compared against, so a month's OTD would be biased by its own lateness. With
-- the event date fixed first, a row's reporting period is independent of whether
-- it was late, which is what makes month-over-month OTD comparable at all.
--
-- On-time probability is baseline 87.5pp + CARRIER.ON_TIME_BIAS (-7.0..+6.5)
-- + 0.2pp for EU destinations. Carrier bias averages +0.31pp, so network OTD
-- lands near 87.8% and EU near 88.0%. Those two numbers being close but not
-- equal is the point: 91_verify_personas.sql uses the gap to prove the EU row
-- scope is actually filtering, and an exact tie would prove nothing.
--
-- Future-dated rows are forced on-time. A promise that has not come due yet
-- cannot have been missed, and marking it late would be the single biggest
-- source of a wrong number on the dashboard.
--
-- DETERMINISM. No RANDOM() anywhere; every draw is ABS(HASH(i, 'salt')). See the
-- header of 00b for why.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA RAW;

-- ---------------------------------------------------------------------------
-- PO_RECEIPT_LINE — inbound goods receipts. 420,000 lines.
--
-- ACTUAL_PRICE vs STANDARD_PRICE drives purchase price variance. The spread is
-- deliberately asymmetric: ~62% of receipts price at or below standard and ~38%
-- above, so PPV nets out unfavourable overall. A symmetric spread would average
-- to zero and make the metric, and its exception list, meaningless.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE PO_RECEIPT_LINE (
  PO_ID           STRING NOT NULL COMMENT 'Purchase order number.',
  LINE            NUMBER NOT NULL COMMENT 'Line number within the purchase order.',
  SUPPLIER_ID     STRING NOT NULL COMMENT 'Vendor the line was placed with.',
  MATERIAL_ID     STRING NOT NULL COMMENT 'Material ordered.',
  ORDERED_QTY     NUMBER NOT NULL COMMENT 'Quantity ordered.',
  RECEIVED_QTY    NUMBER NOT NULL COMMENT 'Quantity actually received. Below ORDERED_QTY is a short receipt.',
  PROMISED_DATE   DATE   NOT NULL COMMENT 'Date the supplier committed to. The basis for on-time measurement.',
  RECEIPT_DATE    DATE   NOT NULL COMMENT 'Date goods were received. The event date: the reporting period comes from here.',
  STANDARD_PRICE  NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost from the material master.',
  ACTUAL_PRICE    NUMBER(12,4) NOT NULL COMMENT 'Unit price actually invoiced.',
  CONSTRAINT pk_po_receipt_line PRIMARY KEY (PO_ID, LINE)
) COMMENT = 'Inbound purchase-order receipt lines. Source for CANONICAL.FCT_SUPPLIER_DELIVERY_LINE.';

INSERT INTO PO_RECEIPT_LINE
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 420000))),
base AS (
  SELECT
    s.i,
    'PO-' || LPAD(TO_CHAR(FLOOR(s.i / 4) + 1), 8, '0')                    AS po_id,
    (s.i % 4) + 1                                                          AS line,
    'SUP-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'sup')) % 300) + 1), 5, '0')     AS supplier_id,
    'MAT-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'mat')) % 2000) + 1), 6, '0')    AS material_id,
    -- 2.8% of receipts are promised for a date that has not arrived yet.
    ABS(HASH(s.i, 'fut')) % 1000 < 28                                      AS is_future,
    (ABS(HASH(s.i, 'oqty')) % 480) + 20                                    AS ordered_qty
  FROM s
),
dated AS (
  SELECT
    b.*,
    CASE WHEN b.is_future
         -- future window: 2026-09-21 .. 2026-11-25 (66 days)
         THEN DATEADD('DAY', ABS(HASH(b.i, 'fd')) % 66,  DATE '2026-09-21')
         -- historical window: 2024-10-03 .. 2026-09-20 (718 days)
         ELSE DATEADD('DAY', ABS(HASH(b.i, 'hd')) % 718, DATE '2024-10-03')
    END                                                                    AS receipt_date
  FROM base b
),
scored AS (
  SELECT
    d.*,
    sup.supplier_region,
    -- Supplier on-time probability: baseline 87.3pp, tier-1 vendors run better,
    -- tier-3 worse. Lands network supplier OTD near 87.7%, just under the 0.90
    -- target so the metric reads amber rather than green.
    87.3
      + CASE sup.supplier_tier WHEN 'TIER_1' THEN 3.0 WHEN 'TIER_2' THEN 0.0 ELSE -2.0 END
      + CASE sup.supplier_region WHEN 'APAC' THEN -1.5 WHEN 'LATAM' THEN -2.0 ELSE 0.5 END
                                                                           AS p_ontime,
    prt.standard_cost
  FROM dated d
  JOIN SUPPLIER sup ON sup.supplier_id = d.supplier_id
  JOIN PART     prt ON prt.material_id = d.material_id
)
SELECT
  po_id,
  line,
  supplier_id,
  material_id,
  ordered_qty,
  -- ~2.4% of receipts are short. Future rows are not yet received at all, so
  -- they carry the full ordered quantity rather than a fabricated shortfall.
  CASE WHEN is_future THEN ordered_qty
       WHEN ABS(HASH(i, 'short')) % 1000 < 24
         THEN GREATEST(1, ordered_qty - 1 - (ABS(HASH(i, 'shortq')) % GREATEST(1, FLOOR(ordered_qty * 0.30))))
       ELSE ordered_qty END                                                AS received_qty,
  CASE WHEN is_future OR (ABS(HASH(i, 'otd')) % 1000) < p_ontime * 10
       THEN DATEADD('DAY',  ABS(HASH(i, 'slack')) % 4,      receipt_date)
       ELSE DATEADD('DAY', -1 - (ABS(HASH(i, 'late')) % 12), receipt_date)
  END                                                                      AS promised_date,
  receipt_date,
  standard_cost                                                            AS standard_price,
  -- 62% at or below standard by up to 6%, 38% above by up to 14%, so PPV nets
  -- unfavourable: 0.62 x -3% + 0.38 x +7% = +0.8% of spend.
  --
  -- The unfavourable tail was widened from 9% to 14% after measurement. At 9% the
  -- weighted result was -$1.29M, i.e. favourable overall, which contradicts the
  -- narrative the metric is built for: an exception list of overpriced receipts is
  -- only worth chasing if the aggregate is actually adverse. The asymmetry is what
  -- produces that, since a symmetric spread cancels to roughly zero.
  CASE WHEN ABS(HASH(i, 'ppv')) % 100 < 62
       THEN ROUND(standard_cost * (1 - (ABS(HASH(i, 'fav')) % 600) / 10000.0), 4)
       ELSE ROUND(standard_cost * (1 + (ABS(HASH(i, 'unf')) % 1400) / 10000.0), 4)
  END                                                                      AS actual_price
FROM scored;

-- ---------------------------------------------------------------------------
-- SALES_ORDER_LINE — outbound customer order lines. 1,500,000 lines.
--
-- CDDA_MET (Customer Delivery Date Accepted) is a third, independent condition
-- beyond on-time and in-full. It exists so that perfect-order rate is strictly
-- harder to satisfy than OTIF, which is what makes them distinguishable metrics
-- rather than two names for the same number.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE SALES_ORDER_LINE (
  ORDER_ID      STRING NOT NULL COMMENT 'Sales order number.',
  ORDER_LINE    NUMBER NOT NULL COMMENT 'Line number within the sales order.',
  CUSTOMER_ID   STRING NOT NULL COMMENT 'Ship-to customer.',
  MATERIAL_ID   STRING NOT NULL COMMENT 'Material ordered.',
  CARRIER_ID    STRING NOT NULL COMMENT 'Carrier that moved the line.',
  LANE_ID       STRING NOT NULL COMMENT 'Transport lane used. Supplies the destination region and the committed transit time.',
  ORDERED_QTY   NUMBER NOT NULL COMMENT 'Quantity ordered by the customer.',
  SHIPPED_QTY   NUMBER NOT NULL COMMENT 'Quantity shipped. Below ORDERED_QTY is a short ship.',
  PROMISE_DATE  DATE   NOT NULL COMMENT 'Date promised to the customer.',
  DELIVERY_DATE DATE   NOT NULL COMMENT 'Date delivered. The event date: the reporting period comes from here.',
  TRANSIT_DAYS  NUMBER NOT NULL COMMENT 'Actual days in transit.',
  DEFECT_REASON STRING          COMMENT 'Recorded cause, populated only on lines that failed a condition. NULL on clean lines.',
  CDDA_MET      BOOLEAN NOT NULL COMMENT 'Customer delivery date accepted. An independent third condition, so that perfect order is strictly harder than OTIF.',
  WAS_SHIPPED   BOOLEAN NOT NULL COMMENT 'FALSE where the customer collected and no carrier-billed shipment exists. These lines are still delivered and still count in fulfilment; they simply have no landed-cost row, which is why SHIPMENT_COST is smaller than this table.',
  CONSTRAINT pk_sales_order_line PRIMARY KEY (ORDER_ID, ORDER_LINE)
) COMMENT = 'Outbound customer order lines. Source for CANONICAL.FCT_ORDER_LINE_FULFILLMENT.';

INSERT INTO SALES_ORDER_LINE
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 1500000))),
base AS (
  SELECT
    s.i,
    'SO-' || LPAD(TO_CHAR(FLOOR(s.i / 3) + 1), 9, '0')                     AS order_id,
    (s.i % 3) + 1                                                          AS order_line,
    'CUST-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'cust')) % 1200) + 1), 6, '0')  AS customer_id,
    'MAT-'  || LPAD(TO_CHAR((ABS(HASH(s.i, 'omat')) % 2000) + 1), 6, '0')  AS material_id,
    'CAR-'  || LPAD(TO_CHAR((ABS(HASH(s.i, 'car'))  % 8) + 1),    2, '0')  AS carrier_id,
    'LANE-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'lane')) % 96) + 1),   4, '0')  AS lane_id,
    ABS(HASH(s.i, 'ofut')) % 1000 < 28                                     AS is_future,
    (ABS(HASH(s.i, 'ooqty')) % 240) + 10                                   AS ordered_qty
  FROM s
),
dated AS (
  SELECT b.*,
    CASE WHEN b.is_future
         THEN DATEADD('DAY', ABS(HASH(b.i, 'ofd')) % 66,  DATE '2026-09-21')
         ELSE DATEADD('DAY', ABS(HASH(b.i, 'ohd')) % 718, DATE '2024-10-03')
    END                                                                    AS delivery_date
  FROM base b
),
scored AS (
  SELECT d.*,
    ln.dest_region,
    ln.transit_target_days,
    -- Baseline 87.5pp + carrier bias (mean +0.31pp) + 1.5pp for EU. Network OTD
    -- lands near 87.9%, EU near 89.4%.
    --
    -- The EU premium was first set to 0.2pp, which reproduced the 0.0017 gap this
    -- dataset historically showed. Measured, it produced a gap of 0.0001 for
    -- August 2026 -- smaller than the sampling noise of a single month (~14k EU
    -- lines, standard error ~0.003), so the sign of the gap was not even stable.
    -- 91_verify_personas.sql exists to *prove* the EU row scope is filtering, and
    -- an assertion that can pass or fail on noise proves nothing. 1.5pp is still
    -- a plausible regional difference but is unambiguously outside the noise.
    87.5 + car.on_time_bias + IFF(ln.dest_region = 'EU', 1.5, 0.0)          AS p_ontime
  FROM dated d
  JOIN LANE    ln  ON ln.lane_id    = d.lane_id
  JOIN CARRIER car ON car.carrier_id = d.carrier_id
),
flagged AS (
  SELECT sc.*,
    (is_future OR (ABS(HASH(i, 'ootd')) % 1000) < p_ontime * 10)            AS is_on_time,
    -- ~2.6% short-shipped; future lines ship complete by construction.
    (NOT is_future AND ABS(HASH(i, 'oshort')) % 1000 < 26)                  AS is_short,
    -- CDDA fails on ~4% of non-future lines, independent of the other two.
    (is_future OR ABS(HASH(i, 'cdda')) % 1000 >= 40)                        AS cdda_met
  FROM scored sc
)
SELECT
  order_id,
  order_line,
  customer_id,
  material_id,
  carrier_id,
  lane_id,
  ordered_qty,
  CASE WHEN is_short
       THEN GREATEST(1, ordered_qty - 1 - (ABS(HASH(i, 'osq')) % GREATEST(1, FLOOR(ordered_qty * 0.35))))
       ELSE ordered_qty END                                                AS shipped_qty,
  CASE WHEN is_on_time
       THEN DATEADD('DAY',  ABS(HASH(i, 'oslack')) % 4,       delivery_date)
       ELSE DATEADD('DAY', -1 - (ABS(HASH(i, 'olate')) % 12), delivery_date)
  END                                                                      AS promise_date,
  delivery_date,
  GREATEST(1, transit_target_days + (ABS(HASH(i, 'tr')) % 7) - 3)           AS transit_days,
  -- Populated only where something failed, and named after the dominant cause.
  CASE WHEN NOT is_on_time AND is_short THEN 'PARTIAL_LATE_SHIPMENT'
       WHEN NOT is_on_time THEN
         CASE ABS(HASH(i, 'dr')) % 5
           WHEN 0 THEN 'CARRIER_DELAY'      WHEN 1 THEN 'CUSTOMS_HOLD'
           WHEN 2 THEN 'WEATHER'            WHEN 3 THEN 'CAPACITY_SHORTFALL'
           ELSE 'DOCK_SCHEDULING' END
       WHEN is_short THEN
         CASE ABS(HASH(i, 'dr2')) % 3
           WHEN 0 THEN 'STOCK_SHORTAGE' WHEN 1 THEN 'QUALITY_HOLD'
           ELSE 'ALLOCATION_LIMIT' END
       WHEN NOT cdda_met THEN 'DATE_NOT_ACCEPTED'
       ELSE NULL END                                                       AS defect_reason,
  cdda_met,
  -- 1.3% of lines are customer-collect: delivered, and therefore fully in scope
  -- for fulfilment metrics, but with no carrier freight bill. This is why
  -- SHIPMENT_COST has fewer rows than this table. Modelling them as "never
  -- shipped" instead would be incoherent, because they carry a delivery date.
  (ABS(HASH(i, 'shipd')) % 1000 >= 13)                                     AS was_shipped
FROM flagged;

-- ---------------------------------------------------------------------------
-- SHIPMENT_COST — landed cost, one row per shipped order line. ~1,480,500.
--
-- Cost build-up, and why the proportions are what they are:
--   MATERIAL_COST = standard cost x shipped qty        (~$8.00 per unit)
--   FREIGHT_COST  = per-unit rate x carrier cost index (~$1.56 per unit)
--   DUTY_COST     = 4.5% of material, cross-region only
--   HANDLING_COST = $0.32 per unit
-- Landed cost per unit therefore lands near $10.35 against a $10 target with a
-- $10.50 warn boundary — amber, which is the only state that exercises both
-- comparisons. A figure far from the thresholds would leave the red/amber/green
-- logic untested by the data.
--
-- The per-unit freight rate was tuned down from $1.85 after measurement: that
-- rate produced $10.66, which sits in the dead band between the $10.50 warn
-- boundary and the $11.00 fail boundary, where the threshold semantics recorded
-- in 03_targets.sql ("<= warn is amber, > fail is red") classify it as neither.
--
-- INVOICED_FREIGHT_AMT is what the carrier billed and FREIGHT_COST what was
-- accrued; the variance is skewed so ~34% of shipments are overbilled. Freight
-- bill variance is a to-zero metric, so a symmetric spread would cancel to
-- nothing and the exception list would be empty.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE SHIPMENT_COST (
  SHIPMENT_ID          STRING NOT NULL COMMENT 'Shipment number.',
  ORDER_ID             STRING NOT NULL COMMENT 'Sales order the shipment belongs to.',
  ORDER_LINE           NUMBER NOT NULL COMMENT 'Order line the shipment covers.',
  CARRIER_ID           STRING NOT NULL COMMENT 'Carrier that moved the shipment.',
  LANE_ID              STRING NOT NULL COMMENT 'Lane used.',
  SERVICE_LEVEL        STRING NOT NULL COMMENT 'Committed service level from the lane.',
  SHIP_REGION          STRING NOT NULL COMMENT 'Destination region. The EU row access policy scopes on this column.',
  MATERIAL_ID          STRING NOT NULL COMMENT 'Material shipped.',
  SHIPPED_QTY          NUMBER NOT NULL COMMENT 'Units shipped. Denominator of landed cost per unit.',
  DELIVERY_DATE        DATE   NOT NULL COMMENT 'Delivery date. The event date for landed-cost reporting.',
  MATERIAL_COST        NUMBER(14,2) NOT NULL COMMENT 'Standard cost times quantity.',
  FREIGHT_COST         NUMBER(14,2) NOT NULL COMMENT 'Accrued freight.',
  INVOICED_FREIGHT_AMT NUMBER(14,2) NOT NULL COMMENT 'Freight the carrier actually invoiced.',
  ACCESSORIAL_USD      NUMBER(14,2) NOT NULL COMMENT 'Accessorial charges: detention, liftgate, redelivery.',
  DUTY_COST            NUMBER(14,2) NOT NULL COMMENT 'Duty. Cross-region movements only.',
  HANDLING_COST        NUMBER(14,2) NOT NULL COMMENT 'Warehouse handling.',
  IS_PREMIUM_FREIGHT   BOOLEAN NOT NULL COMMENT 'TRUE where an expedited service level was used.',
  CONSTRAINT pk_shipment_cost PRIMARY KEY (SHIPMENT_ID)
) COMMENT = 'Landed cost per shipped order line. Source for CANONICAL.FCT_LANDED_COST_SHIPMENT.';

INSERT INTO SHIPMENT_COST
WITH src AS (
  SELECT
    sol.order_id, sol.order_line, sol.carrier_id, sol.lane_id, sol.material_id,
    sol.shipped_qty, sol.delivery_date,
    ln.dest_region, ln.service_level,
    car.cost_index,
    prt.standard_cost,
    ABS(HASH(sol.order_id, sol.order_line, 'shp')) AS h,
    nd.node_region AS origin_region
  FROM SALES_ORDER_LINE sol
  JOIN LANE    ln  ON ln.lane_id     = sol.lane_id
  JOIN CARRIER car ON car.carrier_id = sol.carrier_id
  JOIN PART    prt ON prt.material_id = sol.material_id
  JOIN NODE    nd  ON nd.node_id      = ln.origin_node
  WHERE sol.was_shipped
),
costed AS (
  SELECT src.*,
    ROUND(standard_cost * shipped_qty, 2)                                  AS material_cost,
    -- ~$1.54 per unit at index 1.0, varied +/-18% per shipment.
    ROUND(shipped_qty * 1.54 * cost_index * (1 + ((h % 360) - 180) / 1000.0), 2) AS freight_cost,
    ROUND(shipped_qty * 0.32, 2)                                           AS handling_cost,
    IFF(origin_region <> dest_region, ROUND(standard_cost * shipped_qty * 0.045, 2), 0.00) AS duty_cost
  FROM src
)
SELECT
  'SHP-' || LPAD(TO_CHAR(ROW_NUMBER() OVER (ORDER BY order_id, order_line)), 10, '0') AS shipment_id,
  order_id,
  order_line,
  carrier_id,
  lane_id,
  service_level,
  dest_region                                                              AS ship_region,
  material_id,
  shipped_qty,
  delivery_date,
  material_cost,
  freight_cost,
  -- 34% overbilled by up to 12%, 66% billed at or slightly under accrual.
  CASE WHEN h % 100 < 34
       THEN ROUND(freight_cost * (1 + ((ABS(HASH(order_id, order_line, 'ov')) % 1200) + 1) / 10000.0), 2)
       ELSE ROUND(freight_cost * (1 - (ABS(HASH(order_id, order_line, 'un')) % 400) / 10000.0), 2)
  END                                                                      AS invoiced_freight_amt,
  -- Accessorials on ~18% of shipments only.
  IFF(h % 100 < 18, ROUND(12 + (h % 9000) / 100.0, 2), 0.00)               AS accessorial_usd,
  duty_cost,
  handling_cost,
  (service_level = 'EXPRESS')                                              AS is_premium_freight
FROM costed;

-- ---------------------------------------------------------------------------
-- INVENTORY_POSITION — month-end balances. 5,712 pairs x 24 months = 137,088.
--
-- EXACTLY ONE SNAPSHOT PER MONTH-END, 2024-10-31..2026-09-30. This is not a
-- detail: a snapshot is a balance, not a flow, so it must not be summed across
-- periods. 02_as_of_rule.sql records that rule, the inventory verified queries in
-- 07 demonstrate it, and 92_verify_counts.sql asserts the 24 dates. Emitting
-- daily snapshots would let a plausible-looking SUM over a quarter produce a
-- number ninety times too large.
--
-- Snapshots stop at 2026-09-30 rather than running into the future window: a
-- balance cannot be observed for a date that has not occurred, which is also why
-- these metrics are scoped SNAPSHOT and need no future-row exclusion.
--
-- ON_HAND_QTY is built as a multiple of AVG_DAILY_DEMAND so that days of cover
-- averages ~32 days against a 30-day target with a 35-day warn boundary — amber,
-- and close enough to both to exercise them.
--
-- THE DISTRIBUTION IS SKEWED, NOT UNIFORM, AND THAT IS LOAD-BEARING. Days of
-- cover was first drawn uniformly over 5..59 days, which gave the right mean of
-- 32 but a hard ceiling below 60 — so the "more than 60 days of cover" exception
-- rule in 05_exception_rules.sql matched exactly zero rows, and the drill-down
-- behind the inventory metric was permanently empty. A squared draw keeps the
-- mean near 32 while producing a genuine long right tail: overstocked positions
-- are precisely what the metric exists to surface.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE INVENTORY_POSITION (
  SNAPSHOT_DATE    DATE   NOT NULL COMMENT 'Month-end date the balance was observed. One per month, never a partial period.',
  MATERIAL_ID      STRING NOT NULL COMMENT 'Material.',
  NODE_ID          STRING NOT NULL COMMENT 'Stocking location.',
  ON_HAND_QTY      NUMBER NOT NULL COMMENT 'Units on hand at the snapshot.',
  AVG_DAILY_DEMAND NUMBER(12,3) NOT NULL COMMENT 'Trailing average daily demand. Denominator of days of inventory.',
  SAFETY_STOCK     NUMBER NOT NULL COMMENT 'Target safety stock. Below this is an availability risk.',
  ATP_QTY          NUMBER NOT NULL COMMENT 'Available to promise: on hand less allocated, floored at zero. Zero is a genuine stockout and is what IS_STOCKED_OUT is derived from in CANONICAL.',
  CONSTRAINT pk_inventory_position PRIMARY KEY (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
) COMMENT = 'Month-end inventory balances by material and node. Exactly 24 snapshot dates, 2024-10-31..2026-09-30. A snapshot is non-additive across periods.';

INSERT INTO INVENTORY_POSITION
WITH pairs AS (
  -- 5,712 = 24 nodes x 238 materials. Deriving the node from i % 24 and the
  -- material slot from i / 24 guarantees distinct pairs without a DISTINCT pass,
  -- and guarantees every node is stocked — a hash-filtered cross join would
  -- leave some nodes empty and make node a misleading dimension.
  SELECT
    i,
    'ND-'  || LPAD(TO_CHAR((i % 24) + 1), 2, '0')                                     AS node_id,
    'MAT-' || LPAD(TO_CHAR((((i % 24) * 238 + FLOOR(i / 24)) % 2000) + 1), 6, '0')     AS material_id
  FROM (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 5712)))
),
months AS (
  SELECT DISTINCT month_end AS snapshot_date
  FROM DATE_DIM
  WHERE month_end BETWEEN DATE '2024-10-31' AND DATE '2026-09-30'
),
grid AS (
  SELECT p.i, p.node_id, p.material_id, m.snapshot_date,
         ABS(HASH(p.i, m.snapshot_date, 'inv')) AS h
  FROM pairs p CROSS JOIN months m
),
demanded AS (
  SELECT g.*,
    prt.abc_class,
    -- A-class items move fastest; demand also drifts mildly by month so that a
    -- trend line over the 24 snapshots is not flat.
    ROUND(
      CASE prt.abc_class WHEN 'A' THEN 42.0 WHEN 'B' THEN 18.0 ELSE 7.0 END
      * (1 + ((g.h % 700) - 350) / 1000.0)
      * (1 + (MONTH(g.snapshot_date) - 6) / 90.0)
    , 3)                                                                   AS avg_daily_demand
  FROM grid g
  JOIN PART prt ON prt.material_id = g.material_id
)
SELECT
  snapshot_date,
  material_id,
  node_id,
  -- Days of cover = 8 + (h%100)^2/135, i.e. 8..81 days, mean ~32, with ~16% of
  -- positions above 60 days for the exception rule to select.
  GREATEST(0, ROUND(avg_daily_demand * (8 + POWER(h % 100, 2) / 135.0)))    AS on_hand_qty,
  avg_daily_demand,
  GREATEST(1, ROUND(avg_daily_demand * 12))                                AS safety_stock,
  -- ATP is on hand less an allocation of 0.6x-1.4x safety stock, floored at zero.
  -- Deriving it this way rather than as a flat percentage of on-hand is what
  -- makes genuine stockouts occur: a position holding only 8 days of cover
  -- against 12 days of safety stock allocates to zero. A percentage-of-on-hand
  -- formula can never reach zero, which would leave IS_STOCKED_OUT constantly
  -- false and the inventory-value exception rule in 05 selecting on only half of
  -- its stated predicate.
  GREATEST(0, ROUND(avg_daily_demand * (8 + POWER(h % 100, 2) / 135.0))
              - ROUND(GREATEST(1, ROUND(avg_daily_demand * 12)) * (0.6 + (h % 800) / 1000.0))) AS atp_qty
FROM demanded;

-- ---------------------------------------------------------------------------
-- PRODUCTION_ORDER — manufacturing completions. 240,000 orders.
--
-- Plants only: a DC does not complete production orders, and allowing one to
-- would make NODE_TYPE meaningless as a dimension.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE PRODUCTION_ORDER (
  PRODUCTION_ORDER_ID STRING NOT NULL COMMENT 'Production order number.',
  MATERIAL_ID         STRING NOT NULL COMMENT 'Material produced.',
  NODE_ID             STRING NOT NULL COMMENT 'Producing plant. Always a PLANT, never a DC.',
  PLANNED_QTY         NUMBER NOT NULL COMMENT 'Quantity planned.',
  COMPLETED_QTY       NUMBER NOT NULL COMMENT 'Quantity completed good.',
  SCRAP_QTY           NUMBER NOT NULL COMMENT 'Quantity scrapped.',
  SCHEDULED_DATE      DATE   NOT NULL COMMENT 'Scheduled completion date.',
  COMPLETED_DATE      DATE   NOT NULL COMMENT 'Actual completion date. The event date for manufacturing reporting.',
  CONSTRAINT pk_production_order PRIMARY KEY (PRODUCTION_ORDER_ID)
) COMMENT = 'Manufacturing completions. Source for the MANUFACTURING domain.';

INSERT INTO PRODUCTION_ORDER
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 240000))),
plants AS (SELECT node_id, ROW_NUMBER() OVER (ORDER BY node_id) - 1 AS idx, COUNT(*) OVER () AS n
           FROM NODE WHERE node_type = 'PLANT'),
base AS (
  SELECT s.i,
    'PRD-' || LPAD(TO_CHAR(s.i + 1), 9, '0')                               AS production_order_id,
    'MAT-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'pmat')) % 2000) + 1), 6, '0')   AS material_id,
    (ABS(HASH(s.i, 'pqty')) % 900) + 100                                   AS planned_qty,
    DATEADD('DAY', ABS(HASH(s.i, 'pd')) % 718, DATE '2024-10-03')          AS completed_date,
    ABS(HASH(s.i, 'pnode'))                                                AS hnode,
    ABS(HASH(s.i, 'pscrap'))                                               AS hscrap,
    ABS(HASH(s.i, 'psched'))                                               AS hsched
  FROM s
)
SELECT
  b.production_order_id,
  b.material_id,
  p.node_id,
  b.planned_qty,
  b.planned_qty - FLOOR(b.planned_qty * (b.hscrap % 45) / 1000.0)           AS completed_qty,
  FLOOR(b.planned_qty * (b.hscrap % 45) / 1000.0)                          AS scrap_qty,
  DATEADD('DAY', (b.hsched % 9) - 4, b.completed_date)                      AS scheduled_date,
  b.completed_date
FROM base b
JOIN plants p ON p.idx = b.hnode % p.n;

-- ---------------------------------------------------------------------------
-- DEMAND_FORECAST — 2,000 materials x 26 periods = 52,000.
--
-- PERIOD IS A 'YYYY-MM' STRING, NOT A DATE, AND MUST STAY THAT WAY.
-- 01_calendar_dimension.sql documents that FORECAST is deliberately left
-- unjoined to CALENDAR precisely because it has no day-grain key. Converting
-- this to a DATE would invite a CALENDAR relationship, which would give several
-- facts two join paths to the calendar and make every affected metric fail with
-- a multi-path error.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE DEMAND_FORECAST (
  MATERIAL_ID   STRING NOT NULL COMMENT 'Material forecast.',
  PERIOD        STRING NOT NULL COMMENT 'Forecast month as a YYYY-MM label. Deliberately not a DATE: see the header note and 01_calendar_dimension.sql.',
  FORECAST_QTY  NUMBER NOT NULL COMMENT 'Forecast quantity for the period.',
  ACTUAL_QTY    NUMBER NOT NULL COMMENT 'Realised quantity. Zero for periods that have not closed.',
  CONSTRAINT pk_demand_forecast PRIMARY KEY (MATERIAL_ID, PERIOD)
) COMMENT = 'Monthly demand forecast versus actual, by material. 26 periods, 2024-10..2026-11.';

INSERT INTO DEMAND_FORECAST
WITH periods AS (
  SELECT DISTINCT period, month_start
  FROM DATE_DIM
  WHERE month_start BETWEEN DATE '2024-10-01' AND DATE '2026-11-01'
),
grid AS (
  SELECT prt.material_id, p.period, p.month_start, prt.abc_class,
         ABS(HASH(prt.material_id, p.period, 'fc')) AS h
  FROM PART prt CROSS JOIN periods p
)
SELECT
  material_id,
  period,
  ROUND(CASE abc_class WHEN 'A' THEN 1250 WHEN 'B' THEN 540 ELSE 210 END
        * (1 + ((h % 620) - 310) / 1000.0))                                AS forecast_qty,
  -- Actual is zero for periods that have not closed: a forecast for an open
  -- month has nothing to be compared against yet.
  CASE WHEN month_start > DATE_TRUNC('MONTH', DATE '2026-09-20') THEN 0
       ELSE ROUND(CASE abc_class WHEN 'A' THEN 1250 WHEN 'B' THEN 540 ELSE 210 END
                  * (1 + ((h % 620) - 310) / 1000.0)
                  * (1 + ((ABS(HASH(material_id, period, 'act')) % 440) - 200) / 1000.0))
  END                                                                      AS actual_qty
FROM grid;
