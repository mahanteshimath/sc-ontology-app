-- ---------------------------------------------------------------------------
-- Phase 5 — IoT shipment telemetry: closes the "IoT" line in the brief
-- ("ERP, logistics, supplier, and IoT systems"), which had no entity until now.
--
-- Design, and why each choice was made:
--
--   * GRAIN. One summary reading per physical shipment, same grain and same
--     SHIPMENT_ID as CANONICAL.FCT_LANDED_COST_SHIPMENT. A real cold-chain sensor
--     stream emits many events per shipment; this table is deliberately the
--     summary an application would consume (peak temperature, exceeded or not),
--     not the raw event stream, to avoid a one-to-many fan-out that every metric
--     and join below would otherwise have to account for.
--
--   * JOIN PATH. SHIPMENT_TELEMETRY reaches ORDER_FULFILLMENT via (ORDER_ID,
--     ORDER_LINE) — the exact shape of the existing COST_TO_FULFILLMENT edge.
--     Reusing a join key that already works safely, rather than adding a new
--     direct edge to PART or CALENDAR, is deliberate: LANDED_COST reaches those
--     only through ORDER_FULFILLMENT for exactly the multi-path reason
--     documented in 00e_semantic.sql, and the same hazard applies here.
--
--   * TWO BINDINGS, ON PURPOSE. A metric bound to only one semantic view has
--     nothing to disagree with and is reported UNTESTED, not PASS (see
--     METRIC_DRIFT_TEST in 00f). SC_TELEMETRY is a brand-new object (a plain
--     CREATE, not a splice of a live one), so it carries no splice risk; adding
--     it is what lets temp_excursion_rate genuinely earn a PASS instead of
--     merely being registered.
--
--   * THE SC_ONTOLOGY_360 SPLICE uses the exact GET_DDL + REPLACE technique
--     documented in 01_calendar_dimension.sql: short "X as Y" structural
--     anchors with no trailing comment/synonym text, each the START of the
--     INVENTORY.* entry that immediately follows LANDED_COST's own, so new
--     content is prepended before it rather than spliced into the middle of
--     LANDED_COST's own multi-clause definition.
--
--   * ROW ACCESS. FCT_SHIPMENT_TELEMETRY carries SHIP_REGION and gets the same
--     RAP_SHIP_REGION policy already applied to FCT_LANDED_COST_SHIPMENT, so an
--     EU-scoped persona cannot see non-EU telemetry through the back door.
--
--   * RATES ARE DELIBERATE, NOT ORGANIC. Excursion is generated directly as a
--     ~4.8% Bernoulli draw (mirroring the ~2.8% future-dated rate in 00c), and
--     PEAK_TEMP_C is then generated conditioned on that draw so the flag and the
--     reading can never disagree — a two-branch generator, not an independent
--     coin flip per column. The target below (3%) is deliberately set below the
--     ~4.8% actual rate so the metric renders a genuine amber/red state instead
--     of a trivially green one, consistent with how the OTD target in this
--     project is deliberately unreachable rather than decorative.
--
-- VERIFICATION NOT YET RUN AGAINST SNOWFLAKE. This file was authored against the
-- established patterns in 00b-00f and 01, but has not been executed here — no
-- live Snowflake connection was available in the authoring environment. Run
-- `node scripts/rebuild.mjs --dry-run` to confirm ordering, then
-- `node scripts/rebuild.mjs --from 10c_network_risk_scenarios.sql` (or a full
-- rebuild) and `sql/90_verify_base.sql` / `sql/93_verify_verified_queries.sql`
-- before treating this as live.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. RAW source.
-- ---------------------------------------------------------------------------

USE SCHEMA RAW;

CREATE OR REPLACE TABLE SHIPMENT_TELEMETRY (
  SHIPMENT_ID       STRING      NOT NULL COMMENT 'Shipment number. One IoT summary reading per physical shipment, same grain as SHIPMENT_COST.',
  PEAK_TEMP_C       NUMBER(5,1) NOT NULL COMMENT 'Peak in-transit temperature reading, degrees Celsius. Generated consistently with IS_TEMP_EXCURSION: never disagrees with it.',
  IS_TEMP_EXCURSION BOOLEAN     NOT NULL COMMENT 'TRUE when PEAK_TEMP_C breached the 10C cold-chain threshold. ~4.8% of shipments, by construction.',
  IS_TRANSIT_DELAY  BOOLEAN     NOT NULL COMMENT 'TRUE when the sensor-reported transit time exceeded the lane commitment. ~12% of shipments, by construction.',
  EVENT_DATE        DATE        NOT NULL COMMENT 'Date the summary reading was recorded. Delivery date, so the reading exists once the shipment has actually arrived.',
  CONSTRAINT pk_shipment_telemetry PRIMARY KEY (SHIPMENT_ID)
) COMMENT = 'In-transit IoT sensor summary per shipment: temperature and transit-time exceptions. Source for CANONICAL.FCT_SHIPMENT_TELEMETRY.';

INSERT INTO SHIPMENT_TELEMETRY
WITH t AS (
  SELECT
    sc.shipment_id,
    sc.delivery_date,
    ABS(HASH(sc.shipment_id, 'exc')) % 1000 < 48 AS is_temp_excursion,
    ABS(HASH(sc.shipment_id, 'delay')) % 100 < 12 AS is_transit_delay
  FROM SHIPMENT_COST sc
)
SELECT
  shipment_id,
  -- Breach branch: 10.5..14.49C. Safe branch: 2.0..8.99C. The two ranges never
  -- overlap, so the boolean and the reading are consistent by construction.
  IFF(is_temp_excursion,
      ROUND(10.5 + (ABS(HASH(shipment_id, 'over')) % 400) / 100.0, 1),
      ROUND(2.0  + (ABS(HASH(shipment_id, 'temp')) % 700) / 100.0, 1))   AS peak_temp_c,
  is_temp_excursion,
  is_transit_delay,
  delivery_date AS event_date
FROM t;

-- ---------------------------------------------------------------------------
-- 2. CANONICAL fact. Joins RAW.SHIPMENT_COST and RAW.CARRIER exactly as
--    FCT_LANDED_COST_SHIPMENT does, so SHIP_REGION, LANE_ID and CARRIER agree
--    with the shipment's own landed-cost row rather than being re-derived.
-- ---------------------------------------------------------------------------

USE SCHEMA CANONICAL;

CREATE OR REPLACE TABLE FCT_SHIPMENT_TELEMETRY (
  SHIPMENT_ID       STRING        NOT NULL COMMENT 'Shipment number. Same identifier as FCT_LANDED_COST_SHIPMENT.',
  ORDER_ID          STRING        NOT NULL COMMENT 'Sales order.',
  ORDER_LINE        NUMBER        NOT NULL COMMENT 'Sales order line. Joins to ORDER_FULFILLMENT exactly as LANDED_COST does.',
  CARRIER           STRING        NOT NULL COMMENT 'Carrier name.',
  LANE_ID           STRING        NOT NULL COMMENT 'Lane used.',
  SHIP_REGION       STRING        NOT NULL COMMENT 'Destination region. Scoped by the EU row access policy, same as LANDED_COST.',
  PEAK_TEMP_C       NUMBER(5,1)   NOT NULL COMMENT 'Peak in-transit temperature reading, degrees Celsius.',
  IS_TEMP_EXCURSION NUMBER(1,0)   NOT NULL COMMENT '1 when PEAK_TEMP_C breached the cold-chain threshold.',
  IS_TRANSIT_DELAY  NUMBER(1,0)   NOT NULL COMMENT '1 when the sensor-reported transit time exceeded the lane commitment.',
  EVENT_DATE        DATE          NOT NULL COMMENT 'Date the summary reading was recorded.',
  CONSTRAINT pk_fct_shipment_telemetry PRIMARY KEY (SHIPMENT_ID)
) COMMENT = 'Atomic in-transit IoT sensor summary per shipment. Canonical source for the temperature-excursion rate metric. Same grain as FCT_LANDED_COST_SHIPMENT; joins SC_ONTOLOGY_360 through ORDER_FULFILLMENT exactly as LANDED_COST does.';

INSERT INTO FCT_SHIPMENT_TELEMETRY
SELECT
  st.shipment_id,
  sc.order_id,
  sc.order_line,
  car.carrier_name AS carrier,
  sc.lane_id,
  sc.ship_region,
  st.peak_temp_c,
  IFF(st.is_temp_excursion, 1, 0) AS is_temp_excursion,
  IFF(st.is_transit_delay, 1, 0)  AS is_transit_delay,
  st.event_date
FROM SUPPLY_CHAIN.RAW.SHIPMENT_TELEMETRY st
JOIN SUPPLY_CHAIN.RAW.SHIPMENT_COST      sc  ON sc.shipment_id = st.shipment_id
JOIN SUPPLY_CHAIN.RAW.CARRIER            car ON car.carrier_id = sc.carrier_id;

ALTER TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY
  ADD ROW ACCESS POLICY SUPPLY_CHAIN.GOVERNANCE.RAP_SHIP_REGION ON (SHIP_REGION);

GRANT SELECT ON TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY TO ROLE SC_PLANNER;
GRANT SELECT ON TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY TO ROLE SC_PROCUREMENT;
GRANT SELECT ON TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY TO ROLE SC_LOGISTICS;
GRANT SELECT ON TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON TABLE SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY TO ROLE SC_ONTOLOGY_STEWARD;

-- ---------------------------------------------------------------------------
-- 3. Splice SHIPMENT_TELEMETRY into the already-live SC_ONTOLOGY_360, using the
--    exact technique documented in 01_calendar_dimension.sql. Anchors are
--    LANDED_COST strings, unaffected by the CALENDAR splice.
--
-- GET_DDL DOES NOT PRESERVE THE WHITESPACE YOU WROTE, AND THAT COST US THE VIEW.
--
-- The table anchor here used to read
--     'primary key (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)'
-- copied from 00e_semantic.sql, where it is written with spaces after the
-- commas. GET_DDL emits it WITHOUT them:
--     'primary key (SNAPSHOT_DATE,MATERIAL_ID,NODE_ID)'
--
-- So that REPLACE matched nothing and silently changed nothing, while the four
-- anchors below it matched fine. The result was a view whose RELATIONSHIPS
-- referenced SHIPMENT_TELEMETRY and whose TABLES never declared it:
--     Invalid table name 'SHIPMENT_TELEMETRY' in the RELATIONSHIPS definition
-- and because that surfaces only at EXECUTE IMMEDIATE, the failure looked like a
-- problem with the relationship rather than with the anchor three lines above it.
--
-- The whitespace is now corrected AND each anchor asserts itself first, which is
-- the rule 07_verified_queries.sql already states and this file did not follow:
--
--   ASSERT THE ANCHOR OCCURS EXACTLY ONCE BEFORE RELYING ON IT.
--   A REPLACE that matches nothing succeeds and changes nothing.
--
-- Aborting with the anchor named is strictly better than leaving an
-- uncompilable view behind, because the message points at the cause.
-- ---------------------------------------------------------------------------

USE SCHEMA SEMANTIC;

DECLARE
  ddl STRING;

  -- New logical table, inserted before the first existing table entry that
  -- follows LANDED_COST (INVENTORY) — the same "prepend before the next
  -- entry's short structural anchor" technique 01_calendar_dimension.sql uses,
  -- chosen so the insertion cannot land in the middle of LANDED_COST's own
  -- `with synonyms=(...) comment='...'` clause.
  tel_table STRING := $$SHIPMENT_TELEMETRY as SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY primary key (SHIPMENT_ID) with synonyms=('telemetry','sensor','iot','tracking','cold chain','sensor reading') comment='sco:ShipmentTelemetry - in-transit IoT sensor summary for one shipment. Fact, shipment grain. Reaches PART, CUSTOMER and CALENDAR only through ORDER_FULFILLMENT, exactly like LANDED_COST.', $$;

  tel_rel STRING := $$TELEMETRY_TO_FULFILLMENT as SHIPMENT_TELEMETRY(ORDER_ID, ORDER_LINE) references ORDER_FULFILLMENT(ORDER_ID, ORDER_LINE), $$;

  tel_facts STRING := $$SHIPMENT_TELEMETRY.EXCURSION as shipment_telemetry.is_temp_excursion comment='1 when the in-transit temperature breached the cold-chain threshold.', SHIPMENT_TELEMETRY.DELAY_FLAG as shipment_telemetry.is_transit_delay comment='1 when the sensor-reported transit time exceeded the lane commitment.', $$;

  tel_dims STRING := $$SHIPMENT_TELEMETRY.CARRIER as shipment_telemetry.carrier with synonyms=('carrier','freight carrier') comment='Carrier that moved the shipment.', SHIPMENT_TELEMETRY.LANE as shipment_telemetry.lane_id with synonyms=('lane','route') comment='Transport lane the sensor reading was recorded on.', SHIPMENT_TELEMETRY.PEAK_TEMP as shipment_telemetry.peak_temp_c with synonyms=('peak temperature','temperature reading') comment='Peak in-transit temperature, degrees Celsius.', $$;

  tel_metric STRING := $$SHIPMENT_TELEMETRY.TEMP_EXCURSION_RATE as AVG(shipment_telemetry.excursion) with synonyms=('temperature excursion rate','cold chain breach rate','iot excursion rate','sensor excursion rate') comment='Share of shipments with an in-transit temperature breach, measured from IoT sensor telemetry. Shipment-weighted, never an average of per-carrier rates.', $$;

  -- Anchors, in the exact form GET_DDL emits them. Kept in variables so each can
  -- be counted before it is used and named in the abort message if it is missing.
  a_table STRING := 'INVENTORY as SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT primary key (SNAPSHOT_DATE,MATERIAL_ID,NODE_ID)';
  a_rel   STRING := 'INVENTORY_TO_PART as INVENTORY(MATERIAL_ID)';
  a_fact  STRING := 'INVENTORY.ON_HAND as inventory.on_hand_qty';
  a_dim   STRING := 'INVENTORY.SNAPSHOT_DATE as inventory.snapshot_date';
  a_met   STRING := 'INVENTORY.DAYS_OF_INVENTORY as SUM(inventory.on_hand)';
BEGIN
  ddl := GET_DDL('SEMANTIC_VIEW', 'SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360');

  -- Already spliced? Say so rather than appending a duplicate entity.
  IF (POSITION('SHIPMENT_TELEMETRY as' IN ddl) > 0) THEN
    RETURN 'SC_ONTOLOGY_360 already carries SHIPMENT_TELEMETRY; nothing to do';
  END IF;

  -- Every anchor, or none. A partial splice is what produced an uncompilable view.
  IF (POSITION(:a_table IN ddl) = 0) THEN RETURN 'ABORT: table anchor not found: '        || :a_table; END IF;
  IF (POSITION(:a_rel   IN ddl) = 0) THEN RETURN 'ABORT: relationship anchor not found: ' || :a_rel;   END IF;
  IF (POSITION(:a_fact  IN ddl) = 0) THEN RETURN 'ABORT: fact anchor not found: '         || :a_fact;  END IF;
  IF (POSITION(:a_dim   IN ddl) = 0) THEN RETURN 'ABORT: dimension anchor not found: '    || :a_dim;   END IF;
  IF (POSITION(:a_met   IN ddl) = 0) THEN RETURN 'ABORT: metric anchor not found: '       || :a_met;   END IF;

  -- CREATE OR REPLACE drops grants; CREATE OR ALTER preserves them.
  ddl := REPLACE(ddl, 'create or replace semantic view SC_ONTOLOGY_360',
                      'create or alter semantic view SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360');

  -- Each anchor is a short structural token that STARTS the next entry after
  -- LANDED_COST's own, so new content is prepended in front of it rather than
  -- spliced into the middle of an existing multi-clause entry.
  ddl := REPLACE(ddl, :a_table, tel_table  || :a_table);
  ddl := REPLACE(ddl, :a_rel,   tel_rel    || :a_rel);
  ddl := REPLACE(ddl, :a_fact,  tel_facts  || :a_fact);
  ddl := REPLACE(ddl, :a_dim,   tel_dims   || :a_dim);
  ddl := REPLACE(ddl, :a_met,   tel_metric || :a_met);

  EXECUTE IMMEDIATE ddl;
  RETURN 'SC_ONTOLOGY_360 extended with the SHIPMENT_TELEMETRY entity';
END;

-- ---------------------------------------------------------------------------
-- 4. SC_TELEMETRY — a brand-new domain view (not a splice), so temp_excursion_rate
--    gets a genuine second binding and can PASS the drift test rather than
--    report UNTESTED. Same shape as SC_INVENTORY: one fact, its own metrics,
--    its own AI_VERIFIED_QUERIES block.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE SEMANTIC VIEW SC_TELEMETRY
  TABLES (
    SHIPMENT_TELEMETRY as SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY primary key (SHIPMENT_ID)
      with synonyms=('telemetry','sensor','iot','tracking','cold chain')
      comment='sco:ShipmentTelemetry - in-transit IoT sensor summary for one shipment. Fact, shipment grain.'
  )
  FACTS (
    SHIPMENT_TELEMETRY.EXCURSION as shipment_telemetry.is_temp_excursion comment='1 when the in-transit temperature breached the cold-chain threshold.',
    SHIPMENT_TELEMETRY.DELAY_FLAG as shipment_telemetry.is_transit_delay comment='1 when the sensor-reported transit time exceeded the lane commitment.'
  )
  DIMENSIONS (
    SHIPMENT_TELEMETRY.CARRIER as shipment_telemetry.carrier with synonyms=('carrier','freight carrier') comment='Carrier that moved the shipment.',
    SHIPMENT_TELEMETRY.LANE as shipment_telemetry.lane_id with synonyms=('lane','route') comment='Transport lane the sensor reading was recorded on.',
    SHIPMENT_TELEMETRY.PEAK_TEMP as shipment_telemetry.peak_temp_c with synonyms=('peak temperature','temperature reading') comment='Peak in-transit temperature, degrees Celsius.'
  )
  METRICS (
    SHIPMENT_TELEMETRY.TEMP_EXCURSION_RATE as AVG(shipment_telemetry.excursion)
      with synonyms=('temperature excursion rate','cold chain breach rate','iot excursion rate')
      comment='Share of shipments with an in-transit temperature breach. Identical to SHIPMENT_TELEMETRY.TEMP_EXCURSION_RATE in SC_ONTOLOGY_360.',
    SHIPMENT_TELEMETRY.TRANSIT_DELAY_RATE as AVG(shipment_telemetry.delay_flag)
      with synonyms=('transit delay rate','late shipment rate')
      comment='Share of shipments whose sensor-reported transit time exceeded the lane commitment. Not a governed metric; exploratory only.'
  )
  COMMENT = 'Shipment-level IoT telemetry. Domain-scoped subset of SC_ONTOLOGY_360; metric expressions are identical.'
  AI_VERIFIED_QUERIES (
    TEMP_EXCURSION_RATE_OVERALL AS (
      QUESTION 'What share of shipments had a temperature excursion?'
      VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_TELEMETRY METRICS shipment_telemetry.temp_excursion_rate)'
    )
  );

GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_TELEMETRY TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_TELEMETRY TO ROLE SC_LOGISTICS;
GRANT SELECT, REFERENCES ON SEMANTIC VIEW SC_TELEMETRY TO ROLE SC_LOGISTICS_EU;

-- ---------------------------------------------------------------------------
-- 5. Governance registration. Columns match what 00f, 02 and 03 already added
--    to METRIC_DEFINITION, so this metric carries the same contract as every
--    other one rather than a partial row.
-- ---------------------------------------------------------------------------

USE SCHEMA GOVERNANCE;

INSERT INTO METRIC_DEFINITION
  (metric_id, business_name, domain, definition, numerator, denominator, grain,
   canonical_fact, canonical_sql, unit, direction, owner_role, version, effective_from,
   as_of_scope, as_of_rule, target_value, warn_threshold, fail_threshold, target_source)
SELECT * FROM VALUES
 ('temp_excursion_rate','Temperature Excursion Rate','LOGISTICS',
  'Share of shipments whose in-transit IoT sensor recorded a peak temperature above the cold-chain threshold. Weighted by shipment, not an average of per-carrier rates.',
  'Shipments where PEAK_TEMP_C exceeded the cold-chain threshold','All shipments in scope','shipment',
  'CANONICAL.FCT_SHIPMENT_TELEMETRY',
  'SELECT AVG(is_temp_excursion) AS VAL FROM SUPPLY_CHAIN.CANONICAL.FCT_SHIPMENT_TELEMETRY',
  'ratio','lower','SC_LOGISTICS_ANALYST',1,CURRENT_DATE()::DATE,
  'REALIZED','Exclude future-dated rows: WHERE calendar.is_future = 0. Rows dated after today are promised future activity, not measured performance.',
  0.03, 0.045, 0.06,
  'ILLUSTRATIVE - seeded for demonstration, not a committed target. Owner: SC_LOGISTICS_ANALYST.')
AS v(metric_id, business_name, domain, definition, numerator, denominator, grain,
     canonical_fact, canonical_sql, unit, direction, owner_role, version, effective_from,
     as_of_scope, as_of_rule, target_value, warn_threshold, fail_threshold, target_source);

INSERT INTO METRIC_BINDING (metric_id, semantic_view, metric_reference, persona_role)
SELECT * FROM VALUES
 ('temp_excursion_rate','SC_ONTOLOGY_360','shipment_telemetry.temp_excursion_rate',NULL),
 ('temp_excursion_rate','SC_TELEMETRY','shipment_telemetry.temp_excursion_rate','SC_LOGISTICS');

INSERT INTO METRIC_EXCEPTION_RULE
  (metric_id, canonical_fact, date_column, exception_where, display_columns, order_by, description)
SELECT * FROM VALUES
 ('temp_excursion_rate','CANONICAL.FCT_SHIPMENT_TELEMETRY','EVENT_DATE','IS_TEMP_EXCURSION = 1',
  'SHIPMENT_ID,ORDER_ID,ORDER_LINE,CARRIER,LANE_ID,SHIP_REGION,PEAK_TEMP_C,EVENT_DATE',
  'PEAK_TEMP_C DESC','Shipments whose peak in-transit temperature breached the cold-chain threshold.');

INSERT INTO PERSONA_VIEW_ACCESS (role_name, semantic_view)
SELECT * FROM VALUES
 ('SC_ONTOLOGY_STEWARD','SC_TELEMETRY'),
 ('SC_LOGISTICS','SC_TELEMETRY'),
 ('SC_LOGISTICS_EU','SC_TELEMETRY');

-- Sanity check: temp_excursion_rate now has 2 bindings, so METRIC_DRIFT_TEST can
-- compare them instead of reporting UNTESTED. See sql/90_verify_base.sql for the
-- authoritative assertion.
SELECT metric_id, COUNT(*) AS binding_count
FROM METRIC_BINDING
WHERE metric_id = 'temp_excursion_rate'
GROUP BY metric_id;
