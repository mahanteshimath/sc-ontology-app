-- ---------------------------------------------------------------------------
-- 10b — Geospatial reference ingestion.
--
-- Geocodes the existing network nodes and materialises the current 96 lanes as
-- map-ready geometries. This is reference data only: future scenarios attach
-- impacts to lanes or chokepoints without changing realized facts or metrics.
-- Coordinates are representative city centres for synthetic node names, not
-- facility addresses, vehicle tracking, or navigation directions.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA RAW;

CREATE OR REPLACE TABLE GEO_NODE (
  node_id       STRING NOT NULL,
  latitude      NUMBER(9,6) NOT NULL,
  longitude     NUMBER(9,6) NOT NULL,
  point         GEOGRAPHY NOT NULL,
  precision     STRING NOT NULL,
  source        STRING NOT NULL,
  CONSTRAINT pk_geo_node PRIMARY KEY (node_id)
) COMMENT = 'Map reference for the 24 synthetic network nodes. Coordinates are representative city centres, not facility addresses.';

INSERT INTO GEO_NODE (node_id, latitude, longitude, point, precision, source)
SELECT node_id, latitude, longitude,
       TO_GEOGRAPHY('POINT(' || longitude || ' ' || latitude || ')'),
       'CITY_CENTRE',
       'Synthetic reference data curated for network visualisation'
FROM VALUES
  ('ND-01',44.953703,-93.089958), ('ND-02',34.000710,-81.034814),
  ('ND-03',30.267153,-97.743061), ('ND-04',44.159134,-94.013857),
  ('ND-05',41.878114,-87.629798), ('ND-06',43.255721,-79.871102),
  ('ND-07',51.204196,6.687952),   ('ND-08',51.367077,7.463284),
  ('ND-09',51.669313,-4.041363),  ('ND-10',51.571915,4.768323),
  ('ND-11',45.464204,9.189982),   ('ND-12',45.764043,4.835659),
  ('ND-13',1.352083,103.819836),  ('ND-14',31.298886,120.585316),
  ('ND-15',38.255440,140.339602), ('ND-16',-33.868820,151.209296),
  ('ND-17',18.520430,73.856744),  ('ND-18',37.566535,126.977969),
  ('ND-19',-23.501533,-47.452594),('ND-20',-23.588642,-48.048263),
  ('ND-21',20.588793,-100.389888),('ND-22',4.711000,-74.072092),
  ('ND-23',-33.448890,-70.669265),('ND-24',-34.603722,-58.381592)
AS v(node_id, latitude, longitude);

CREATE OR REPLACE TABLE GEO_REGION_HUB (
  region        STRING NOT NULL,
  hub_name      STRING NOT NULL,
  latitude      NUMBER(9,6) NOT NULL,
  longitude     NUMBER(9,6) NOT NULL,
  point         GEOGRAPHY NOT NULL,
  source        STRING NOT NULL,
  CONSTRAINT pk_geo_region_hub PRIMARY KEY (region)
) COMMENT = 'Representative destination hubs used to draw lanes whose source model records destination region rather than destination node.';

INSERT INTO GEO_REGION_HUB (region, hub_name, latitude, longitude, point, source)
SELECT region, hub_name, latitude, longitude,
       TO_GEOGRAPHY('POINT(' || longitude || ' ' || latitude || ')'),
       'Synthetic reference data curated for network visualisation'
FROM VALUES
  ('NA','Chicago regional hub',41.878114,-87.629798),
  ('EU','Rotterdam regional hub',51.924420,4.477733),
  ('APAC','Singapore regional hub',1.352083,103.819836),
  ('LATAM','Sao Paulo regional hub',-23.550520,-46.633308)
AS v(region, hub_name, latitude, longitude);

CREATE OR REPLACE TABLE GEO_CHOKEPOINT (
  chokepoint_id   STRING NOT NULL,
  chokepoint_name STRING NOT NULL,
  latitude        NUMBER(9,6) NOT NULL,
  longitude       NUMBER(9,6) NOT NULL,
  point           GEOGRAPHY NOT NULL,
  transport_mode  STRING NOT NULL,
  description     STRING NOT NULL,
  source          STRING NOT NULL,
  CONSTRAINT pk_geo_chokepoint PRIMARY KEY (chokepoint_id)
) COMMENT = 'Strategic logistics chokepoints for future scenario modelling. Presence is geographic reference only and does not assert a live disruption.';

INSERT INTO GEO_CHOKEPOINT
  (chokepoint_id, chokepoint_name, latitude, longitude, point, transport_mode, description, source)
SELECT chokepoint_id, chokepoint_name, latitude, longitude,
       TO_GEOGRAPHY('POINT(' || longitude || ' ' || latitude || ')'),
       transport_mode, description,
       'Public geographic reference; scenario status is maintained separately'
FROM VALUES
  ('CHOKE-01','Strait of Hormuz',26.566700,56.250000,'OCEAN','Narrow Gulf maritime passage.'),
  ('CHOKE-02','Suez Canal',30.585200,32.265400,'OCEAN','Mediterranean to Red Sea maritime passage.'),
  ('CHOKE-03','Bab el-Mandeb',12.583300,43.333300,'OCEAN','Red Sea to Gulf of Aden maritime passage.'),
  ('CHOKE-04','Panama Canal',9.080000,-79.680000,'OCEAN','Atlantic to Pacific canal passage.'),
  ('CHOKE-05','Strait of Malacca',2.500000,101.000000,'OCEAN','Indian Ocean to South China Sea passage.')
AS v(chokepoint_id, chokepoint_name, latitude, longitude, transport_mode, description);

CREATE OR REPLACE TABLE GEO_LANE (
  lane_id             STRING NOT NULL,
  origin_node         STRING NOT NULL,
  destination_region  STRING NOT NULL,
  service_level       STRING NOT NULL,
  transit_target_days NUMBER NOT NULL,
  origin_point        GEOGRAPHY NOT NULL,
  destination_point   GEOGRAPHY NOT NULL,
  route_geometry      GEOGRAPHY NOT NULL,
  geometry_method     STRING NOT NULL,
  CONSTRAINT pk_geo_lane PRIMARY KEY (lane_id)
) COMMENT = 'Map-ready lane reference. Geometry is a representative straight connection to the destination region hub because RAW.LANE does not hold a destination node or carrier-specific path.';

INSERT INTO GEO_LANE
  (lane_id, origin_node, destination_region, service_level, transit_target_days,
   origin_point, destination_point, route_geometry, geometry_method)
SELECT
  l.lane_id, l.origin_node, l.dest_region, l.service_level, l.transit_target_days,
  n.point, h.point,
  TO_GEOGRAPHY('LINESTRING(' || n.longitude || ' ' || n.latitude || ', ' || h.longitude || ' ' || h.latitude || ')'),
  'STRAIGHT_LINE_TO_REGION_HUB'
FROM LANE l
JOIN GEO_NODE n ON n.node_id = l.origin_node
JOIN GEO_REGION_HUB h ON h.region = l.dest_region;

SELECT 'GEO_NODE coverage' AS check_name, COUNT(*) AS found, 24 AS expected,
       IFF(COUNT(*) = 24, 'PASS', 'FAIL') AS verdict FROM GEO_NODE
UNION ALL
SELECT 'GEO_LANE coverage', COUNT(*), 96, IFF(COUNT(*) = 96, 'PASS', 'FAIL') FROM GEO_LANE
UNION ALL
SELECT 'GEO_CHOKEPOINT coverage', COUNT(*), 5, IFF(COUNT(*) = 5, 'PASS', 'FAIL') FROM GEO_CHOKEPOINT;
