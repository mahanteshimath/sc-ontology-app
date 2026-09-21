-- ---------------------------------------------------------------------------
-- 00e — SEMANTIC views. The only surface the application and Cortex Analyst query.
--
-- MUST RUN BEFORE 01_calendar_dimension.sql, AND NEVER AFTER IT.
-- 01 reads this file's SC_ONTOLOGY_360 back with GET_DDL and string-splices the
-- CALENDAR entity into it. Re-running this file afterwards reverts the view to 10
-- entities, silently removing calendar.cal_date and calendar.is_future — which
-- lib/period.ts filters on for every reporting period. See sql/00_README.md.
--
-- ---------------------------------------------------------------------------
-- THREE SPLICE ANCHORS IN 01 ARE LOAD-BEARING AND VERIFIED, NOT ASSUMED
--
-- 01 inserts the CALENDAR table, its relationships and its dimensions by
-- REPLACE-ing three substrings that must each occur EXACTLY ONCE in GET_DDL
-- output:
--
--   'SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)'
--   'PO_TO_PART as PURCHASE_ORDER(MATERIAL_ID)'
--   'PART.MATERIAL as part.material_id'
--
-- Note the first one carries no `PART as` alias. That is not an oversight in 01:
-- GET_DDL omits the alias when it is identical to the base table name, so the
-- deployed DDL really does read `SUPPLY_CHAIN.RAW.PART primary key (...)`. This
-- was confirmed against this account rather than assumed, because a REPLACE on a
-- string that does not occur is a silent no-op — the view would still compile and
-- the failure would only surface later as a missing dimension.
--
-- Consequences for anything edited here:
--   * PART must remain the only logical table over SUPPLY_CHAIN.RAW.PART.
--   * The relationship must stay named PO_TO_PART and stay declared as
--     PURCHASE_ORDER(MATERIAL_ID).
--   * The dimension must stay named PART.MATERIAL over part.material_id.
-- 90_verify_base.sql asserts all three occurrence counts before 01 runs.
--
-- ---------------------------------------------------------------------------
-- WHY LANDED_COST HAS NO EDGE TO PART, AND WILL NOT GET ONE
--
-- LANDED_COST reaches PART only through COST_TO_FULFILLMENT -> ORDER_FULFILLMENT
-- -> FULFILLMENT_TO_PART. A direct LANDED_COST(MATERIAL_ID) -> PART edge looks
-- like an obvious convenience and would break every landed-cost metric: two join
-- paths to the same entity make the traversal ambiguous and Snowflake rejects the
-- query with a multi-path error. 01 relies on exactly the same reasoning to
-- justify leaving LANDED_COST unjoined to CALENDAR.
--
-- ---------------------------------------------------------------------------
-- ENTITY COMMENTS ARE PARSED, NOT DECORATION
--
-- GOVERNANCE.ONTOLOGY_ENTITY (00f) derives two columns from the comment text:
--   * ONTOLOGY_CLASS from the leading 'sco:<Class>' token
--   * ENTITY_ROLE from whether the comment contains the exact phrase
--     'Conformed dimension.'
-- Deriving them from the deployed comment rather than storing them separately is
-- what makes the catalogue on /ontology incapable of drifting from the view. The
-- cost is that rewording a comment reclassifies an entity, so every dimension
-- comment below contains that phrase verbatim and no fact comment does.
--
-- ---------------------------------------------------------------------------
-- RELATIONSHIP COUNT: 10 HERE, 14 AFTER 01
--
-- The previous build of this dataset recorded 16 relationships. Ten are
-- reconstructible from what the application and the increments actually
-- reference; 01 adds four calendar edges, giving 14. The remaining two are not
-- recoverable, and inventing edges to reach a count would be actively harmful:
-- every additional edge is a chance to create a second join path and break a
-- metric. The catalogue reports what is deployed, so 14 is simply the true number.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA SEMANTIC;

-- ---------------------------------------------------------------------------
-- SC_ONTOLOGY_360 — the cross-domain view.
--
-- The only view the application queries directly. Every other view in this file
-- is a domain-scoped subset for the conversational layer, where a narrower tool
-- resolves more reliably than one wide one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE SEMANTIC VIEW SC_ONTOLOGY_360
  TABLES (
    PART as SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)
      with synonyms=('part','material','sku','item','product')
      comment='sco:Material - what is bought, made, stocked and sold. Conformed dimension. Shared by purchasing, fulfilment, inventory, manufacturing and demand, so product family means the same thing in every domain.',
    SUPPLIER as SUPPLY_CHAIN.RAW.SUPPLIER primary key (SUPPLIER_ID)
      with synonyms=('supplier','vendor','source')
      comment='sco:Supplier - who goods are bought from. Conformed dimension. The inbound counterpart to CUSTOMER.',
    CUSTOMER as SUPPLY_CHAIN.RAW.CUSTOMER primary key (CUSTOMER_ID)
      with synonyms=('customer','account','ship-to','client')
      comment='sco:Customer - who goods are sold to. Conformed dimension. The outbound counterpart to SUPPLIER.',
    NODE as SUPPLY_CHAIN.RAW.NODE primary key (NODE_ID)
      with synonyms=('node','plant','warehouse','dc','location','site')
      comment='sco:Location - where goods are made or held. Conformed dimension. Shared by inventory and manufacturing.',
    PURCHASE_ORDER as SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE primary key (PO_ID, LINE)
      with synonyms=('purchase order','po','receipt','inbound delivery','goods receipt')
      comment='sco:InboundReceipt - one purchase-order line received from a supplier. Fact, receipt-line grain. Event date is RECEIPT_DATE.',
    ORDER_FULFILLMENT as SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT primary key (ORDER_ID, ORDER_LINE)
      with synonyms=('order fulfillment','sales order','delivery','outbound','customer order','shipment')
      comment='sco:OutboundDelivery - one customer order line delivered. Fact, order-line grain. Event date is DELIVERY_DATE. Distinct from PURCHASE_ORDER: this is delivery to a customer, not receipt from a supplier.',
    LANDED_COST as SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT primary key (SHIPMENT_ID)
      with synonyms=('landed cost','freight','cost to serve','shipment cost','transport cost')
      comment='sco:LandedCost - total delivered cost of one shipment. Fact, shipment grain. Reaches PART and CALENDAR only through ORDER_FULFILLMENT, deliberately.',
    INVENTORY as SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT primary key (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
      with synonyms=('inventory','stock','on hand','position','balance')
      comment='sco:InventoryPosition - month-end balance for one material at one node. Fact, snapshot grain. NOT additive across snapshot dates: select the latest snapshot in the period, never sum over it.',
    PRODUCTION_ORDER as SUPPLY_CHAIN.RAW.PRODUCTION_ORDER primary key (PRODUCTION_ORDER_ID)
      with synonyms=('production order','manufacturing order','work order','build')
      comment='sco:ProductionOrder - one manufacturing completion at a plant. Fact, order grain. Event date is COMPLETED_DATE.',
    FORECAST as SUPPLY_CHAIN.RAW.DEMAND_FORECAST primary key (MATERIAL_ID, PERIOD)
      with synonyms=('forecast','demand plan','planned demand')
      comment='sco:DemandForecast - monthly forecast versus actual for one material. Fact, material-period grain. Has no day-grain date, so it carries its own period dimension and is not joined to CALENDAR.'
  )
  RELATIONSHIPS (
    PO_TO_PART as PURCHASE_ORDER(MATERIAL_ID) references PART(MATERIAL_ID),
    PO_TO_SUPPLIER as PURCHASE_ORDER(SUPPLIER_ID) references SUPPLIER(SUPPLIER_ID),
    FULFILLMENT_TO_PART as ORDER_FULFILLMENT(MATERIAL_ID) references PART(MATERIAL_ID),
    FULFILLMENT_TO_CUSTOMER as ORDER_FULFILLMENT(CUSTOMER_ID) references CUSTOMER(CUSTOMER_ID),
    COST_TO_FULFILLMENT as LANDED_COST(ORDER_ID, ORDER_LINE) references ORDER_FULFILLMENT(ORDER_ID, ORDER_LINE),
    INVENTORY_TO_PART as INVENTORY(MATERIAL_ID) references PART(MATERIAL_ID),
    INVENTORY_TO_NODE as INVENTORY(NODE_ID) references NODE(NODE_ID),
    PRODUCTION_TO_PART as PRODUCTION_ORDER(MATERIAL_ID) references PART(MATERIAL_ID),
    PRODUCTION_TO_NODE as PRODUCTION_ORDER(NODE_ID) references NODE(NODE_ID),
    FORECAST_TO_PART as FORECAST(MATERIAL_ID) references PART(MATERIAL_ID)
  )
  FACTS (
    PURCHASE_ORDER.ON_TIME as purchase_order.is_on_time comment='1 when the receipt met the promised date.',
    PURCHASE_ORDER.IN_FULL as purchase_order.is_in_full comment='1 when the full ordered quantity was received.',
    PURCHASE_ORDER.PRICE_VARIANCE as purchase_order.extended_price_variance comment='Unfavourable dollars from pricing above standard.',
    ORDER_FULFILLMENT.ON_TIME as order_fulfillment.is_on_time comment='1 when delivered by the promise date.',
    ORDER_FULFILLMENT.IN_FULL as order_fulfillment.is_in_full comment='1 when the full ordered quantity shipped.',
    ORDER_FULFILLMENT.OTIF as order_fulfillment.is_otif comment='1 when on time and in full.',
    ORDER_FULFILLMENT.PERFECT as order_fulfillment.is_perfect_order comment='1 when on time, in full and date-accepted.',
    LANDED_COST.TOTAL_COST as landed_cost.total_landed_cost comment='Material + freight + duty + handling.',
    LANDED_COST.UNITS as landed_cost.shipped_qty comment='Units shipped.',
    LANDED_COST.FREIGHT as landed_cost.freight_cost comment='Accrued freight.',
    LANDED_COST.FREIGHT_INVOICED as landed_cost.invoiced_freight_amt comment='Freight the carrier invoiced.',
    LANDED_COST.BILL_VARIANCE as landed_cost.freight_bill_var_amt comment='Invoiced less accrued. Positive is overbilling.',
    INVENTORY.ON_HAND as inventory.on_hand_qty comment='Units on hand at the snapshot.',
    INVENTORY.DAILY_DEMAND as inventory.avg_daily_demand comment='Trailing average daily demand.',
    INVENTORY.VALUE as inventory.inventory_value comment='On-hand quantity at standard cost.',
    PRODUCTION_ORDER.COMPLETED as production_order.completed_qty comment='Good quantity completed.',
    PRODUCTION_ORDER.SCRAP as production_order.scrap_qty comment='Quantity scrapped.',
    PRODUCTION_ORDER.PLANNED as production_order.planned_qty comment='Quantity planned.',
    FORECAST.FORECAST_UNITS as forecast.forecast_qty comment='Forecast quantity.',
    FORECAST.ACTUAL_UNITS as forecast.actual_qty comment='Realised quantity.'
  )
  DIMENSIONS (
    PART.MATERIAL as part.material_id with synonyms=('material number','sku','item code') comment='Material identifier.',
    PART.PRODUCT_FAMILY as part.product_family with synonyms=('family','product line','category') comment='Product family. The most-used analytical grouping in the application.',
    PART.BUSINESS_SEGMENT as part.business_segment with synonyms=('segment','division','business') comment='Reporting segment the family rolls into.',
    PART.ABC_CLASS as part.abc_class with synonyms=('abc','value class','classification') comment='Inventory value class: A high-value low-volume, C the reverse.',
    SUPPLIER.SUPPLIER_NAME as supplier.supplier_name with synonyms=('vendor name','supplier') comment='Vendor name.',
    SUPPLIER.SUPPLIER_REGION as supplier.supplier_region with synonyms=('sourcing region','vendor region','inbound region') comment='Region goods are sourced from. The inbound region. Not the same as the outbound SHIP_REGION.',
    SUPPLIER.SUPPLIER_GROUP as supplier.supplier_group with synonyms=('commodity group','category') comment='Commodity group the vendor is managed under.',
    SUPPLIER.SUPPLIER_TIER as supplier.supplier_tier with synonyms=('tier','strategic tier') comment='Strategic tier. TIER_1 carries the majority of spend.',
    CUSTOMER.CUSTOMER_NAME as customer.customer_name with synonyms=('account name','customer') comment='Customer name.',
    CUSTOMER.CUSTOMER_REGION as customer.customer_region with synonyms=('account region','sales region') comment='Region the account is managed in. Where the account sits, not where goods went.',
    CUSTOMER.CUSTOMER_SEGMENT as customer.customer_segment with synonyms=('segment','go-to-market') comment='Go-to-market segment.',
    NODE.NODE_NAME as node.node_name with synonyms=('site','location name','plant name','warehouse') comment='Location name.',
    NODE.NODE_REGION as node.node_region with synonyms=('site region','network region') comment='Region the node serves.',
    NODE.NODE_TYPE as node.node_type with synonyms=('site type','facility type') comment='PLANT for manufacturing, DC for distribution.',
    PURCHASE_ORDER.RECEIPT_DATE as purchase_order.receipt_date with synonyms=('goods receipt date','received on') comment='Date goods were received. The inbound event date.',
    PURCHASE_ORDER.LATE_DAYS as purchase_order.receipt_variance_days with synonyms=('days late','receipt variance') comment='Receipt date minus promised date. Positive is late.',
    ORDER_FULFILLMENT.DELIVERY_DATE as order_fulfillment.delivery_date with synonyms=('delivered on','ship date') comment='Date delivered to the customer. The outbound event date.',
    ORDER_FULFILLMENT.CARRIER as order_fulfillment.carrier with synonyms=('carrier','freight carrier','transport provider') comment='Carrier that moved the line.',
    ORDER_FULFILLMENT.SHIP_REGION as order_fulfillment.ship_region with synonyms=('destination region','delivery region','outbound region') comment='Region goods were delivered to. The outbound region, and the column regional row scoping applies to.',
    ORDER_FULFILLMENT.DEFECT_REASON as order_fulfillment.defect_reason with synonyms=('failure reason','root cause','defect') comment='Recorded cause on lines that failed a service condition. NULL on clean lines.',
    LANDED_COST.SERVICE_LEVEL as landed_cost.service_level with synonyms=('service','freight service') comment='Committed service level.',
    LANDED_COST.LANE as landed_cost.lane_id with synonyms=('lane','route') comment='Transport lane.',
    INVENTORY.SNAPSHOT_DATE as inventory.snapshot_date with synonyms=('as of date','snapshot','balance date') comment='Month-end the balance was observed. Filter to one snapshot; do not aggregate across them.',
    PRODUCTION_ORDER.COMPLETED_DATE as production_order.completed_date with synonyms=('completion date','made on') comment='Date production completed. The manufacturing event date.',
    FORECAST.FORECAST_PERIOD as forecast.period with synonyms=('forecast month','plan period','yyyy-mm') comment='Forecast month as a YYYY-MM label. FORECAST has no day-grain date, so this is its own time dimension rather than a join to CALENDAR.'
  )
  METRICS (
    PURCHASE_ORDER.SUPPLIER_OTD_PCT as AVG(purchase_order.on_time)
      with synonyms=('supplier on-time delivery','inbound otd','vendor otd','supplier delivery performance')
      comment='Share of purchase-order lines received on or before the promised date. Receipt-line weighted, not an average of per-supplier rates. Inbound: this is supplier performance, not delivery to customers.',
    PURCHASE_ORDER.SUPPLIER_FILL_RATE as AVG(purchase_order.in_full)
      with synonyms=('supplier fill rate','inbound fill rate','vendor fill')
      comment='Share of purchase-order lines received complete.',
    PURCHASE_ORDER.PPV as SUM(purchase_order.price_variance)
      with synonyms=('purchase price variance','ppv','price variance')
      comment='Unfavourable dollars from receipts priced above standard cost, on received quantity. An absolute dollar amount: it scales with volume and period length, so it has no fixed target.',
    PURCHASE_ORDER.PO_LINE_COUNT as COUNT(purchase_order.po_id)
      with synonyms=('receipt lines','po lines','inbound line count')
      comment='Number of purchase-order receipt lines. The denominator behind the inbound rates.',
    ORDER_FULFILLMENT.OTD_PCT as AVG(order_fulfillment.on_time)
      with synonyms=('on-time delivery','customer otd','otd','delivery performance','outbound otd')
      comment='Share of customer order lines delivered on or before the promise date. Order-line weighted. Outbound: delivery to customers, not receipt from suppliers.',
    ORDER_FULFILLMENT.OTIF_PCT as AVG(order_fulfillment.otif)
      with synonyms=('on time in full','otif')
      comment='Share of order lines both on time and in full. Always at or below OTD and fill rate individually.',
    ORDER_FULFILLMENT.FILL_RATE_PCT as AVG(order_fulfillment.in_full)
      with synonyms=('fill rate','line fill','order fill rate')
      comment='Share of order lines shipped complete.',
    ORDER_FULFILLMENT.PERFECT_ORDER_PCT as AVG(order_fulfillment.perfect)
      with synonyms=('perfect order rate','perfect order')
      comment='Share of order lines on time, in full, and with the delivery date accepted. Strictly harder than OTIF.',
    ORDER_FULFILLMENT.ORDER_LINE_COUNT as COUNT(order_fulfillment.order_id)
      with synonyms=('order lines','delivery lines','outbound line count')
      comment='Number of customer order lines. The denominator behind the outbound rates.',
    LANDED_COST.LANDED_COST_PER_UNIT as SUM(landed_cost.total_cost) / NULLIF(SUM(landed_cost.units), 0)
      with synonyms=('landed cost per unit','unit landed cost','cost per unit')
      comment='Total landed cost divided by units shipped. A ratio of two sums, never an average of per-shipment ratios: the latter would weight a one-unit shipment the same as a thousand-unit one. Normalised per unit, so it is comparable across periods and does carry a target.',
    LANDED_COST.LANDED_COST_USD as SUM(landed_cost.total_cost)
      with synonyms=('landed cost','total landed cost','delivered cost')
      comment='Total landed cost. An absolute dollar amount, so no fixed target.',
    LANDED_COST.FREIGHT_COST_USD as SUM(landed_cost.freight)
      with synonyms=('freight cost','accrued freight','transport cost')
      comment='Accrued freight. An absolute dollar amount, so no fixed target.',
    LANDED_COST.FREIGHT_INVOICED_USD as SUM(landed_cost.freight_invoiced)
      with synonyms=('freight invoiced','carrier billed','invoiced freight')
      comment='Freight the carriers invoiced. An absolute dollar amount, so no fixed target.',
    LANDED_COST.FREIGHT_BILL_VARIANCE_USD as SUM(landed_cost.bill_variance)
      with synonyms=('freight bill variance','overbilling','billing variance','freight audit')
      comment='Invoiced freight less accrued freight. Positive means carriers billed more than was accrued. A to-zero metric.',
    INVENTORY.DAYS_OF_INVENTORY as SUM(inventory.on_hand) / NULLIF(SUM(inventory.daily_demand), 0)
      with synonyms=('days of inventory','days of cover','doi','days on hand','inventory days')
      comment='On-hand units divided by average daily demand. Measured at a single snapshot: a period filter must select one snapshot date, because averaging this across months mixes balances from different points in time.',
    INVENTORY.INVENTORY_VALUE_USD as SUM(inventory.value)
      with synonyms=('inventory value','stock value','on-hand value')
      comment='On-hand quantity at standard cost, at one snapshot. Never sum across snapshot dates: the result is a plausible-looking multiple of the truth.',
    PRODUCTION_ORDER.PRODUCTION_COMPLETED_UNITS as SUM(production_order.completed)
      with synonyms=('units produced','completed units','production output')
      comment='Good units completed.',
    PRODUCTION_ORDER.SCRAP_RATE as SUM(production_order.scrap) / NULLIF(SUM(production_order.planned), 0)
      with synonyms=('scrap rate','yield loss','waste rate')
      comment='Scrapped units over planned units. A ratio of sums.',
    FORECAST.FORECAST_UNITS_TOTAL as SUM(forecast.forecast_units)
      with synonyms=('forecast units','planned demand')
      comment='Forecast quantity.',
    FORECAST.FORECAST_ACCURACY as 1 - ABS(SUM(forecast.actual_units) - SUM(forecast.forecast_units)) / NULLIF(SUM(forecast.forecast_units), 0)
      with synonyms=('forecast accuracy','demand accuracy','plan accuracy')
      comment='One minus absolute forecast error over forecast. Open periods carry a zero actual, so include only closed periods when reading this.'
  )
  COMMENT = 'Cross-domain supply chain ontology. Five conformed dimensions and six facts spanning inbound, outbound, inventory, cost, manufacturing and demand, so one question can compare across domains on shared dimensions. The only semantic view the application queries directly.'
  -- -------------------------------------------------------------------------
  -- VERIFIED QUERIES. Declared here, inline, NOT spliced in later.
  --
  -- sql/07_verified_queries.sql documents a GET_DDL splice for amending an
  -- already-deployed view. That is the right tool for a live change and the wrong
  -- one for a build: its Pattern A anchors on the string 'ai_verified_queries ('
  -- and is a SILENT NO-OP against a view that has no such block yet, which is
  -- exactly how a previous build ended up with 1 verified query instead of 38.
  -- In a from-scratch build we own this statement, so the queries are declared
  -- where the view is defined and the failure mode does not exist.
  --
  -- NO VERIFIED QUERY MAY REFERENCE calendar.*. This file runs BEFORE
  -- 01_calendar_dimension.sql adds the CALENDAR entity, so a calendar reference
  -- would fail at create time. The as-of teaching example below therefore filters
  -- on the fact's own event date, which works in every view and teaches the same
  -- lesson.
  --
  -- Several of these do double duty as teaching examples for Cortex Analyst:
  -- every inventory query is written per snapshot to demonstrate the non-additive
  -- pattern, and REALIZED_PERFORMANCE_EXCLUDES_FUTURE encodes the as-of rule.
  -- -------------------------------------------------------------------------
  AI_VERIFIED_QUERIES (
    SUPPLIER_VS_CUSTOMER_OTD AS (
      QUESTION 'How does supplier on-time delivery compare with the on-time delivery we give customers?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 METRICS purchase_order.supplier_otd_pct, order_fulfillment.otd_pct)'
    ),
    OTD_BY_PRODUCT_FAMILY AS (
      QUESTION 'What is on-time delivery by product family?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS part.product_family METRICS order_fulfillment.otd_pct) ORDER BY otd_pct ASC'
    ),
    SUPPLIER_OTD_BY_REGION AS (
      QUESTION 'Which supplier regions have the worst on-time delivery?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS supplier.supplier_region METRICS purchase_order.supplier_otd_pct, purchase_order.po_line_count) ORDER BY supplier_otd_pct ASC'
    ),
    INVENTORY_DAYS_AT_LATEST_SNAPSHOT AS (
      QUESTION 'How many days of inventory are we holding?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS inventory.snapshot_date METRICS inventory.days_of_inventory) QUALIFY snapshot_date = MAX(snapshot_date) OVER ()'
    ),
    LANDED_COST_PER_UNIT_BY_FAMILY AS (
      QUESTION 'What is landed cost per unit by product family?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS part.product_family METRICS landed_cost.landed_cost_per_unit) ORDER BY landed_cost_per_unit DESC'
    ),
    FREIGHT_BILL_VARIANCE_BY_CARRIER AS (
      QUESTION 'Are carriers billing us more than we accrued for freight?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS order_fulfillment.carrier METRICS landed_cost.freight_cost_usd, landed_cost.freight_invoiced_usd, landed_cost.freight_bill_variance_usd) ORDER BY freight_bill_variance_usd DESC'
    ),
    REALIZED_PERFORMANCE_EXCLUDES_FUTURE AS (
      QUESTION 'What is our realized on-time delivery, excluding orders that have not been delivered yet?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 METRICS order_fulfillment.otd_pct WHERE order_fulfillment.delivery_date <= CURRENT_DATE())'
    ),
    PERFECT_ORDER_VS_OTIF AS (
      QUESTION 'What is the difference between our perfect order rate and OTIF?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 METRICS order_fulfillment.otd_pct, order_fulfillment.fill_rate_pct, order_fulfillment.otif_pct, order_fulfillment.perfect_order_pct)'
    ),
    PPV_BY_SUPPLIER_TIER AS (
      QUESTION 'Where is purchase price variance coming from by supplier tier?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 DIMENSIONS supplier.supplier_tier METRICS purchase_order.ppv) ORDER BY ppv DESC'
    )
  );

-- ---------------------------------------------------------------------------
-- Domain views.
--
-- WHY NARROWER VIEWS EXIST AT ALL. These are not a different definition of
-- anything — each metric expression is identical to its SC_ONTOLOGY_360 twin, and
-- METRIC_DRIFT_TEST asserts that agreement on every run. They exist because a
-- conversational tool resolves more reliably over a small, domain-scoped surface
-- than over an eleven-entity one, and because persona access is granted per view:
-- PERSONA_VIEW_ACCESS can give procurement the supplier view without also giving
-- it landed cost.
--
-- Duplicating an expression is the risk this project is about, so the drift test
-- is the control: if someone edits a metric here and not there, the next run
-- fails with a non-zero spread and names both bindings.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE SEMANTIC VIEW SC_SUPPLIER
  TABLES (
    SUPPLIER_DELIVERY as SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE primary key (PO_ID, LINE)
      with synonyms=('supplier delivery','purchase order receipt','inbound')
      comment='sco:InboundReceipt - one purchase-order line received. Fact, receipt-line grain.'
  )
  FACTS (
    SUPPLIER_DELIVERY.ON_TIME as supplier_delivery.is_on_time comment='1 when received by the promised date.',
    SUPPLIER_DELIVERY.IN_FULL as supplier_delivery.is_in_full comment='1 when received complete.',
    SUPPLIER_DELIVERY.PRICE_VARIANCE as supplier_delivery.extended_price_variance comment='Unfavourable pricing dollars.'
  )
  DIMENSIONS (
    SUPPLIER_DELIVERY.SUPPLIER_NAME as supplier_delivery.supplier_name with synonyms=('vendor','supplier') comment='Vendor name.',
    SUPPLIER_DELIVERY.SUPPLIER_REGION as supplier_delivery.supplier_region with synonyms=('sourcing region','vendor region') comment='Region goods are sourced from.',
    SUPPLIER_DELIVERY.SUPPLIER_TIER as supplier_delivery.supplier_tier with synonyms=('tier') comment='Strategic tier.',
    SUPPLIER_DELIVERY.PRODUCT_FAMILY as supplier_delivery.product_family with synonyms=('family','category') comment='Product family.',
    SUPPLIER_DELIVERY.RECEIPT_DATE as supplier_delivery.receipt_date with synonyms=('goods receipt date') comment='Date goods were received.'
  )
  METRICS (
    SUPPLIER_DELIVERY.SUPPLIER_OTD_PCT as AVG(supplier_delivery.on_time)
      with synonyms=('supplier on-time delivery','inbound otd','vendor otd')
      comment='Share of purchase-order lines received on or before the promised date. Receipt-line weighted. Identical to PURCHASE_ORDER.SUPPLIER_OTD_PCT in SC_ONTOLOGY_360.',
    SUPPLIER_DELIVERY.SUPPLIER_FILL_RATE as AVG(supplier_delivery.in_full)
      with synonyms=('supplier fill rate','inbound fill rate')
      comment='Share of purchase-order lines received complete.',
    SUPPLIER_DELIVERY.PPV as SUM(supplier_delivery.price_variance)
      with synonyms=('purchase price variance','ppv')
      comment='Unfavourable dollars from receipts above standard cost.'
  )
  COMMENT = 'Supplier delivery and purchasing performance. Domain-scoped subset of SC_ONTOLOGY_360 for the conversational layer; metric expressions are identical.'
  AI_VERIFIED_QUERIES (
    SUPPLIER_OTD_OVERALL AS (
      QUESTION 'What is our supplier on-time delivery?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER METRICS supplier_delivery.supplier_otd_pct)'
    ),
    SUPPLIER_OTD_BY_REGION AS (
      QUESTION 'Which sourcing regions are late most often?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER DIMENSIONS supplier_delivery.supplier_region METRICS supplier_delivery.supplier_otd_pct) ORDER BY supplier_otd_pct ASC'
    ),
    SUPPLIER_FILL_RATE_BY_TIER AS (
      QUESTION 'Do our strategic suppliers ship complete more often than the rest?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER DIMENSIONS supplier_delivery.supplier_tier METRICS supplier_delivery.supplier_fill_rate) ORDER BY supplier_tier'
    ),
    PPV_BY_PRODUCT_FAMILY AS (
      QUESTION 'Which product families are we overpaying for against standard cost?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER DIMENSIONS supplier_delivery.product_family METRICS supplier_delivery.ppv) ORDER BY ppv DESC'
    ),
    WORST_SUPPLIERS_BY_OTD AS (
      QUESTION 'Which individual suppliers have the worst on-time delivery?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER DIMENSIONS supplier_delivery.supplier_name METRICS supplier_delivery.supplier_otd_pct) ORDER BY supplier_otd_pct ASC LIMIT 20'
    )
  );

CREATE OR REPLACE SEMANTIC VIEW SC_FULFILLMENT
  TABLES (
    ORDER_FULFILLMENT as SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT primary key (ORDER_ID, ORDER_LINE)
      with synonyms=('order fulfillment','delivery','outbound','customer order')
      comment='sco:OutboundDelivery - one customer order line delivered. Fact, order-line grain.'
  )
  FACTS (
    ORDER_FULFILLMENT.ON_TIME as order_fulfillment.is_on_time comment='1 when delivered by the promise date.',
    ORDER_FULFILLMENT.IN_FULL as order_fulfillment.is_in_full comment='1 when shipped complete.',
    ORDER_FULFILLMENT.OTIF as order_fulfillment.is_otif comment='1 when on time and in full.',
    ORDER_FULFILLMENT.PERFECT as order_fulfillment.is_perfect_order comment='1 when on time, in full and date-accepted.'
  )
  DIMENSIONS (
    ORDER_FULFILLMENT.PRODUCT_FAMILY as order_fulfillment.product_family with synonyms=('family','category','product line') comment='Product family.',
    ORDER_FULFILLMENT.CUSTOMER_REGION as order_fulfillment.customer_region with synonyms=('account region') comment='Region the account is managed in.',
    ORDER_FULFILLMENT.SHIP_REGION as order_fulfillment.ship_region with synonyms=('destination region','delivery region') comment='Region goods were delivered to.',
    ORDER_FULFILLMENT.CARRIER as order_fulfillment.carrier with synonyms=('carrier','transport provider') comment='Carrier that moved the line.',
    ORDER_FULFILLMENT.DEFECT_REASON as order_fulfillment.defect_reason with synonyms=('failure reason','root cause') comment='Recorded cause on failed lines.',
    ORDER_FULFILLMENT.DELIVERY_DATE as order_fulfillment.delivery_date with synonyms=('delivered on') comment='Date delivered.'
  )
  METRICS (
    ORDER_FULFILLMENT.OTD_PCT as AVG(order_fulfillment.on_time)
      with synonyms=('on-time delivery','customer otd','otd')
      comment='Share of customer order lines delivered on or before the promise date. Identical to ORDER_FULFILLMENT.OTD_PCT in SC_ONTOLOGY_360.',
    ORDER_FULFILLMENT.OTIF_PCT as AVG(order_fulfillment.otif)
      with synonyms=('on time in full','otif') comment='Share of order lines on time and in full.',
    ORDER_FULFILLMENT.FILL_RATE_PCT as AVG(order_fulfillment.in_full)
      with synonyms=('fill rate','line fill') comment='Share of order lines shipped complete.',
    ORDER_FULFILLMENT.PERFECT_ORDER_PCT as AVG(order_fulfillment.perfect)
      with synonyms=('perfect order rate') comment='Share of order lines on time, in full and date-accepted.'
  )
  COMMENT = 'Customer fulfilment performance. Domain-scoped subset of SC_ONTOLOGY_360; metric expressions are identical.'
  AI_VERIFIED_QUERIES (
    OTD_OVERALL AS (
      QUESTION 'What is our on-time delivery to customers?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT METRICS order_fulfillment.otd_pct)'
    ),
    OTD_BY_PRODUCT_FAMILY AS (
      QUESTION 'What is on-time delivery by product family?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT DIMENSIONS order_fulfillment.product_family METRICS order_fulfillment.otd_pct) ORDER BY otd_pct ASC'
    ),
    OTIF_BY_SHIP_REGION AS (
      QUESTION 'Which destination regions are worst for on time in full?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT DIMENSIONS order_fulfillment.ship_region METRICS order_fulfillment.otif_pct) ORDER BY otif_pct ASC'
    ),
    FILL_RATE_BY_CARRIER AS (
      QUESTION 'Does fill rate differ by carrier?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT DIMENSIONS order_fulfillment.carrier METRICS order_fulfillment.fill_rate_pct, order_fulfillment.otd_pct) ORDER BY fill_rate_pct ASC'
    ),
    PERFECT_ORDER_BY_FAMILY AS (
      QUESTION 'What is our perfect order rate by product family?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT DIMENSIONS order_fulfillment.product_family METRICS order_fulfillment.perfect_order_pct) ORDER BY perfect_order_pct ASC'
    ),
    DEFECT_REASONS_FOR_FAILED_LINES AS (
      QUESTION 'Why are our deliveries failing?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT DIMENSIONS order_fulfillment.defect_reason METRICS order_fulfillment.otd_pct) WHERE defect_reason IS NOT NULL ORDER BY otd_pct ASC'
    )
  );

CREATE OR REPLACE SEMANTIC VIEW SC_INVENTORY
  TABLES (
    INVENTORY as SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT primary key (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
      with synonyms=('inventory','stock','position')
      comment='sco:InventoryPosition - month-end balance for one material at one node. Fact, snapshot grain. NOT additive across snapshot dates.'
  )
  FACTS (
    INVENTORY.ON_HAND as inventory.on_hand_qty comment='Units on hand.',
    INVENTORY.DAILY_DEMAND as inventory.avg_daily_demand comment='Average daily demand.',
    INVENTORY.VALUE as inventory.inventory_value comment='On-hand at standard cost.',
    INVENTORY.STOCKED_OUT as inventory.is_stocked_out comment='1 when nothing is available to promise.'
  )
  DIMENSIONS (
    INVENTORY.SNAPSHOT_DATE as inventory.snapshot_date with synonyms=('as of date','snapshot') comment='Month-end observed. Filter to one snapshot; never aggregate across them.',
    INVENTORY.PRODUCT_FAMILY as inventory.product_family with synonyms=('family') comment='Product family.',
    INVENTORY.ABC_CLASS as inventory.abc_class with synonyms=('abc','value class') comment='Inventory value class.',
    INVENTORY.NODE_NAME as inventory.node_name with synonyms=('site','warehouse') comment='Stocking location.',
    INVENTORY.NODE_REGION as inventory.node_region with synonyms=('network region') comment='Region the node serves.'
  )
  METRICS (
    INVENTORY.DAYS_OF_INVENTORY as SUM(inventory.on_hand) / NULLIF(SUM(inventory.daily_demand), 0)
      with synonyms=('days of inventory','days of cover','doi')
      comment='On-hand over average daily demand at one snapshot. Identical to INVENTORY.DAYS_OF_INVENTORY in SC_ONTOLOGY_360.',
    INVENTORY.INVENTORY_VALUE_USD as SUM(inventory.value)
      with synonyms=('inventory value','stock value')
      comment='On-hand at standard cost, at one snapshot. Never sum across snapshot dates.',
    INVENTORY.STOCKOUT_RATE as AVG(inventory.stocked_out)
      with synonyms=('stockout rate','out of stock rate')
      comment='Share of material-node positions with nothing available to promise.'
  )
  COMMENT = 'Inventory positions and cover. Domain-scoped subset of SC_ONTOLOGY_360; metric expressions are identical. Snapshot grain: not additive over time.'
  -- EVERY QUERY HERE IS WRITTEN PER SNAPSHOT, ON PURPOSE.
  --
  -- These are teaching examples as much as shortcuts. A snapshot is a balance, so
  -- aggregating across snapshot dates double-counts the same physical stock and
  -- produces a plausible number that is wrong by a factor of however many months
  -- are in range. Showing Cortex Analyst the QUALIFY-the-latest-snapshot pattern
  -- in every single verified query is more reliable than describing the rule in
  -- prose and hoping it generalises.
  AI_VERIFIED_QUERIES (
    DAYS_OF_INVENTORY_LATEST AS (
      QUESTION 'How many days of inventory are we holding?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date METRICS inventory.days_of_inventory) QUALIFY snapshot_date = MAX(snapshot_date) OVER ()'
    ),
    INVENTORY_VALUE_LATEST AS (
      QUESTION 'What is our inventory value?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date METRICS inventory.inventory_value_usd) QUALIFY snapshot_date = MAX(snapshot_date) OVER ()'
    ),
    DAYS_BY_ABC_CLASS_LATEST AS (
      QUESTION 'How does days of inventory differ by ABC class?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT abc_class, days_of_inventory FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date, inventory.abc_class METRICS inventory.days_of_inventory) QUALIFY snapshot_date = MAX(snapshot_date) OVER () ORDER BY abc_class'
    ),
    INVENTORY_VALUE_BY_NODE_LATEST AS (
      QUESTION 'Which locations hold the most inventory value?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT node_name, inventory_value_usd FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date, inventory.node_name METRICS inventory.inventory_value_usd) QUALIFY snapshot_date = MAX(snapshot_date) OVER () ORDER BY inventory_value_usd DESC'
    ),
    STOCKOUT_RATE_LATEST AS (
      QUESTION 'What share of our stocking positions are out of stock?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date METRICS inventory.stockout_rate) QUALIFY snapshot_date = MAX(snapshot_date) OVER ()'
    ),
    DAYS_BY_FAMILY_LATEST AS (
      QUESTION 'Which product families are overstocked?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT product_family, days_of_inventory FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY DIMENSIONS inventory.snapshot_date, inventory.product_family METRICS inventory.days_of_inventory) QUALIFY snapshot_date = MAX(snapshot_date) OVER () ORDER BY days_of_inventory DESC'
    )
  );

CREATE OR REPLACE SEMANTIC VIEW SC_LANDED_COST
  TABLES (
    LANDED_COST as SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT primary key (SHIPMENT_ID)
      with synonyms=('landed cost','freight','cost to serve')
      comment='sco:LandedCost - total delivered cost of one shipment. Fact, shipment grain.'
  )
  FACTS (
    LANDED_COST.TOTAL_COST as landed_cost.total_landed_cost comment='Material + freight + duty + handling.',
    LANDED_COST.UNITS as landed_cost.shipped_qty comment='Units shipped.',
    LANDED_COST.FREIGHT as landed_cost.freight_cost comment='Accrued freight.',
    LANDED_COST.FREIGHT_INVOICED as landed_cost.invoiced_freight_amt comment='Freight invoiced.',
    LANDED_COST.BILL_VARIANCE as landed_cost.freight_bill_var_amt comment='Invoiced less accrued.'
  )
  DIMENSIONS (
    LANDED_COST.CARRIER as landed_cost.carrier with synonyms=('carrier') comment='Carrier.',
    LANDED_COST.SHIP_REGION as landed_cost.ship_region with synonyms=('destination region') comment='Region delivered to.',
    LANDED_COST.SERVICE_LEVEL as landed_cost.service_level with synonyms=('service') comment='Committed service level.',
    LANDED_COST.PRODUCT_FAMILY as landed_cost.product_family with synonyms=('family') comment='Product family.',
    LANDED_COST.DELIVERY_DATE as landed_cost.delivery_date with synonyms=('delivered on') comment='Delivery date.'
  )
  METRICS (
    LANDED_COST.LANDED_COST_PER_UNIT as SUM(landed_cost.total_cost) / NULLIF(SUM(landed_cost.units), 0)
      with synonyms=('landed cost per unit','cost per unit')
      comment='Total landed cost over units shipped. A ratio of sums. Identical to LANDED_COST.LANDED_COST_PER_UNIT in SC_ONTOLOGY_360.',
    LANDED_COST.LANDED_COST_USD as SUM(landed_cost.total_cost)
      with synonyms=('landed cost','delivered cost') comment='Total landed cost.',
    LANDED_COST.FREIGHT_COST_USD as SUM(landed_cost.freight)
      with synonyms=('freight cost','accrued freight') comment='Accrued freight.',
    LANDED_COST.FREIGHT_INVOICED_USD as SUM(landed_cost.freight_invoiced)
      with synonyms=('freight invoiced','carrier billed') comment='Freight invoiced by carriers.',
    LANDED_COST.FREIGHT_BILL_VARIANCE_USD as SUM(landed_cost.bill_variance)
      with synonyms=('freight bill variance','overbilling') comment='Invoiced less accrued freight. A to-zero metric.'
  )
  COMMENT = 'Landed cost and freight billing. Domain-scoped subset of SC_ONTOLOGY_360; metric expressions are identical.'
  AI_VERIFIED_QUERIES (
    LANDED_COST_PER_UNIT_OVERALL AS (
      QUESTION 'What is our landed cost per unit?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST METRICS landed_cost.landed_cost_per_unit)'
    ),
    LANDED_COST_PER_UNIT_BY_CARRIER AS (
      QUESTION 'Which carriers cost us the most per unit?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST DIMENSIONS landed_cost.carrier METRICS landed_cost.landed_cost_per_unit) ORDER BY landed_cost_per_unit DESC'
    ),
    FREIGHT_VARIANCE_BY_CARRIER AS (
      QUESTION 'Are carriers overbilling us for freight?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST DIMENSIONS landed_cost.carrier METRICS landed_cost.freight_cost_usd, landed_cost.freight_invoiced_usd, landed_cost.freight_bill_variance_usd) ORDER BY freight_bill_variance_usd DESC'
    ),
    COST_BY_SERVICE_LEVEL AS (
      QUESTION 'How much more does expedited freight cost us?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST DIMENSIONS landed_cost.service_level METRICS landed_cost.landed_cost_per_unit, landed_cost.freight_cost_usd) ORDER BY landed_cost_per_unit DESC'
    ),
    LANDED_COST_BY_SHIP_REGION AS (
      QUESTION 'What does it cost to serve each destination region?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST DIMENSIONS landed_cost.ship_region METRICS landed_cost.landed_cost_per_unit, landed_cost.landed_cost_usd) ORDER BY landed_cost_per_unit DESC'
    )
  );

CREATE OR REPLACE SEMANTIC VIEW SC_DEMAND
  TABLES (
    FORECAST as SUPPLY_CHAIN.RAW.DEMAND_FORECAST primary key (MATERIAL_ID, PERIOD)
      with synonyms=('forecast','demand plan')
      comment='sco:DemandForecast - monthly forecast versus actual for one material. Fact, material-period grain.',
    PART as SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)
      with synonyms=('part','material','sku')
      comment='sco:Material - what is forecast. Conformed dimension.'
  )
  RELATIONSHIPS (
    DEMAND_TO_PART as FORECAST(MATERIAL_ID) references PART(MATERIAL_ID)
  )
  FACTS (
    FORECAST.FORECAST_UNITS as forecast.forecast_qty comment='Forecast quantity.',
    FORECAST.ACTUAL_UNITS as forecast.actual_qty comment='Realised quantity. Zero for periods that have not closed.'
  )
  DIMENSIONS (
    FORECAST.FORECAST_PERIOD as forecast.period with synonyms=('forecast month','yyyy-mm') comment='Forecast month as a YYYY-MM label.',
    PART.PRODUCT_FAMILY as part.product_family with synonyms=('family') comment='Product family.',
    PART.ABC_CLASS as part.abc_class with synonyms=('abc') comment='Inventory value class.'
  )
  METRICS (
    FORECAST.FORECAST_UNITS_TOTAL as SUM(forecast.forecast_units)
      with synonyms=('forecast units','planned demand') comment='Forecast quantity.',
    FORECAST.ACTUAL_UNITS_TOTAL as SUM(forecast.actual_units)
      with synonyms=('actual units','realised demand') comment='Realised quantity. Zero in open periods.',
    FORECAST.FORECAST_ACCURACY as 1 - ABS(SUM(forecast.actual_units) - SUM(forecast.forecast_units)) / NULLIF(SUM(forecast.forecast_units), 0)
      with synonyms=('forecast accuracy','demand accuracy')
      comment='One minus absolute error over forecast. Include only closed periods: an open period has a zero actual and would read as total inaccuracy.'
  )
  COMMENT = 'Demand forecast versus actual. Domain-scoped view for the conversational layer.'
  AI_VERIFIED_QUERIES (
    FORECAST_ACCURACY_OVERALL AS (
      QUESTION 'How accurate is our demand forecast?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      -- Filters on the FACT forecast.actual_units, not the metric
      -- forecast.actual_units_total. A semantic-view WHERE clause accepts only a
      -- DIMENSION or a FACT; referencing a metric there fails with "must be one of
      -- the following types: (DIMENSION, FACT)". The filter matters either way:
      -- an open period carries a zero actual and would read as total inaccuracy.
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_DEMAND METRICS forecast.forecast_accuracy WHERE forecast.actual_units > 0)'
    ),
    FORECAST_ACCURACY_BY_FAMILY AS (
      QUESTION 'Which product families are hardest to forecast?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_DEMAND DIMENSIONS part.product_family METRICS forecast.forecast_accuracy) ORDER BY forecast_accuracy ASC'
    ),
    FORECAST_VS_ACTUAL_BY_PERIOD AS (
      QUESTION 'How has forecast accuracy moved month by month?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_DEMAND DIMENSIONS forecast.forecast_period METRICS forecast.forecast_units_total, forecast.actual_units_total) ORDER BY forecast_period'
    )
  );

CREATE OR REPLACE SEMANTIC VIEW SC_MANUFACTURING
  TABLES (
    PRODUCTION_ORDER as SUPPLY_CHAIN.RAW.PRODUCTION_ORDER primary key (PRODUCTION_ORDER_ID)
      with synonyms=('production order','work order','build')
      comment='sco:ProductionOrder - one manufacturing completion. Fact, order grain.',
    PART as SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)
      with synonyms=('part','material') comment='sco:Material - what was produced. Conformed dimension.',
    NODE as SUPPLY_CHAIN.RAW.NODE primary key (NODE_ID)
      with synonyms=('plant','site') comment='sco:Location - where it was produced. Conformed dimension.'
  )
  RELATIONSHIPS (
    MFG_TO_PART as PRODUCTION_ORDER(MATERIAL_ID) references PART(MATERIAL_ID),
    MFG_TO_NODE as PRODUCTION_ORDER(NODE_ID) references NODE(NODE_ID)
  )
  FACTS (
    PRODUCTION_ORDER.COMPLETED as production_order.completed_qty comment='Good units completed.',
    PRODUCTION_ORDER.SCRAP as production_order.scrap_qty comment='Units scrapped.',
    PRODUCTION_ORDER.PLANNED as production_order.planned_qty comment='Units planned.'
  )
  DIMENSIONS (
    PRODUCTION_ORDER.COMPLETED_DATE as production_order.completed_date with synonyms=('completion date') comment='Date production completed.',
    PART.PRODUCT_FAMILY as part.product_family with synonyms=('family') comment='Product family.',
    NODE.NODE_NAME as node.node_name with synonyms=('plant','site') comment='Producing plant.',
    NODE.NODE_REGION as node.node_region with synonyms=('region') comment='Region of the plant.'
  )
  METRICS (
    PRODUCTION_ORDER.PRODUCTION_COMPLETED_UNITS as SUM(production_order.completed)
      with synonyms=('units produced','output') comment='Good units completed.',
    PRODUCTION_ORDER.SCRAP_RATE as SUM(production_order.scrap) / NULLIF(SUM(production_order.planned), 0)
      with synonyms=('scrap rate','yield loss')
      comment='Scrapped over planned units. A ratio of sums, not an average of per-order rates.',
    PRODUCTION_ORDER.SCHEDULE_ADHERENCE as AVG(IFF(production_order.completed_date <= production_order.scheduled_date, 1, 0))
      with synonyms=('schedule adherence','on-time completion')
      comment='Share of production orders completed by the scheduled date.'
  )
  COMMENT = 'Manufacturing output and scrap. Domain-scoped view for the conversational layer.'
  AI_VERIFIED_QUERIES (
    SCRAP_RATE_BY_PLANT AS (
      QUESTION 'Which plants have the highest scrap rate?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_MANUFACTURING DIMENSIONS node.node_name METRICS production_order.scrap_rate, production_order.production_completed_units) ORDER BY scrap_rate DESC'
    ),
    SCHEDULE_ADHERENCE_OVERALL AS (
      QUESTION 'Are we completing production orders on schedule?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_MANUFACTURING METRICS production_order.schedule_adherence)'
    )
  );

-- ---------------------------------------------------------------------------
-- SC_SUPPLIER_LEGACY_DEFECT — the negative control. DELIBERATELY WRONG.
--
-- This view reproduces the average-of-averages bug on purpose, and must never be
-- fixed. Its whole function is to prove METRIC_DRIFT_TEST can fail: a control that
-- only ever passes is indistinguishable from a control that is not running, and
-- 06_drift_notification.sql binds this view specifically to demonstrate a failing
-- run end to end, including the alert and the email.
--
-- THE BUG. It reads V_SUPPLIER_OTD_BY_MONTH, where on-time rate is already
-- averaged per supplier per month, and then takes an unweighted AVG of those
-- rates. A supplier with three receipt lines in a month therefore carries the same
-- weight as one with nine hundred. The correct metric — every other supplier view
-- here — averages the 1/0 flag across receipt lines, so each line counts once.
--
-- This is the single most common way a governed metric silently diverges: both
-- numbers are called "supplier OTD", both are plausible, and nothing in a
-- dashboard reveals which weighting produced which.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW SUPPLY_CHAIN.CANONICAL.V_SUPPLIER_OTD_BY_MONTH
  COMMENT = 'Supplier on-time rate pre-aggregated per supplier per month. Exists ONLY to back SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT, the deliberately-defective negative control. Do not build a governed metric on this: averaging a rate that is already a rate discards line weighting.'
AS
SELECT
  supplier_id,
  supplier_name,
  supplier_region,
  DATE_TRUNC('MONTH', receipt_date)          AS month_start,
  AVG(is_on_time)                            AS otd_rate,
  COUNT(*)                                   AS line_count
FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
GROUP BY supplier_id, supplier_name, supplier_region, DATE_TRUNC('MONTH', receipt_date);

CREATE OR REPLACE SEMANTIC VIEW SC_SUPPLIER_LEGACY_DEFECT
  TABLES (
    SUPPLIER as SUPPLY_CHAIN.CANONICAL.V_SUPPLIER_OTD_BY_MONTH primary key (SUPPLIER_ID, MONTH_START)
      with synonyms=('supplier','vendor')
      comment='sco:Supplier - supplier-month pre-aggregate. Fact, supplier-month grain. NOT receipt-line grain, which is the source of the defect this view exists to demonstrate.'
  )
  FACTS (
    SUPPLIER.MONTHLY_OTD_RATE as supplier.otd_rate comment='On-time rate for one supplier in one month. Already a rate: averaging it again loses line weighting.',
    SUPPLIER.LINES as supplier.line_count comment='Receipt lines behind the monthly rate. The weight the defective metric ignores.'
  )
  DIMENSIONS (
    SUPPLIER.SUPPLIER_NAME as supplier.supplier_name with synonyms=('vendor') comment='Vendor name.',
    SUPPLIER.SUPPLIER_REGION as supplier.supplier_region with synonyms=('region') comment='Sourcing region.',
    SUPPLIER.MONTH_START as supplier.month_start with synonyms=('month') comment='Month of the pre-aggregate.'
  )
  METRICS (
    SUPPLIER.SUPPLIER_OTD_PCT as AVG(supplier.monthly_otd_rate)
      with synonyms=('supplier on-time delivery','inbound otd')
      comment='DEFECTIVE ON PURPOSE. Unweighted average of per-supplier-per-month on-time rates, so a supplier with 3 receipt lines counts as much as one with 900. The governed definition averages the 1/0 flag across receipt lines. Kept as a negative control to prove the drift test can fail; never fix it.'
  )
  COMMENT = 'NEGATIVE CONTROL - DELIBERATELY DEFECTIVE. Reproduces the average-of-averages bug for supplier OTD so that METRIC_DRIFT_TEST is demonstrably capable of failing. Not bound to any persona and never used for reporting.';

-- ---------------------------------------------------------------------------
-- Persona access. Per view, so a persona sees only its domain.
--
-- REFERENCES is required alongside SELECT: Cortex Analyst reads the view's
-- metadata to resolve a question before it runs anything, and SELECT alone leaves
-- it unable to see the metric list.
--
-- SC_SUPPLIER_LEGACY_DEFECT is granted to nobody. It is bound in
-- METRIC_BINDING under the NEGATIVE_CONTROL persona so the drift test reaches it
-- with owner's rights, and no human persona should ever be able to query it.
-- ---------------------------------------------------------------------------

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_ONTOLOGY_360 TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_SUPPLIER     TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_FULFILLMENT  TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_INVENTORY    TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_LANDED_COST  TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_DEMAND       TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_MANUFACTURING TO ROLE SC_ONTOLOGY_STEWARD;

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_ONTOLOGY_360 TO ROLE SC_PROCUREMENT;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_SUPPLIER     TO ROLE SC_PROCUREMENT;

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_ONTOLOGY_360 TO ROLE SC_LOGISTICS;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_FULFILLMENT  TO ROLE SC_LOGISTICS;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_LANDED_COST  TO ROLE SC_LOGISTICS;

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_ONTOLOGY_360 TO ROLE SC_LOGISTICS_EU;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_FULFILLMENT  TO ROLE SC_LOGISTICS_EU;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_LANDED_COST  TO ROLE SC_LOGISTICS_EU;

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_ONTOLOGY_360 TO ROLE SC_PLANNER;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_INVENTORY    TO ROLE SC_PLANNER;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_DEMAND       TO ROLE SC_PLANNER;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_FULFILLMENT  TO ROLE SC_PLANNER;
