-- ---------------------------------------------------------------------------
-- Phase 4 — Define what an exception row is, per metric.
--
-- A metric on its own is not actionable. Supplier OTD of 85% in EMEA tells a
-- buyer something is wrong but not which receipts to chase. This table says,
-- for each governed metric, which atomic rows caused the miss — read by
-- /api/drilldown so the rows shown under a number always come from the same
-- canonical fact the number is defined over, and therefore reconcile to it.
--
-- TRUST BOUNDARY. EXCEPTION_WHERE is interpolated into SQL by the route. That is
-- only safe because this schema is admin-owned and not writable by any
-- application role: it is configuration, at the same trust level as the semantic
-- view definitions. Everything arriving from a request is bound or validated
-- against INFORMATION_SCHEMA instead. Do not grant INSERT or UPDATE on this
-- table to an application role.
--
-- CANONICAL_FACT must match METRIC_DEFINITION.canonical_fact for the same
-- metric; the route refuses the drill-down if they disagree, because rows from a
-- different fact would not add up to the number being explained.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE (
  metric_id          STRING NOT NULL,
  canonical_fact     STRING NOT NULL COMMENT 'Schema-qualified fact the exception rows come from. Must match METRIC_DEFINITION.canonical_fact.',
  date_column        STRING NOT NULL COMMENT 'Event-date column on the fact, used to apply the reporting period.',
  exception_where    STRING NOT NULL COMMENT 'Predicate identifying the rows that caused the metric to miss. Trusted governance metadata: this schema is admin-owned and is not writable by application roles.',
  display_columns    STRING NOT NULL COMMENT 'Comma-separated columns to show, in display order. Each is validated against INFORMATION_SCHEMA before use.',
  order_by           STRING NOT NULL COMMENT 'Column and direction that puts the worst offenders first.',
  description        STRING NOT NULL COMMENT 'What an exception row means, shown above the table.',
  CONSTRAINT pk_metric_exception_rule PRIMARY KEY (metric_id)
) COMMENT = 'Defines, per governed metric, what an exception row is: the atomic records behind a missed number. Keeping this in the registry rather than in application code means the drill-down and the metric cannot disagree about what counts as a failure.';

TRUNCATE TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE;

INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE
  (metric_id, canonical_fact, date_column, exception_where, display_columns, order_by, description)
SELECT * FROM VALUES
 ('supplier_otd_pct','CANONICAL.FCT_SUPPLIER_DELIVERY_LINE','RECEIPT_DATE','IS_ON_TIME = 0',
  'PO_ID,LINE,SUPPLIER_NAME,SUPPLIER_REGION,MATERIAL_ID,PRODUCT_FAMILY,PROMISED_DATE,RECEIPT_DATE,RECEIPT_VARIANCE_DAYS,ORDERED_QTY,RECEIVED_QTY',
  'RECEIPT_VARIANCE_DAYS DESC','Purchase-order lines received after the promised date. RECEIPT_VARIANCE_DAYS is how many days late.'),
 ('supplier_fill_rate','CANONICAL.FCT_SUPPLIER_DELIVERY_LINE','RECEIPT_DATE','RECEIVED_QTY < ORDERED_QTY',
  'PO_ID,LINE,SUPPLIER_NAME,SUPPLIER_REGION,MATERIAL_ID,ORDERED_QTY,RECEIVED_QTY,PROMISED_DATE,RECEIPT_DATE',
  '(ORDERED_QTY - RECEIVED_QTY) DESC','Purchase-order lines short-received: the supplier delivered less than was ordered.'),
 ('ppv','CANONICAL.FCT_SUPPLIER_DELIVERY_LINE','RECEIPT_DATE','EXTENDED_PRICE_VARIANCE > 0',
  'PO_ID,LINE,SUPPLIER_NAME,MATERIAL_ID,STANDARD_PRICE,ACTUAL_PRICE,UNIT_PRICE_VARIANCE,RECEIVED_QTY,EXTENDED_PRICE_VARIANCE,RECEIPT_DATE',
  'EXTENDED_PRICE_VARIANCE DESC','Receipts priced above standard cost. EXTENDED_PRICE_VARIANCE is the unfavourable dollar impact.'),
 ('otd_pct','CANONICAL.FCT_ORDER_LINE_FULFILLMENT','DELIVERY_DATE','IS_ON_TIME = 0',
  'ORDER_ID,ORDER_LINE,CUSTOMER_ID,CUSTOMER_REGION,MATERIAL_ID,PRODUCT_FAMILY,CARRIER,PROMISE_DATE,DELIVERY_DATE,TRANSIT_DAYS,DEFECT_REASON',
  'DELIVERY_DATE DESC','Customer order lines delivered after the promised date. DEFECT_REASON carries the recorded cause.'),
 ('otif_pct','CANONICAL.FCT_ORDER_LINE_FULFILLMENT','DELIVERY_DATE','IS_OTIF = 0',
  'ORDER_ID,ORDER_LINE,CUSTOMER_ID,CUSTOMER_REGION,MATERIAL_ID,CARRIER,PROMISE_DATE,DELIVERY_DATE,ORDERED_QTY,SHIPPED_QTY,IS_ON_TIME,IS_IN_FULL,DEFECT_REASON',
  'DELIVERY_DATE DESC','Order lines that were late, short, or both. IS_ON_TIME and IS_IN_FULL show which condition failed.'),
 ('fill_rate_pct','CANONICAL.FCT_ORDER_LINE_FULFILLMENT','DELIVERY_DATE','SHIPPED_QTY < ORDERED_QTY',
  'ORDER_ID,ORDER_LINE,CUSTOMER_ID,MATERIAL_ID,PRODUCT_FAMILY,ORDERED_QTY,SHIPPED_QTY,DELIVERY_DATE,DEFECT_REASON',
  '(ORDERED_QTY - SHIPPED_QTY) DESC','Order lines shipped short of the quantity the customer ordered.'),
 ('perfect_order_pct','CANONICAL.FCT_ORDER_LINE_FULFILLMENT','DELIVERY_DATE','IS_PERFECT_ORDER = 0',
  'ORDER_ID,ORDER_LINE,CUSTOMER_ID,MATERIAL_ID,PROMISE_DATE,DELIVERY_DATE,ORDERED_QTY,SHIPPED_QTY,IS_ON_TIME,IS_IN_FULL,IS_CDDA_MET,DEFECT_REASON',
  'DELIVERY_DATE DESC','Order lines failing at least one perfect-order condition.'),
 ('freight_bill_variance_usd','CANONICAL.FCT_LANDED_COST_SHIPMENT','DELIVERY_DATE','FREIGHT_BILL_VAR_AMT > 0',
  'SHIPMENT_ID,ORDER_ID,CARRIER,LANE_ID,SERVICE_LEVEL,SHIP_REGION,FREIGHT_COST,INVOICED_FREIGHT_AMT,FREIGHT_BILL_VAR_AMT,ACCESSORIAL_USD,DELIVERY_DATE',
  'FREIGHT_BILL_VAR_AMT DESC','Shipments where the carrier invoiced more than was accrued. FREIGHT_BILL_VAR_AMT is the overbilling.'),
 ('landed_cost_per_unit','CANONICAL.FCT_LANDED_COST_SHIPMENT','DELIVERY_DATE','SHIPPED_QTY > 0 AND TOTAL_LANDED_COST / SHIPPED_QTY > 15',
  'SHIPMENT_ID,MATERIAL_ID,PRODUCT_FAMILY,CARRIER,LANE_ID,SERVICE_LEVEL,SHIPPED_QTY,MATERIAL_COST,FREIGHT_COST,DUTY_COST,HANDLING_COST,TOTAL_LANDED_COST,IS_PREMIUM_FREIGHT,DELIVERY_DATE',
  '(TOTAL_LANDED_COST / SHIPPED_QTY) DESC','Shipments whose landed cost per unit exceeds $15, well above the governed target of $10.'),
 ('days_of_inventory','CANONICAL.FCT_INVENTORY_SNAPSHOT','SNAPSHOT_DATE','AVG_DAILY_DEMAND > 0 AND ON_HAND_QTY / AVG_DAILY_DEMAND > 60',
  'MATERIAL_ID,PRODUCT_FAMILY,ABC_CLASS,NODE_NAME,NODE_REGION,ON_HAND_QTY,AVG_DAILY_DEMAND,SAFETY_STOCK,INVENTORY_VALUE,SNAPSHOT_DATE',
  '(ON_HAND_QTY / AVG_DAILY_DEMAND) DESC','Material-node positions holding more than 60 days of cover: the stock driving days-of-inventory above target.'),
 ('inventory_value_usd','CANONICAL.FCT_INVENTORY_SNAPSHOT','SNAPSHOT_DATE','IS_STOCKED_OUT = 1 OR ON_HAND_QTY < SAFETY_STOCK',
  'MATERIAL_ID,PRODUCT_FAMILY,ABC_CLASS,NODE_NAME,NODE_REGION,ON_HAND_QTY,SAFETY_STOCK,ATP_QTY,IS_STOCKED_OUT,INVENTORY_VALUE,SNAPSHOT_DATE',
  'ON_HAND_QTY ASC','Positions at or below safety stock: where inventory value is not buying availability.')
AS v(metric_id, canonical_fact, date_column, exception_where, display_columns, order_by, description);
