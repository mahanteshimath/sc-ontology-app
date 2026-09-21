-- ---------------------------------------------------------------------------
-- 00b — RAW conformed dimensions and reference data.
--
-- DETERMINISM. Nothing here uses RANDOM(). Every derived attribute is a function
-- of the row's sequence number via ABS(HASH(seq, 'salt')), so a rebuild produces
-- byte-identical dimensions. RANDOM() with a seed is reproducible only if row
-- order is, and row order under a parallel GENERATOR is not guaranteed — which
-- would mean supplier 41 changing region between rebuilds and every historical
-- metric value moving with it.
--
-- DATE_DIM COLUMN NAMES ARE A CONTRACT. 01_calendar_dimension.sql maps
-- CALENDAR.CAL_DATE, CAL_MONTH, CAL_PERIOD, CAL_QUARTER, CAL_YEAR and IS_WEEKDAY
-- onto date_key, month_start, period, fiscal_quarter, year_num and is_weekday
-- respectively. Renaming any of them breaks the splice silently: the semantic
-- view still compiles, and the failure surfaces later as an unresolved dimension
-- on every page that applies a reporting period.
--
-- The range is 2024-01-01..2026-12-31, wider on both sides than the transactional
-- data in 00c (2024-10-03..2026-11-25). A date dimension that stops at the last
-- fact row cannot express "no activity in this period", and IS_FUTURE needs dates
-- beyond today to be meaningful at all.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA RAW;

-- ---------------------------------------------------------------------------
-- DATE_DIM — the conformed time dimension.
--
-- FISCAL_QUARTER is calendar-aligned on purpose. A genuine 3M fiscal calendar
-- would be a guess, and a wrong fiscal boundary silently misstates every
-- quarter-grain number; calendar alignment is at least verifiably what it says.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE DATE_DIM (
  DATE_KEY        DATE     NOT NULL COMMENT 'Calendar day. Join key for every day-grain fact.',
  MONTH_START     DATE     NOT NULL COMMENT 'First day of the calendar month.',
  MONTH_END       DATE     NOT NULL COMMENT 'Last day of the calendar month.',
  PERIOD          STRING   NOT NULL COMMENT 'Month as a YYYY-MM label. The period key the application and the forecast both use.',
  FISCAL_QUARTER  STRING   NOT NULL COMMENT 'Fiscal quarter, calendar-aligned, as YYYY-Qn.',
  YEAR_NUM        NUMBER   NOT NULL COMMENT 'Calendar year.',
  MONTH_NUM       NUMBER   NOT NULL COMMENT 'Month number 1-12.',
  DAY_OF_WEEK     NUMBER   NOT NULL COMMENT 'ISO day of week, 1 = Monday.',
  IS_WEEKDAY      BOOLEAN  NOT NULL COMMENT 'TRUE for Monday-Friday.',
  IS_MONTH_END    BOOLEAN  NOT NULL COMMENT 'TRUE on the last day of the month. Inventory snapshots land only on these dates.',
  CONSTRAINT pk_date_dim PRIMARY KEY (DATE_KEY)
) COMMENT = 'Conformed calendar, 2024-01-01..2026-12-31. Deliberately wider than the fact data so that empty periods are expressible and IS_FUTURE is meaningful.';

INSERT INTO DATE_DIM
SELECT
  d                                                              AS date_key,
  DATE_TRUNC('MONTH', d)                                         AS month_start,
  LAST_DAY(d)                                                    AS month_end,
  TO_CHAR(d, 'YYYY-MM')                                          AS period,
  TO_CHAR(YEAR(d)) || '-Q' || TO_CHAR(QUARTER(d))                AS fiscal_quarter,
  YEAR(d)                                                        AS year_num,
  MONTH(d)                                                       AS month_num,
  DAYOFWEEKISO(d)                                                AS day_of_week,
  DAYOFWEEKISO(d) <= 5                                           AS is_weekday,
  d = LAST_DAY(d)                                                AS is_month_end
FROM (
  SELECT DATEADD('DAY', SEQ4(), DATE '2024-01-01') AS d
  FROM TABLE(GENERATOR(ROWCOUNT => 1096))
)
WHERE d <= DATE '2026-12-31';

-- ---------------------------------------------------------------------------
-- PART — 2,000 materials.
--
-- STANDARD_COST is the basis for purchase price variance, so it must be stable
-- per material across the whole history: PPV is only interpretable if the
-- standard it is measured against does not move. ABC_CLASS is skewed A/B/C
-- 15/30/55 rather than evenly, because an even split would make the class
-- useless as a segmentation on the inventory pages.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE PART (
  MATERIAL_ID      STRING NOT NULL COMMENT 'Material number. Conformed key across purchasing, fulfilment, inventory and manufacturing.',
  MATERIAL_DESC    STRING NOT NULL COMMENT 'Human-readable description.',
  PRODUCT_FAMILY   STRING NOT NULL COMMENT 'Product family. The most-used analytical grouping in the application.',
  BUSINESS_SEGMENT STRING NOT NULL COMMENT 'Reporting segment the family rolls into.',
  ABC_CLASS        STRING NOT NULL COMMENT 'Inventory value classification: A is high-value low-volume, C the reverse.',
  STANDARD_COST    NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost. Fixed for the life of the material so that purchase price variance is measured against an unchanging basis.',
  UOM              STRING NOT NULL COMMENT 'Unit of measure.',
  CONSTRAINT pk_part PRIMARY KEY (MATERIAL_ID)
) COMMENT = 'Material master. 2,000 materials across 8 product families.';

INSERT INTO PART
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 2000)))
SELECT
  'MAT-' || LPAD(TO_CHAR(i + 1), 6, '0')                          AS material_id,
  fam.name || ' Component ' || TO_CHAR(i + 1)                     AS material_desc,
  fam.name                                                        AS product_family,
  fam.segment                                                     AS business_segment,
  CASE WHEN ABS(HASH(i, 'abc')) % 100 < 15 THEN 'A'
       WHEN ABS(HASH(i, 'abc')) % 100 < 45 THEN 'B'
       ELSE 'C' END                                               AS abc_class,
  -- 1.50 .. 14.49, quantised to cents, averaging ~8.00.
  --
  -- The ceiling is set by the landed-cost metric, not by realism for its own
  -- sake. TOTAL_LANDED_COST is MATERIAL_COST + FREIGHT + DUTY + HANDLING, and
  -- MATERIAL_COST is standard cost times quantity, so mean standard cost is the
  -- dominant term in landed cost per unit. That metric has a governed target of
  -- $10 (03_targets.sql) and 05_exception_rules.sql flags shipments above $15 as
  -- "well above" it. A mean standard cost of, say, $90 would put every shipment
  -- an order of magnitude past the target, turning the whole red/amber/green
  -- layer and the exception drill-down into noise. ~$8 of material plus ~$2.40
  -- of freight, duty and handling lands the metric just over target, which is
  -- where the thresholds are actually exercised.
  ROUND(1.50 + (ABS(HASH(i, 'cost')) % 1300) / 100.0, 2)          AS standard_cost,
  CASE ABS(HASH(i, 'uom')) % 3 WHEN 0 THEN 'EA' WHEN 1 THEN 'CS' ELSE 'RL' END AS uom
FROM s
JOIN (
  SELECT * FROM VALUES
    (0, 'Abrasives',   'Safety & Industrial'),
    (1, 'Adhesives',   'Safety & Industrial'),
    (2, 'Tapes',       'Safety & Industrial'),
    (3, 'Films',       'Transportation & Electronics'),
    (4, 'Electronics', 'Transportation & Electronics'),
    (5, 'Filtration',  'Consumer'),
    (6, 'Medical',     'Health Care'),
    (7, 'Safety',      'Safety & Industrial')
  AS v(idx, name, segment)
) fam ON fam.idx = ABS(HASH(s.i, 'fam')) % 8;

-- ---------------------------------------------------------------------------
-- SUPPLIER — 300 suppliers.
--
-- SUPPLIER_REGION is the row-scope dimension on the inbound side and is weighted
-- rather than uniform (NA 40 / EU 30 / APAC 22 / LATAM 8), so that a regional
-- filter produces populations of visibly different size. Uniform regions make a
-- row-scoped persona indistinguishable from an unscoped one at a glance.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE SUPPLIER (
  SUPPLIER_ID     STRING NOT NULL COMMENT 'Vendor number.',
  SUPPLIER_NAME   STRING NOT NULL COMMENT 'Vendor name, shown in drill-down rows.',
  SUPPLIER_REGION STRING NOT NULL COMMENT 'Sourcing region: NA, EU, APAC or LATAM.',
  SUPPLIER_GROUP  STRING NOT NULL COMMENT 'Commodity group the vendor is managed under.',
  SUPPLIER_TIER   STRING NOT NULL COMMENT 'Strategic tier. TIER_1 vendors carry the majority of spend.',
  COUNTRY         STRING NOT NULL COMMENT 'Country of the shipping origin.',
  CONSTRAINT pk_supplier PRIMARY KEY (SUPPLIER_ID)
) COMMENT = 'Supplier master. 300 vendors, regionally weighted so that row-scoped personas see populations of different size.';

INSERT INTO SUPPLIER
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 300)))
SELECT
  'SUP-' || LPAD(TO_CHAR(i + 1), 5, '0')                          AS supplier_id,
  'Supplier ' || LPAD(TO_CHAR(i + 1), 4, '0') || ' ' ||
    CASE ABS(HASH(i, 'sfx')) % 5
      WHEN 0 THEN 'Industries' WHEN 1 THEN 'Materials' WHEN 2 THEN 'Group'
      WHEN 3 THEN 'Manufacturing' ELSE 'Technologies' END         AS supplier_name,
  r.region                                                        AS supplier_region,
  CASE ABS(HASH(i, 'grp')) % 6
    WHEN 0 THEN 'Resins' WHEN 1 THEN 'Minerals' WHEN 2 THEN 'Packaging'
    WHEN 3 THEN 'Electronics' WHEN 4 THEN 'Chemicals' ELSE 'Textiles' END AS supplier_group,
  CASE WHEN ABS(HASH(i, 'tier')) % 100 < 20 THEN 'TIER_1'
       WHEN ABS(HASH(i, 'tier')) % 100 < 55 THEN 'TIER_2'
       ELSE 'TIER_3' END                                          AS supplier_tier,
  r.country                                                       AS country
FROM s
JOIN (
  -- lo/hi are cumulative percentage bounds, so the weighting is explicit.
  SELECT * FROM VALUES
    ('NA',     0,  40, 'United States'),
    ('EU',    40,  70, 'Germany'),
    ('APAC',  70,  92, 'Japan'),
    ('LATAM', 92, 100, 'Brazil')
  AS v(region, lo, hi, country)
) r ON ABS(HASH(s.i, 'sreg')) % 100 >= r.lo AND ABS(HASH(s.i, 'sreg')) % 100 < r.hi;

-- ---------------------------------------------------------------------------
-- CUSTOMER — 1,200 ship-to customers.
--
-- CUSTOMER_REGION carries the same weighting as SUPPLIER_REGION. It is distinct
-- from the shipment's SHIP_REGION in 00c: the EU row access policy scopes on
-- SHIP_REGION, because where goods went is what a regional logistics owner is
-- accountable for, not where the account is registered.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE CUSTOMER (
  CUSTOMER_ID      STRING NOT NULL COMMENT 'Ship-to customer number.',
  CUSTOMER_NAME    STRING NOT NULL COMMENT 'Customer name.',
  CUSTOMER_REGION  STRING NOT NULL COMMENT 'Region the account is managed in.',
  CUSTOMER_SEGMENT STRING NOT NULL COMMENT 'Go-to-market segment.',
  CHANNEL          STRING NOT NULL COMMENT 'Route to market.',
  CONSTRAINT pk_customer PRIMARY KEY (CUSTOMER_ID)
) COMMENT = 'Customer master. 1,200 ship-to accounts.';

INSERT INTO CUSTOMER
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 1200)))
SELECT
  'CUST-' || LPAD(TO_CHAR(i + 1), 6, '0')                         AS customer_id,
  'Customer ' || LPAD(TO_CHAR(i + 1), 5, '0')                     AS customer_name,
  r.region                                                        AS customer_region,
  CASE ABS(HASH(i, 'seg')) % 4
    WHEN 0 THEN 'Enterprise' WHEN 1 THEN 'Mid-Market'
    WHEN 2 THEN 'Distributor' ELSE 'Retail' END                   AS customer_segment,
  CASE ABS(HASH(i, 'chan')) % 3
    WHEN 0 THEN 'Direct' WHEN 1 THEN 'Distribution' ELSE 'eCommerce' END AS channel
FROM s
JOIN (
  SELECT * FROM VALUES
    ('NA',     0,  40),
    ('EU',    40,  70),
    ('APAC',  70,  92),
    ('LATAM', 92, 100)
  AS v(region, lo, hi)
) r ON ABS(HASH(s.i, 'creg')) % 100 >= r.lo AND ABS(HASH(s.i, 'creg')) % 100 < r.hi;

-- ---------------------------------------------------------------------------
-- NODE — 24 distribution and plant locations.
--
-- Enumerated rather than generated. Node count is small and node region drives
-- the inventory row scope, so an explicit list is easier to verify by eye than a
-- hash-derived one, and 24 nodes against 2,000 materials is what produces the
-- ~137K inventory snapshot rows over 24 month-ends.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE NODE (
  NODE_ID     STRING NOT NULL COMMENT 'Plant or distribution centre code.',
  NODE_NAME   STRING NOT NULL COMMENT 'Location name, shown in inventory drill-down rows.',
  NODE_REGION STRING NOT NULL COMMENT 'Region the node serves.',
  NODE_TYPE   STRING NOT NULL COMMENT 'PLANT for manufacturing, DC for distribution.',
  CONSTRAINT pk_node PRIMARY KEY (NODE_ID)
) COMMENT = 'Network master. 24 nodes across 4 regions.';

INSERT INTO NODE
SELECT * FROM VALUES
  ('ND-01','Saint Paul DC','NA','DC'),      ('ND-02','Columbia Plant','NA','PLANT'),
  ('ND-03','Austin DC','NA','DC'),          ('ND-04','Brookings Plant','NA','PLANT'),
  ('ND-05','Chicago DC','NA','DC'),         ('ND-06','Ontario DC','NA','DC'),
  ('ND-07','Neuss DC','EU','DC'),           ('ND-08','Kamen Plant','EU','PLANT'),
  ('ND-09','Gorseinon Plant','EU','PLANT'), ('ND-10','Breda DC','EU','DC'),
  ('ND-11','Milan DC','EU','DC'),           ('ND-12','Lyon DC','EU','DC'),
  ('ND-13','Singapore DC','APAC','DC'),     ('ND-14','Suzhou Plant','APAC','PLANT'),
  ('ND-15','Yamagata Plant','APAC','PLANT'),('ND-16','Sydney DC','APAC','DC'),
  ('ND-17','Pune Plant','APAC','PLANT'),    ('ND-18','Seoul DC','APAC','DC'),
  ('ND-19','Sumare Plant','LATAM','PLANT'), ('ND-20','Itapetininga DC','LATAM','DC'),
  ('ND-21','Queretaro Plant','LATAM','PLANT'),('ND-22','Bogota DC','LATAM','DC'),
  ('ND-23','Santiago DC','LATAM','DC'),     ('ND-24','Buenos Aires DC','LATAM','DC')
AS v(node_id, node_name, node_region, node_type);

-- ---------------------------------------------------------------------------
-- CARRIER — 8 carriers.
--
-- ON_TIME_BIAS is the per-carrier deviation from the network's baseline on-time
-- probability, in percentage points. It exists so that carrier is a real
-- explanatory dimension: without it, "which carrier is hurting OTD" has no
-- answer in the data and the drill-down is decorative.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE CARRIER (
  CARRIER_ID    STRING NOT NULL COMMENT 'Carrier code.',
  CARRIER_NAME  STRING NOT NULL COMMENT 'Carrier name.',
  MODE          STRING NOT NULL COMMENT 'Transport mode.',
  ON_TIME_BIAS  NUMBER(4,1) NOT NULL COMMENT 'Deviation from baseline on-time probability, in percentage points. Makes carrier a genuine driver of OTD rather than noise.',
  COST_INDEX    NUMBER(5,3) NOT NULL COMMENT 'Multiplier on baseline freight cost per shipment.',
  CONSTRAINT pk_carrier PRIMARY KEY (CARRIER_ID)
) COMMENT = 'Carrier master. ON_TIME_BIAS and COST_INDEX make carrier an explanatory dimension for both service and cost.';

INSERT INTO CARRIER
SELECT * FROM VALUES
  ('CAR-01','Northwind Freight','ROAD',    4.0, 0.940),
  ('CAR-02','Meridian Logistics','ROAD',   1.5, 1.000),
  ('CAR-03','BlueLane Express','PARCEL',   5.5, 1.180),
  ('CAR-04','TransGlobal Ocean','OCEAN',  -7.0, 0.620),
  ('CAR-05','AeroCargo','AIR',             6.5, 1.850),
  ('CAR-06','Continental Haulage','ROAD', -3.5, 0.880),
  ('CAR-07','Pacific Star Lines','OCEAN', -5.0, 0.650),
  ('CAR-08','RegioTrans','ROAD',           0.5, 0.960)
AS v(carrier_id, carrier_name, mode, on_time_bias, cost_index);

-- ---------------------------------------------------------------------------
-- LANE — 96 origin/destination service combinations.
--
-- TRANSIT_TARGET_DAYS is what the promise date is derived from in 00c, so that a
-- late delivery is late relative to a stated commitment rather than to an
-- arbitrary constant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TABLE LANE (
  LANE_ID             STRING NOT NULL COMMENT 'Lane code.',
  ORIGIN_NODE         STRING NOT NULL COMMENT 'Shipping node.',
  DEST_REGION         STRING NOT NULL COMMENT 'Destination region. The shipment SHIP_REGION comes from here.',
  SERVICE_LEVEL       STRING NOT NULL COMMENT 'Committed service level.',
  TRANSIT_TARGET_DAYS NUMBER NOT NULL COMMENT 'Committed transit time. The promise date in 00c is derived from this, so lateness is measured against a real commitment.',
  CONSTRAINT pk_lane PRIMARY KEY (LANE_ID)
) COMMENT = 'Transport lanes. 96 origin/destination/service combinations.';

INSERT INTO LANE
WITH s AS (SELECT SEQ4() AS i FROM TABLE(GENERATOR(ROWCOUNT => 96)))
SELECT
  'LANE-' || LPAD(TO_CHAR(s.i + 1), 4, '0')                       AS lane_id,
  n.node_id                                                       AS origin_node,
  d.region                                                        AS dest_region,
  sl.service_level                                                AS service_level,
  -- Cross-region moves take materially longer; same-region is short-haul.
  CASE WHEN n.node_region = d.region THEN sl.base_days
       ELSE sl.base_days + 8 END                                  AS transit_target_days
FROM s
JOIN NODE n ON n.node_id = 'ND-' || LPAD(TO_CHAR((ABS(HASH(s.i, 'lnode')) % 24) + 1), 2, '0')
JOIN (
  SELECT * FROM VALUES ('NA',0),('EU',1),('APAC',2),('LATAM',3) AS v(region, idx)
) d ON d.idx = ABS(HASH(s.i, 'ldest')) % 4
JOIN (
  SELECT * FROM VALUES
    ('EXPRESS', 2, 0), ('STANDARD', 5, 1), ('ECONOMY', 9, 2)
  AS v(service_level, base_days, idx)
) sl ON sl.idx = ABS(HASH(s.i, 'lsvc')) % 3;
