-- ---------------------------------------------------------------------------
-- 00d — CANONICAL atomic-grain facts.
--
-- These tables are the reconciliation target of the whole project. Every metric
-- in GOVERNANCE.METRIC_DEFINITION carries a CANONICAL_SQL that computes it from
-- exactly one of these tables, and METRIC_DRIFT_TEST asserts that every semantic
-- view binding agrees with that SQL. The semantic views in 00e are defined over
-- these same tables, which is what makes agreement achievable rather than
-- coincidental: a view reading a different source could match today and diverge
-- tomorrow for reasons nobody would notice.
--
-- ---------------------------------------------------------------------------
-- BOOLEAN FLAGS ARE NUMBER(1,0), NOT BOOLEAN. This looks like a mistake and is
-- not. METRIC_EXCEPTION_RULE.exception_where in 05_exception_rules.sql contains
-- predicates written as `IS_ON_TIME = 0`, `IS_OTIF = 0`, `IS_STOCKED_OUT = 1`,
-- and those strings are interpolated into the drill-down query verbatim. Against
-- a BOOLEAN column Snowflake rejects the comparison outright, so the drill-down
-- would fail for every service metric. The flags are also summed directly by the
-- metric expressions (AVG of a 1/0 flag is a rate), which a BOOLEAN cannot do.
--
-- ---------------------------------------------------------------------------
-- WHY THE DIMENSION ATTRIBUTES ARE DENORMALISED ONTO EACH FACT
--
-- SUPPLIER_REGION, PRODUCT_FAMILY, NODE_NAME and so on are copied onto the facts
-- rather than left to a join. Two reasons, both structural:
--
--   1. The drill-down route builds its column list from METRIC_EXCEPTION_RULE
--      and validates every name against INFORMATION_SCHEMA.COLUMNS *of the fact
--      table alone* (app/api/drilldown/route.ts). A column reachable only by a
--      join is not in that list, so it can never be displayed or filtered on.
--   2. The row access policy scoping SC_LOGISTICS_EU attaches to a column on the
--      fact. A policy cannot filter on an attribute that lives in another table
--      without the join being part of the policy, which would make the scope
--      depend on join cardinality.
--
-- The cost is storage and the risk is staleness against the dimension. Both are
-- acceptable here because these tables are rebuilt wholesale, never updated in
-- place.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA CANONICAL;

-- ---------------------------------------------------------------------------
-- FCT_SUPPLIER_DELIVERY_LINE — 420,000 rows. One per purchase-order receipt line.
--
-- RECEIPT_VARIANCE_DAYS is signed, positive meaning late. 05_exception_rules.sql
-- orders the supplier-OTD exception list by `RECEIPT_VARIANCE_DAYS DESC` to put
-- the worst offenders first, which only works with that sign convention.
--
-- EXTENDED_PRICE_VARIANCE is the dollar impact and multiplies by RECEIVED_QTY,
-- not ORDERED_QTY: variance is realised on what was actually invoiced. Using the
-- ordered quantity would overstate PPV on every short receipt.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE FCT_SUPPLIER_DELIVERY_LINE (
  PO_ID                   STRING       NOT NULL COMMENT 'Purchase order number.',
  LINE                    NUMBER       NOT NULL COMMENT 'Line number within the purchase order.',
  SUPPLIER_ID             STRING       NOT NULL COMMENT 'Vendor number.',
  SUPPLIER_NAME           STRING       NOT NULL COMMENT 'Vendor name.',
  SUPPLIER_REGION         STRING       NOT NULL COMMENT 'Sourcing region.',
  SUPPLIER_GROUP          STRING       NOT NULL COMMENT 'Commodity group.',
  SUPPLIER_TIER           STRING       NOT NULL COMMENT 'Strategic tier.',
  MATERIAL_ID             STRING       NOT NULL COMMENT 'Material received.',
  PRODUCT_FAMILY          STRING       NOT NULL COMMENT 'Product family of the material.',
  BUSINESS_SEGMENT        STRING       NOT NULL COMMENT 'Reporting segment.',
  ABC_CLASS               STRING       NOT NULL COMMENT 'Inventory value class of the material.',
  PROMISED_DATE           DATE         NOT NULL COMMENT 'Date the supplier committed to.',
  RECEIPT_DATE            DATE         NOT NULL COMMENT 'Date goods were received. The event date: reporting periods are applied to this column.',
  RECEIPT_VARIANCE_DAYS   NUMBER       NOT NULL COMMENT 'Receipt date minus promised date. Positive is late, negative is early.',
  ORDERED_QTY             NUMBER       NOT NULL COMMENT 'Quantity ordered.',
  RECEIVED_QTY            NUMBER       NOT NULL COMMENT 'Quantity received.',
  IS_ON_TIME              NUMBER(1,0)  NOT NULL COMMENT '1 when received on or before the promised date. Numeric, not boolean: the exception rules compare it to 0 and the metrics average it.',
  IS_IN_FULL              NUMBER(1,0)  NOT NULL COMMENT '1 when the received quantity met the ordered quantity.',
  STANDARD_PRICE          NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost.',
  ACTUAL_PRICE            NUMBER(12,4) NOT NULL COMMENT 'Unit price invoiced.',
  UNIT_PRICE_VARIANCE     NUMBER(12,4) NOT NULL COMMENT 'Actual less standard, per unit. Positive is unfavourable.',
  EXTENDED_PRICE_VARIANCE NUMBER(16,4) NOT NULL COMMENT 'Unit variance times received quantity: the realised dollar impact. Deliberately on received, not ordered, quantity.',
  CONSTRAINT pk_fct_supplier_delivery_line PRIMARY KEY (PO_ID, LINE)
) COMMENT = 'Atomic inbound receipt lines. Canonical source for supplier OTD, supplier fill rate and purchase price variance.';

INSERT INTO FCT_SUPPLIER_DELIVERY_LINE
SELECT
  r.po_id,
  r.line,
  r.supplier_id,
  s.supplier_name,
  s.supplier_region,
  s.supplier_group,
  s.supplier_tier,
  r.material_id,
  p.product_family,
  p.business_segment,
  p.abc_class,
  r.promised_date,
  r.receipt_date,
  DATEDIFF('DAY', r.promised_date, r.receipt_date)                          AS receipt_variance_days,
  r.ordered_qty,
  r.received_qty,
  IFF(r.receipt_date <= r.promised_date, 1, 0)                              AS is_on_time,
  IFF(r.received_qty >= r.ordered_qty, 1, 0)                                AS is_in_full,
  r.standard_price,
  r.actual_price,
  ROUND(r.actual_price - r.standard_price, 4)                               AS unit_price_variance,
  ROUND((r.actual_price - r.standard_price) * r.received_qty, 4)             AS extended_price_variance
FROM SUPPLY_CHAIN.RAW.PO_RECEIPT_LINE r
JOIN SUPPLY_CHAIN.RAW.SUPPLIER s ON s.supplier_id = r.supplier_id
JOIN SUPPLY_CHAIN.RAW.PART     p ON p.material_id = r.material_id;

-- ---------------------------------------------------------------------------
-- FCT_ORDER_LINE_FULFILLMENT — 1,500,000 rows. One per customer order line.
--
-- The four service flags form a strict hierarchy, and each one is stored rather
-- than recomputed downstream:
--   IS_ON_TIME        delivered on or before the promise
--   IS_IN_FULL        shipped the full ordered quantity
--   IS_OTIF           both of the above
--   IS_PERFECT_ORDER  OTIF and the customer accepted the delivery date
--
-- Storing them is what lets 05_exception_rules.sql write a different predicate
-- per metric against one table, and what lets the drill-down show which specific
-- condition failed on a row rather than only that something did.
--
-- CARRIER holds the carrier NAME, not the id: the operations page groups on
-- order_fulfillment.carrier and the drill-down displays it, and a code would be
-- unreadable in both. The id is not carried, since nothing joins back to it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE FCT_ORDER_LINE_FULFILLMENT (
  ORDER_ID         STRING      NOT NULL COMMENT 'Sales order number.',
  ORDER_LINE       NUMBER      NOT NULL COMMENT 'Line number within the sales order.',
  CUSTOMER_ID      STRING      NOT NULL COMMENT 'Ship-to customer.',
  CUSTOMER_NAME    STRING      NOT NULL COMMENT 'Customer name.',
  CUSTOMER_REGION  STRING      NOT NULL COMMENT 'Region the account is managed in.',
  CUSTOMER_SEGMENT STRING      NOT NULL COMMENT 'Go-to-market segment.',
  MATERIAL_ID      STRING      NOT NULL COMMENT 'Material ordered.',
  PRODUCT_FAMILY   STRING      NOT NULL COMMENT 'Product family.',
  BUSINESS_SEGMENT STRING      NOT NULL COMMENT 'Reporting segment.',
  CARRIER          STRING      NOT NULL COMMENT 'Carrier name. The name rather than the code, because this column is both grouped on and displayed.',
  LANE_ID          STRING      NOT NULL COMMENT 'Transport lane.',
  SHIP_REGION      STRING      NOT NULL COMMENT 'Destination region. The row access policy for SC_LOGISTICS_EU scopes on this column.',
  PROMISE_DATE     DATE        NOT NULL COMMENT 'Date promised to the customer.',
  DELIVERY_DATE    DATE        NOT NULL COMMENT 'Date delivered. The event date: reporting periods are applied to this column.',
  TRANSIT_DAYS     NUMBER      NOT NULL COMMENT 'Actual days in transit.',
  DEFECT_REASON    STRING               COMMENT 'Recorded cause on lines that failed a condition. NULL on clean lines.',
  ORDERED_QTY      NUMBER      NOT NULL COMMENT 'Quantity ordered.',
  SHIPPED_QTY      NUMBER      NOT NULL COMMENT 'Quantity shipped.',
  IS_ON_TIME       NUMBER(1,0) NOT NULL COMMENT '1 when delivered on or before the promise date.',
  IS_IN_FULL       NUMBER(1,0) NOT NULL COMMENT '1 when the full ordered quantity shipped.',
  IS_OTIF          NUMBER(1,0) NOT NULL COMMENT '1 when on time AND in full. Stored, not recomputed, so one table can serve a different exception predicate per metric.',
  IS_CDDA_MET      NUMBER(1,0) NOT NULL COMMENT '1 when the customer accepted the delivery date. Independent of the other conditions.',
  IS_PERFECT_ORDER NUMBER(1,0) NOT NULL COMMENT '1 when OTIF and CDDA both hold. Strictly harder than OTIF, which is what makes it a distinct metric.',
  CONSTRAINT pk_fct_order_line_fulfillment PRIMARY KEY (ORDER_ID, ORDER_LINE)
) COMMENT = 'Atomic outbound order lines. Canonical source for customer OTD, OTIF, fill rate and perfect order rate.';

INSERT INTO FCT_ORDER_LINE_FULFILLMENT
WITH flags AS (
  SELECT
    sol.*,
    c.customer_name, c.customer_region, c.customer_segment,
    p.product_family, p.business_segment,
    car.carrier_name,
    ln.dest_region,
    IFF(sol.delivery_date <= sol.promise_date, 1, 0)  AS f_on_time,
    IFF(sol.shipped_qty  >= sol.ordered_qty,   1, 0)  AS f_in_full,
    IFF(sol.cdda_met, 1, 0)                           AS f_cdda
  FROM SUPPLY_CHAIN.RAW.SALES_ORDER_LINE sol
  JOIN SUPPLY_CHAIN.RAW.CUSTOMER c  ON c.customer_id  = sol.customer_id
  JOIN SUPPLY_CHAIN.RAW.PART     p  ON p.material_id  = sol.material_id
  JOIN SUPPLY_CHAIN.RAW.CARRIER  car ON car.carrier_id = sol.carrier_id
  JOIN SUPPLY_CHAIN.RAW.LANE     ln ON ln.lane_id     = sol.lane_id
)
SELECT
  order_id, order_line, customer_id, customer_name, customer_region, customer_segment,
  material_id, product_family, business_segment,
  carrier_name AS carrier,
  lane_id,
  dest_region  AS ship_region,
  promise_date, delivery_date, transit_days, defect_reason, ordered_qty, shipped_qty,
  f_on_time                                     AS is_on_time,
  f_in_full                                     AS is_in_full,
  f_on_time * f_in_full                         AS is_otif,
  f_cdda                                        AS is_cdda_met,
  f_on_time * f_in_full * f_cdda                AS is_perfect_order
FROM flags;

-- ---------------------------------------------------------------------------
-- FCT_LANDED_COST_SHIPMENT — 1,480,499 rows. One per carrier-billed shipment.
--
-- FREIGHT_BILL_VAR_AMT is invoiced minus accrued, so positive means the carrier
-- overbilled. 05_exception_rules.sql selects `FREIGHT_BILL_VAR_AMT > 0` and calls
-- those rows overbilling, so the sign convention is part of the contract.
--
-- TOTAL_LANDED_COST is stored rather than computed on read. Landed cost per unit
-- is a ratio of two sums, and the drill-down orders on
-- `(TOTAL_LANDED_COST / SHIPPED_QTY) DESC`; if the total were a view expression,
-- that ORDER BY would reference a column that INFORMATION_SCHEMA.COLUMNS does not
-- list and the drill-down's own validation would reject it.
--
-- ACCESSORIAL_USD is deliberately NOT part of TOTAL_LANDED_COST. Accessorials are
-- billed separately from the landed cost of goods, and folding them in would make
-- landed cost per unit disagree with the components shown beside it in the
-- drill-down — the exact kind of quiet inconsistency the drift test exists to
-- catch, except in a place the drift test cannot see.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE FCT_LANDED_COST_SHIPMENT (
  SHIPMENT_ID          STRING       NOT NULL COMMENT 'Shipment number.',
  ORDER_ID             STRING       NOT NULL COMMENT 'Sales order.',
  ORDER_LINE           NUMBER       NOT NULL COMMENT 'Sales order line.',
  CARRIER              STRING       NOT NULL COMMENT 'Carrier name.',
  LANE_ID              STRING       NOT NULL COMMENT 'Lane used.',
  SERVICE_LEVEL        STRING       NOT NULL COMMENT 'Committed service level.',
  SHIP_REGION          STRING       NOT NULL COMMENT 'Destination region. Scoped by the EU row access policy.',
  MATERIAL_ID          STRING       NOT NULL COMMENT 'Material shipped.',
  PRODUCT_FAMILY       STRING       NOT NULL COMMENT 'Product family.',
  BUSINESS_SEGMENT     STRING       NOT NULL COMMENT 'Reporting segment.',
  SHIPPED_QTY          NUMBER       NOT NULL COMMENT 'Units shipped. Denominator of landed cost per unit.',
  DELIVERY_DATE        DATE         NOT NULL COMMENT 'Delivery date. The event date for landed-cost reporting.',
  MATERIAL_COST        NUMBER(14,2) NOT NULL COMMENT 'Standard cost times quantity.',
  FREIGHT_COST         NUMBER(14,2) NOT NULL COMMENT 'Accrued freight.',
  INVOICED_FREIGHT_AMT NUMBER(14,2) NOT NULL COMMENT 'Freight the carrier invoiced.',
  FREIGHT_BILL_VAR_AMT NUMBER(14,2) NOT NULL COMMENT 'Invoiced less accrued. Positive is carrier overbilling.',
  ACCESSORIAL_USD      NUMBER(14,2) NOT NULL COMMENT 'Accessorial charges. Deliberately excluded from TOTAL_LANDED_COST: they are billed separately from the landed cost of goods.',
  DUTY_COST            NUMBER(14,2) NOT NULL COMMENT 'Duty on cross-region movements.',
  HANDLING_COST        NUMBER(14,2) NOT NULL COMMENT 'Warehouse handling.',
  TOTAL_LANDED_COST    NUMBER(14,2) NOT NULL COMMENT 'Material + freight + duty + handling. Stored rather than derived so the drill-down can order on it.',
  IS_PREMIUM_FREIGHT   NUMBER(1,0)  NOT NULL COMMENT '1 where an expedited service level was used.',
  CONSTRAINT pk_fct_landed_cost_shipment PRIMARY KEY (SHIPMENT_ID)
) COMMENT = 'Atomic landed cost per shipment. Canonical source for landed cost per unit, freight cost, freight invoiced and freight bill variance.';

INSERT INTO FCT_LANDED_COST_SHIPMENT
SELECT
  sc.shipment_id,
  sc.order_id,
  sc.order_line,
  car.carrier_name                                                          AS carrier,
  sc.lane_id,
  sc.service_level,
  sc.ship_region,
  sc.material_id,
  p.product_family,
  p.business_segment,
  sc.shipped_qty,
  sc.delivery_date,
  sc.material_cost,
  sc.freight_cost,
  sc.invoiced_freight_amt,
  ROUND(sc.invoiced_freight_amt - sc.freight_cost, 2)                        AS freight_bill_var_amt,
  sc.accessorial_usd,
  sc.duty_cost,
  sc.handling_cost,
  ROUND(sc.material_cost + sc.freight_cost + sc.duty_cost + sc.handling_cost, 2) AS total_landed_cost,
  IFF(sc.is_premium_freight, 1, 0)                                           AS is_premium_freight
FROM SUPPLY_CHAIN.RAW.SHIPMENT_COST sc
JOIN SUPPLY_CHAIN.RAW.PART    p   ON p.material_id   = sc.material_id
JOIN SUPPLY_CHAIN.RAW.CARRIER car ON car.carrier_id  = sc.carrier_id;

-- ---------------------------------------------------------------------------
-- FCT_INVENTORY_SNAPSHOT — 137,088 rows. 5,712 material-node pairs x 24 month-ends.
--
-- THIS TABLE IS NOT ADDITIVE OVER TIME and every consumer has to know it. Summing
-- INVENTORY_VALUE across the 24 snapshots yields a number 24 times too large that
-- looks entirely plausible. The guards against that are layered deliberately:
-- METRIC_DEFINITION.as_of_scope marks these metrics SNAPSHOT (02_as_of_rule.sql),
-- lib/sc.ts selects the latest snapshot date within the requested period rather
-- than aggregating, and the inventory verified queries in 07 are all written per
-- snapshot so Cortex Analyst is shown the correct pattern rather than left to
-- infer it.
--
-- INVENTORY_VALUE is on-hand at standard cost. Using a moving average cost would
-- make the value move for reasons unrelated to the quantity on hand, which would
-- make the metric unusable for explaining a change in stock.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE FCT_INVENTORY_SNAPSHOT (
  SNAPSHOT_DATE    DATE         NOT NULL COMMENT 'Month-end the balance was observed. Exactly 24 distinct values. Not additive across periods.',
  MATERIAL_ID      STRING       NOT NULL COMMENT 'Material.',
  PRODUCT_FAMILY   STRING       NOT NULL COMMENT 'Product family.',
  BUSINESS_SEGMENT STRING       NOT NULL COMMENT 'Reporting segment.',
  ABC_CLASS        STRING       NOT NULL COMMENT 'Inventory value class.',
  NODE_ID          STRING       NOT NULL COMMENT 'Stocking location code.',
  NODE_NAME        STRING       NOT NULL COMMENT 'Stocking location name.',
  NODE_REGION      STRING       NOT NULL COMMENT 'Region the node serves.',
  ON_HAND_QTY      NUMBER       NOT NULL COMMENT 'Units on hand.',
  AVG_DAILY_DEMAND NUMBER(12,3) NOT NULL COMMENT 'Trailing average daily demand. Denominator of days of inventory.',
  SAFETY_STOCK     NUMBER       NOT NULL COMMENT 'Target safety stock.',
  ATP_QTY          NUMBER       NOT NULL COMMENT 'Available to promise.',
  IS_STOCKED_OUT   NUMBER(1,0)  NOT NULL COMMENT '1 when nothing is available to promise.',
  INVENTORY_VALUE  NUMBER(16,2) NOT NULL COMMENT 'On-hand quantity at standard cost. Standard rather than moving-average cost, so that value moves only when quantity does.',
  CONSTRAINT pk_fct_inventory_snapshot PRIMARY KEY (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
) COMMENT = 'Atomic month-end inventory positions. Canonical source for days of inventory and inventory value. A snapshot: never sum across snapshot dates.';

INSERT INTO FCT_INVENTORY_SNAPSHOT
SELECT
  ip.snapshot_date,
  ip.material_id,
  p.product_family,
  p.business_segment,
  p.abc_class,
  ip.node_id,
  n.node_name,
  n.node_region,
  ip.on_hand_qty,
  ip.avg_daily_demand,
  ip.safety_stock,
  ip.atp_qty,
  IFF(ip.atp_qty <= 0, 1, 0)                                                AS is_stocked_out,
  ROUND(ip.on_hand_qty * p.standard_cost, 2)                                AS inventory_value
FROM SUPPLY_CHAIN.RAW.INVENTORY_POSITION ip
JOIN SUPPLY_CHAIN.RAW.PART p ON p.material_id = ip.material_id
JOIN SUPPLY_CHAIN.RAW.NODE n ON n.node_id     = ip.node_id;

-- ---------------------------------------------------------------------------
-- FCT_REQUISITION_LINE — the demand signal upstream of a purchase order.
--
-- Carried because METRIC_DEFINITION references it as a canonical fact and the
-- ontology catalogue lists it, so its absence would leave a registered fact
-- pointing at nothing. One requisition line per purchase-order line, with the
-- requisition raised 5-25 days before the promise: enough to make requisition
-- lead time measurable, which is the only thing this grain adds over the receipt
-- line.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE FCT_REQUISITION_LINE (
  REQUISITION_ID    STRING NOT NULL COMMENT 'Requisition number.',
  REQUISITION_LINE  NUMBER NOT NULL COMMENT 'Line within the requisition.',
  PO_ID             STRING NOT NULL COMMENT 'Purchase order the requisition converted into.',
  LINE              NUMBER NOT NULL COMMENT 'Purchase order line.',
  MATERIAL_ID       STRING NOT NULL COMMENT 'Material requested.',
  PRODUCT_FAMILY    STRING NOT NULL COMMENT 'Product family.',
  SUPPLIER_ID       STRING NOT NULL COMMENT 'Vendor the requisition was sourced to.',
  SUPPLIER_REGION   STRING NOT NULL COMMENT 'Sourcing region.',
  REQUESTED_QTY     NUMBER NOT NULL COMMENT 'Quantity requested.',
  REQUISITION_DATE  DATE   NOT NULL COMMENT 'Date the requisition was raised. The event date.',
  PROMISED_DATE     DATE   NOT NULL COMMENT 'Date subsequently committed by the supplier.',
  LEAD_TIME_DAYS    NUMBER NOT NULL COMMENT 'Days from requisition to promised delivery.',
  CONSTRAINT pk_fct_requisition_line PRIMARY KEY (REQUISITION_ID, REQUISITION_LINE)
) COMMENT = 'Atomic requisition lines: the demand signal upstream of a purchase order. Adds requisition lead time over the receipt grain.';

INSERT INTO FCT_REQUISITION_LINE
SELECT
  'REQ-' || SUBSTR(f.po_id, 4)                                              AS requisition_id,
  f.line                                                                    AS requisition_line,
  f.po_id,
  f.line,
  f.material_id,
  f.product_family,
  f.supplier_id,
  f.supplier_region,
  f.ordered_qty                                                             AS requested_qty,
  DATEADD('DAY', -(5 + ABS(HASH(f.po_id, f.line, 'req')) % 21), f.promised_date) AS requisition_date,
  f.promised_date,
  5 + ABS(HASH(f.po_id, f.line, 'req')) % 21                                AS lead_time_days
FROM FCT_SUPPLIER_DELIVERY_LINE f;

-- ---------------------------------------------------------------------------
-- Read access for the personas.
--
-- SELECT only, and only on CANONICAL — never on RAW. The drill-down is the single
-- path from a metric to the rows behind it, and it is constrained by
-- METRIC_EXCEPTION_RULE, so a persona cannot wander off and compute a rival
-- version of a governed number from the source system.
-- ---------------------------------------------------------------------------

GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_PLANNER;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_PROCUREMENT;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_LOGISTICS;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_ONTOLOGY_STEWARD;
