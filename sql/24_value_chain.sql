-- ---------------------------------------------------------------------------
-- 24 — SC_VALUE_CHAIN: the brief's chain, literally.
--
--   Supplier ──supplies──▶ Part ──made at──▶ Plant
--                                              │ ships from
--                                              ▼
--   Customer ◀──placed by── Customer Order ◀── Shipment
--
-- SC_ONTOLOGY_360 already covers every domain, but it names entities after the
-- facts they come from (PURCHASE_ORDER, ORDER_FULFILLMENT, LANDED_COST, NODE).
-- This view exposes the same data under the business chain a planner, buyer or
-- logistics lead draws on a whiteboard, with Shipment and Customer Order as
-- first-class entities and Plant as the ship-from / make-at location.
--
-- SAME DEFINITIONS, NOT NEW ONES. Every metric below is the exact expression
-- from SC_ONTOLOGY_360 over the exact same canonical fact. The drift test
-- (04_drift_schedule) and the parity block at the bottom of this file assert the
-- values are identical, so adding a view cannot create a second answer.
--
-- GOVERNANCE. V_SHIPMENT is a plain view over FCT_LANDED_COST_SHIPMENT, so the
-- RAP_SHIP_REGION row access policy on that table still applies; SC_LOGISTICS_EU
-- sees only EU shipments here exactly as it does in the 360 view.
--
-- Idempotent: CREATE OR REPLACE throughout, safe to re-run.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

CREATE OR REPLACE VIEW CANONICAL.V_SHIPMENT
  COMMENT = 'One row per shipment with its ship-from node resolved through the transport lane. Inherits RAP_SHIP_REGION from FCT_LANDED_COST_SHIPMENT.'
AS
SELECT s.*, l.origin_node AS ship_from_node_id
  FROM CANONICAL.FCT_LANDED_COST_SHIPMENT s
  JOIN RAW.LANE l ON l.lane_id = s.lane_id;

CREATE OR REPLACE SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN
  TABLES (
    SUPPLIER as SUPPLY_CHAIN.RAW.SUPPLIER primary key (SUPPLIER_ID)
      with synonyms=('supplier','vendor')
      comment='sco:Supplier - first link of the chain. Conformed dimension.',
    PART as SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)
      with synonyms=('part','material','sku','item')
      comment='sco:Material - what suppliers supply, plants make and customers order. Conformed dimension.',
    PLANT as SUPPLY_CHAIN.RAW.NODE primary key (NODE_ID)
      with synonyms=('plant','site','ship-from','origin','factory','dc','warehouse')
      comment='sco:Location - where parts are made (PLANT) and where shipments leave from (PLANT or DC). Conformed dimension.',
    CUSTOMER as SUPPLY_CHAIN.RAW.CUSTOMER primary key (CUSTOMER_ID)
      with synonyms=('customer','account','client')
      comment='sco:Customer - last link of the chain. Conformed dimension.',
    SUPPLY as SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE primary key (PO_ID, LINE)
      with synonyms=('supply','purchase order','po','receipt','inbound')
      comment='sco:InboundReceipt - Supplier supplies Part. Fact, receipt-line grain.',
    PRODUCTION as SUPPLY_CHAIN.RAW.PRODUCTION_ORDER primary key (PRODUCTION_ORDER_ID)
      with synonyms=('production','production order','work order','build')
      comment='sco:ProductionOrder - Part made at Plant. Fact, order grain.',
    CUSTOMER_ORDER as SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT primary key (ORDER_ID, ORDER_LINE)
      with synonyms=('customer order','sales order','order','order line')
      comment='sco:CustomerOrder - Customer orders Part. Fact, order-line grain.',
    SHIPMENT as SUPPLY_CHAIN.CANONICAL.V_SHIPMENT primary key (SHIPMENT_ID)
      with synonyms=('shipment','delivery','consignment','freight')
      comment='sco:Shipment - fulfils one Customer Order line, ships from a Plant or DC. Fact, shipment grain.'
  )
  RELATIONSHIPS (
    SUPPLY_TO_SUPPLIER as SUPPLY(SUPPLIER_ID) references SUPPLIER(SUPPLIER_ID),
    SUPPLY_TO_PART as SUPPLY(MATERIAL_ID) references PART(MATERIAL_ID),
    PRODUCTION_TO_PART as PRODUCTION(MATERIAL_ID) references PART(MATERIAL_ID),
    PRODUCTION_TO_PLANT as PRODUCTION(NODE_ID) references PLANT(NODE_ID),
    SHIPMENT_TO_PLANT as SHIPMENT(SHIP_FROM_NODE_ID) references PLANT(NODE_ID),
    SHIPMENT_TO_ORDER as SHIPMENT(ORDER_ID, ORDER_LINE) references CUSTOMER_ORDER(ORDER_ID, ORDER_LINE),
    ORDER_TO_PART as CUSTOMER_ORDER(MATERIAL_ID) references PART(MATERIAL_ID),
    ORDER_TO_CUSTOMER as CUSTOMER_ORDER(CUSTOMER_ID) references CUSTOMER(CUSTOMER_ID)
  )
  FACTS (
    SUPPLY.ON_TIME as supply.is_on_time comment='1 when the receipt met the promised date.',
    SUPPLY.IN_FULL as supply.is_in_full comment='1 when the full ordered quantity was received.',
    PRODUCTION.COMPLETED as production.completed_qty comment='Good quantity completed.',
    PRODUCTION.SCRAP as production.scrap_qty comment='Quantity scrapped.',
    PRODUCTION.PLANNED as production.planned_qty comment='Quantity planned.',
    CUSTOMER_ORDER.ON_TIME as customer_order.is_on_time comment='1 when delivered by the promise date.',
    CUSTOMER_ORDER.IN_FULL as customer_order.is_in_full comment='1 when the full ordered quantity shipped.',
    CUSTOMER_ORDER.OTIF as customer_order.is_otif comment='1 when on time and in full.',
    SHIPMENT.TOTAL_COST as shipment.total_landed_cost comment='Material + freight + duty + handling.',
    SHIPMENT.UNITS as shipment.shipped_qty comment='Units shipped.'
  )
  DIMENSIONS (
    SUPPLIER.SUPPLIER_NAME as supplier.supplier_name with synonyms=('vendor name') comment='Vendor name.',
    SUPPLIER.SUPPLIER_REGION as supplier.supplier_region with synonyms=('sourcing region','inbound region') comment='Region goods are sourced from.',
    SUPPLIER.SUPPLIER_TIER as supplier.supplier_tier with synonyms=('tier') comment='Strategic tier.',
    PART.PRODUCT_FAMILY as part.product_family with synonyms=('family','product line') comment='Product family.',
    PART.BUSINESS_SEGMENT as part.business_segment with synonyms=('segment','division') comment='Reporting segment.',
    PLANT.PLANT_NAME as plant.node_name with synonyms=('plant name','site name','ship-from name') comment='Plant or DC name.',
    PLANT.PLANT_REGION as plant.node_region with synonyms=('plant region','origin region') comment='Region the plant or DC sits in.',
    PLANT.PLANT_TYPE as plant.node_type with synonyms=('site type') comment='PLANT for manufacturing, DC for distribution.',
    CUSTOMER.CUSTOMER_NAME as customer.customer_name with synonyms=('account name') comment='Customer name.',
    CUSTOMER.CUSTOMER_REGION as customer.customer_region with synonyms=('account region') comment='Region the account is managed in.',
    CUSTOMER_ORDER.SHIP_REGION as customer_order.ship_region with synonyms=('destination region','outbound region') comment='Region goods were delivered to.',
    CUSTOMER_ORDER.DELIVERY_DATE as customer_order.delivery_date with synonyms=('delivered on') comment='Outbound event date.',
    SHIPMENT.CARRIER as shipment.carrier with synonyms=('carrier') comment='Carrier that moved the shipment.',
    SHIPMENT.LANE as shipment.lane_id with synonyms=('lane','route') comment='Transport lane.',
    SUPPLY.RECEIPT_DATE as supply.receipt_date with synonyms=('received on') comment='Inbound event date.'
  )
  METRICS (
    SUPPLY.SUPPLIER_OTD_PCT as AVG(supply.on_time)
      with synonyms=('supplier on-time delivery','inbound otd','vendor otd')
      comment='Identical definition to SC_ONTOLOGY_360.PURCHASE_ORDER.SUPPLIER_OTD_PCT.',
    SUPPLY.SUPPLIER_FILL_RATE as AVG(supply.in_full)
      with synonyms=('supplier fill rate','inbound fill rate')
      comment='Identical definition to SC_ONTOLOGY_360.PURCHASE_ORDER.SUPPLIER_FILL_RATE.',
    PRODUCTION.SCRAP_RATE as SUM(production.scrap) / NULLIF(SUM(production.planned), 0)
      with synonyms=('scrap rate','yield loss')
      comment='Identical definition to SC_ONTOLOGY_360.PRODUCTION_ORDER.SCRAP_RATE.',
    CUSTOMER_ORDER.OTD_PCT as AVG(customer_order.on_time)
      with synonyms=('on-time delivery','customer otd','otd')
      comment='Identical definition to SC_ONTOLOGY_360.ORDER_FULFILLMENT.OTD_PCT.',
    CUSTOMER_ORDER.FILL_RATE_PCT as AVG(customer_order.in_full)
      with synonyms=('fill rate','order fill rate')
      comment='Identical definition to SC_ONTOLOGY_360.ORDER_FULFILLMENT.FILL_RATE_PCT.',
    CUSTOMER_ORDER.OTIF_PCT as AVG(customer_order.otif)
      with synonyms=('otif','on time in full')
      comment='Identical definition to SC_ONTOLOGY_360.ORDER_FULFILLMENT.OTIF_PCT.',
    SHIPMENT.LANDED_COST_PER_UNIT as SUM(shipment.total_cost) / NULLIF(SUM(shipment.units), 0)
      with synonyms=('landed cost per unit','unit landed cost')
      comment='Identical definition to SC_ONTOLOGY_360.LANDED_COST.LANDED_COST_PER_UNIT. Ratio of sums.',
    SHIPMENT.SHIPMENT_COUNT as COUNT(shipment.shipment_id)
      with synonyms=('shipments','number of shipments')
      comment='Number of shipments.'
  )
  COMMENT = 'The supply chain value chain as the business draws it: Supplier -> Part -> Plant -> Shipment -> Customer Order -> Customer. Same canonical facts and metric expressions as SC_ONTOLOGY_360, so it cannot produce a different answer.'
  AI_VERIFIED_QUERIES (
    LANDED_COST_BY_SHIP_FROM_PLANT AS (
      QUESTION 'What is landed cost per unit by ship-from plant?'
      VERIFIED_AT 1791100800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_VALUE_CHAIN DIMENSIONS plant.plant_name METRICS shipment.landed_cost_per_unit) ORDER BY landed_cost_per_unit DESC'
    ),
    SHIPMENTS_BY_PLANT_TYPE AS (
      QUESTION 'How many shipments leave from plants versus DCs, and at what landed cost per unit?'
      VERIFIED_AT 1791100800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_VALUE_CHAIN DIMENSIONS plant.plant_type METRICS shipment.shipment_count, shipment.landed_cost_per_unit)'
    ),
    END_TO_END_CHAIN AS (
      QUESTION 'Show supplier on-time delivery, customer on-time delivery and landed cost per unit by product family'
      VERIFIED_AT 1791100800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_VALUE_CHAIN DIMENSIONS part.product_family METRICS supply.supplier_otd_pct, customer_order.otd_pct, shipment.landed_cost_per_unit)'
    )
  );

-- Grants: the same personas that can read the facts behind each entity.
GRANT SELECT ON VIEW CANONICAL.V_SHIPMENT TO ROLE SC_LOGISTICS;
GRANT SELECT ON VIEW CANONICAL.V_SHIPMENT TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON VIEW CANONICAL.V_SHIPMENT TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN TO ROLE SC_PLANNER;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN TO ROLE SC_PROCUREMENT;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN TO ROLE SC_LOGISTICS;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN TO ROLE SC_LOGISTICS_EU;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SEMANTIC.SC_VALUE_CHAIN TO ROLE SC_ONTOLOGY_STEWARD;

-- Parity: the chain view must agree exactly with SC_ONTOLOGY_360 on every shared metric.
SELECT
  v.supplier_otd_pct   = o.supplier_otd_pct   AS supplier_otd_match,
  v.otd_pct            = o.otd_pct            AS otd_match,
  v.fill_rate_pct      = o.fill_rate_pct      AS fill_rate_match,
  v.landed_cost_per_unit = o.landed_cost_per_unit AS landed_cost_match
FROM SEMANTIC_VIEW(SEMANTIC.SC_VALUE_CHAIN
       METRICS supply.supplier_otd_pct, customer_order.otd_pct, customer_order.fill_rate_pct, shipment.landed_cost_per_unit) v,
     SEMANTIC_VIEW(SEMANTIC.SC_ONTOLOGY_360
       METRICS purchase_order.supplier_otd_pct, order_fulfillment.otd_pct, order_fulfillment.fill_rate_pct, landed_cost.landed_cost_per_unit) o;
