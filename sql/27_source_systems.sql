-- ---------------------------------------------------------------------------
-- 27 — Source systems: the problem the ontology exists to fix, made measurable.
--
-- The brief: "supply chain data is scattered across ERP, logistics, supplier and
-- IoT systems with inconsistent definitions, so the same question yields
-- different answers across teams."
--
-- This file models four source systems as they actually present data — their
-- own column names, date encodings and units — over the same underlying events,
-- and encodes each system's NATIVE definition of on-time delivery, as found in
-- real deployments:
--
--   ERP (SAP MM style)    EKPO/EKBE-like columns, YYYYMMDD strings.
--                         "On time" = goods receipt within the 2-day GR grace window.
--   SUPPLIER PORTAL       Supplier-reported scorecard, average of monthly rates
--                         per supplier, then averaged again (the legacy defect).
--   TMS                   Carrier events, timestamps in UTC.
--                         "On time" = delivered within 1 day of promise.
--   CRM / ORDER MGMT      Order-header grain: an order is on time only if every
--                         line is.
--   IOT                   Sensor temperature in Fahrenheit (canonical is Celsius).
--
-- GOVERNANCE.V_SOURCE_DEFINITION_SPREAD then asks "what is our OTD?" of every
-- source and of the governed semantic view. The sources disagree with each other;
-- the governed metric gives one answer for every persona. The spread is computed
-- live, never typed into a slide.
--
-- Synthetic data, real arithmetic: every source view reads the same canonical
-- facts the governed metric is defined over, so the disagreement is purely
-- definitional — which is exactly the failure mode the brief describes.
-- Idempotent.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;

CREATE SCHEMA IF NOT EXISTS SOURCE_SYSTEMS
  COMMENT = 'Source-system presentations of the same events (ERP, supplier portal, TMS, CRM, IoT), each with native names, encodings, units and its own metric definition. Not read by the app or any persona; exists to measure the divergence the ontology removes.';

-- ERP: SAP MM-style purchase order history.
CREATE OR REPLACE VIEW SOURCE_SYSTEMS.ERP_EKBE_GOODS_RECEIPT
  COMMENT = 'ERP goods receipts. EBELN/EBELP = PO/line, LIFNR = vendor, MATNR = material, EINDT = delivery date due, BUDAT = posting date (YYYYMMDD strings), MENGE = quantity.'
AS
SELECT po_id                              AS EBELN,
       line                               AS EBELP,
       supplier_id                        AS LIFNR,
       material_id                        AS MATNR,
       TO_CHAR(promised_date, 'YYYYMMDD') AS EINDT,
       TO_CHAR(receipt_date,  'YYYYMMDD') AS BUDAT,
       ordered_qty                        AS MENGE_BESTELLT,
       received_qty                       AS MENGE
  FROM CANONICAL.FCT_SUPPLIER_DELIVERY_LINE;

-- TMS: carrier delivery events.
CREATE OR REPLACE VIEW SOURCE_SYSTEMS.TMS_DELIVERY_EVENT
  COMMENT = 'TMS delivery events. SHPMT_REF = order/line, CARRIER_SCAC, PROMISE_TS_UTC and POD_TS_UTC (proof of delivery) as timestamps.'
AS
SELECT order_id || '-' || order_line             AS SHPMT_REF,
       carrier                                   AS CARRIER_SCAC,
       promise_date::TIMESTAMP_NTZ               AS PROMISE_TS_UTC,
       delivery_date::TIMESTAMP_NTZ              AS POD_TS_UTC,
       ship_region                               AS DEST_ZONE
  FROM CANONICAL.FCT_ORDER_LINE_FULFILLMENT;

-- CRM / order management: order headers.
CREATE OR REPLACE VIEW SOURCE_SYSTEMS.CRM_ORDER_HEADER
  COMMENT = 'Order-management header status. One row per customer order; LATE_FLAG is set if any line missed its promise date.'
AS
SELECT order_id                         AS SALES_DOC,
       MAX(customer_id)                 AS SOLD_TO,
       MAX(IFF(is_on_time = 0, 1, 0))   AS LATE_FLAG
  FROM CANONICAL.FCT_ORDER_LINE_FULFILLMENT
 GROUP BY order_id;

-- IoT: sensor readings in Fahrenheit.
CREATE OR REPLACE VIEW SOURCE_SYSTEMS.IOT_SENSOR_PEAK
  COMMENT = 'IoT gateway peak temperature per shipment in Fahrenheit. Canonical stores Celsius.'
AS
SELECT shipment_id                       AS DEVICE_SHIPMENT,
       ROUND(peak_temp_c * 9 / 5 + 32, 1) AS PEAK_TEMP_F,
       event_date                        AS READING_DATE
  FROM CANONICAL.FCT_SHIPMENT_TELEMETRY;

-- Where each canonical concept comes from, per source. Rendered on /ontology.
CREATE OR REPLACE TABLE GOVERNANCE.SOURCE_ATTRIBUTE_MAP (
  source_system     STRING,
  source_object     STRING,
  source_attribute  STRING,
  source_encoding   STRING,
  ontology_ref      STRING,
  transformation    STRING
) COMMENT = 'Source-to-ontology attribute mapping. One canonical attribute, many native representations.';

INSERT INTO GOVERNANCE.SOURCE_ATTRIBUTE_MAP VALUES
  ('ERP',  'ERP_EKBE_GOODS_RECEIPT', 'LIFNR',          'vendor number',        'supplier.supplier_id',          'identity'),
  ('ERP',  'ERP_EKBE_GOODS_RECEIPT', 'MATNR',          'material number',      'part.material_id',              'identity'),
  ('ERP',  'ERP_EKBE_GOODS_RECEIPT', 'EINDT',          'YYYYMMDD string',      'purchase_order.promised_date',  'TO_DATE(EINDT, ''YYYYMMDD'')'),
  ('ERP',  'ERP_EKBE_GOODS_RECEIPT', 'BUDAT',          'YYYYMMDD string',      'purchase_order.receipt_date',   'TO_DATE(BUDAT, ''YYYYMMDD'')'),
  ('ERP',  'ERP_EKBE_GOODS_RECEIPT', 'MENGE',          'units',                'purchase_order.received_qty',   'identity'),
  ('TMS',  'TMS_DELIVERY_EVENT',     'SHPMT_REF',      'order-line string',    'order_fulfillment.(order_id, order_line)', 'SPLIT_PART(SHPMT_REF, ''-'', n)'),
  ('TMS',  'TMS_DELIVERY_EVENT',     'POD_TS_UTC',     'UTC timestamp',        'order_fulfillment.delivery_date', 'POD_TS_UTC::DATE'),
  ('TMS',  'TMS_DELIVERY_EVENT',     'CARRIER_SCAC',   'carrier code',         'order_fulfillment.carrier',     'identity'),
  ('CRM',  'CRM_ORDER_HEADER',       'SOLD_TO',        'customer number',      'customer.customer_id',          'identity'),
  ('CRM',  'CRM_ORDER_HEADER',       'LATE_FLAG',      'order-header flag',    'order_fulfillment.on_time',     'NOT used: header grain cannot be re-expanded to lines'),
  ('IOT',  'IOT_SENSOR_PEAK',        'PEAK_TEMP_F',    'degrees Fahrenheit',   'shipment_telemetry.peak_temp_c', '(PEAK_TEMP_F - 32) * 5 / 9'),
  ('IOT',  'IOT_SENSOR_PEAK',        'DEVICE_SHIPMENT','shipment id',          'landed_cost.shipment_id',       'identity');

-- The same question asked of every source and of the governed layer.
CREATE OR REPLACE VIEW GOVERNANCE.V_SOURCE_DEFINITION_SPREAD
  COMMENT = 'Answer to "what is our on-time delivery?" from each source system''s native definition versus the governed metric. Computed live from the same canonical events.'
AS
WITH erp AS (
  SELECT AVG(IFF(DATEDIFF('day', TO_DATE(EINDT, 'YYYYMMDD'), TO_DATE(BUDAT, 'YYYYMMDD')) <= 2, 1, 0)) AS v
    FROM SOURCE_SYSTEMS.ERP_EKBE_GOODS_RECEIPT
),
portal AS (
  SELECT AVG(supplier_rate) AS v
    FROM (SELECT supplier_id, AVG(otd_rate) AS supplier_rate
            FROM CANONICAL.V_SUPPLIER_OTD_BY_MONTH GROUP BY supplier_id)
),
gov_in AS (
  SELECT supplier_otd_pct AS v
    FROM SEMANTIC_VIEW(SEMANTIC.SC_ONTOLOGY_360 METRICS purchase_order.supplier_otd_pct)
),
tms AS (
  SELECT AVG(IFF(DATEDIFF('day', PROMISE_TS_UTC, POD_TS_UTC) <= 1, 1, 0)) AS v
    FROM SOURCE_SYSTEMS.TMS_DELIVERY_EVENT
),
crm AS (
  SELECT 1 - AVG(LATE_FLAG) AS v FROM SOURCE_SYSTEMS.CRM_ORDER_HEADER
),
gov_out AS (
  SELECT otd_pct AS v
    FROM SEMANTIC_VIEW(SEMANTIC.SC_ONTOLOGY_360 METRICS order_fulfillment.otd_pct)
)
SELECT 'INBOUND'  AS direction, 'ERP (SAP MM)'     AS source_system, 'Receipt within 2-day GR grace window'          AS native_definition, (SELECT v FROM erp)     AS otd_value, FALSE AS is_governed
UNION ALL SELECT 'INBOUND',  'Supplier portal',    'Average of monthly supplier averages',           (SELECT v FROM portal),  FALSE
UNION ALL SELECT 'INBOUND',  'Governed ontology',  'purchase_order.supplier_otd_pct (line-weighted, no grace)', (SELECT v FROM gov_in), TRUE
UNION ALL SELECT 'OUTBOUND', 'TMS',                'Proof of delivery within 1 day of promise',      (SELECT v FROM tms),     FALSE
UNION ALL SELECT 'OUTBOUND', 'CRM / order mgmt',   'Order header on time only if every line is',     (SELECT v FROM crm),     FALSE
UNION ALL SELECT 'OUTBOUND', 'Governed ontology',  'order_fulfillment.otd_pct (line-weighted)',     (SELECT v FROM gov_out), TRUE;

GRANT USAGE ON SCHEMA SOURCE_SYSTEMS TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON ALL VIEWS IN SCHEMA SOURCE_SYSTEMS TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON TABLE GOVERNANCE.SOURCE_ATTRIBUTE_MAP TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW GOVERNANCE.V_SOURCE_DEFINITION_SPREAD TO ROLE SC_ONTOLOGY_STEWARD;

SELECT * FROM GOVERNANCE.V_SOURCE_DEFINITION_SPREAD;
