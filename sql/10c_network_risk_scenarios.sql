-- ---------------------------------------------------------------------------
-- 10c — Simulated network-risk scenarios and lane impacts.
--
-- Scenario rows are planning assumptions, never observed events. They do not
-- update RAW.SALES_ORDER_LINE, SHIPMENT_COST, CANONICAL facts, or any realized
-- metric. A map or future SC_NETWORK_RISK semantic view must label their output
-- SIMULATED and quote the scenario's assumptions.
--
-- The synthetic network records destination REGION rather than a real route
-- corridor. The Hormuz scenario therefore affects APAC -> EU lanes by explicit
-- modelling assumption; it does not assert that any historical shipment crossed
-- the Strait of Hormuz or that a live disruption exists.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE TABLE NETWORK_RISK_SCENARIO (
  scenario_id        STRING NOT NULL,
  scenario_name      STRING NOT NULL,
  scenario_type      STRING NOT NULL,
  status             STRING NOT NULL,
  chokepoint_id      STRING,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  confidence         STRING NOT NULL,
  source_type        STRING NOT NULL,
  assumption_summary STRING NOT NULL,
  created_at         TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_network_risk_scenario PRIMARY KEY (scenario_id)
) COMMENT = 'Scenario header for simulated network-risk planning. It is separate from realized facts and must never be represented as a live incident feed.';

INSERT INTO NETWORK_RISK_SCENARIO
  (scenario_id, scenario_name, scenario_type, status, chokepoint_id,
   effective_from, effective_to, confidence, source_type, assumption_summary)
VALUES
  (
    'SCN-HORMUZ-001',
    'Hormuz capacity constraint - planning scenario',
    'MARITIME_CHOKEPOINT',
    'SIMULATED',
    'CHOKE-01',
    DATE '2026-10-01',
    DATE '2026-10-31',
    'PLANNING_ASSUMPTION',
    'SYNTHETIC',
    'Models a hypothetical capacity constraint for APAC-to-EU ocean-exposed planning lanes. It is not live geopolitical or vessel-tracking data.'
  );

CREATE OR REPLACE TABLE SCENARIO_LANE_IMPACT (
  scenario_id             STRING NOT NULL,
  lane_id                 STRING NOT NULL,
  impact_status           STRING NOT NULL,
  applicability_reason    STRING NOT NULL,
  capacity_reduction_pct  NUMBER(5,4) NOT NULL,
  transit_delay_days      NUMBER(6,2) NOT NULL,
  freight_uplift_pct      NUMBER(5,4) NOT NULL,
  disruption_probability  NUMBER(5,4) NOT NULL,
  mitigation_strategy     STRING NOT NULL,
  mitigation_delay_days   NUMBER(6,2) NOT NULL,
  mitigation_cost_uplift_pct NUMBER(5,4) NOT NULL,
  notes                   STRING NOT NULL,
  CONSTRAINT pk_scenario_lane_impact PRIMARY KEY (scenario_id, lane_id)
) COMMENT = 'Simulated scenario impact at lane grain. Each row carries transparent capacity, transit, freight, probability and mitigation assumptions; none is a realized shipment measurement.';

-- Apply the planning scenario only to APAC -> EU lanes. The source lane model
-- has no maritime corridor field, so this is deliberately an auditable proxy.
INSERT INTO SCENARIO_LANE_IMPACT
  (scenario_id, lane_id, impact_status, applicability_reason,
   capacity_reduction_pct, transit_delay_days, freight_uplift_pct,
   disruption_probability, mitigation_strategy, mitigation_delay_days,
   mitigation_cost_uplift_pct, notes)
SELECT
  'SCN-HORMUZ-001',
  l.lane_id,
  'SIMULATED',
  'Synthetic APAC-to-EU proxy for Hormuz-exposed planning traffic',
  0.40,
  IFF(l.service_level = 'EXPRESS', 4.0, IFF(l.service_level = 'STANDARD', 7.0, 10.0)),
  0.25,
  0.70,
  'REROUTE_OR_EXPEDITE',
  IFF(l.service_level = 'EXPRESS', 2.0, 4.0),
  0.45,
  'Assumption only: compare baseline service with a reroute or expedited mitigation. Validate carrier capacity before execution.'
FROM SUPPLY_CHAIN.RAW.LANE l
JOIN SUPPLY_CHAIN.RAW.NODE n ON n.node_id = l.origin_node
WHERE n.node_region = 'APAC'
  AND l.dest_region = 'EU';

CREATE OR REPLACE VIEW V_NETWORK_RISK_SCENARIO AS
SELECT
  s.scenario_id,
  s.scenario_name,
  s.scenario_type,
  s.status AS scenario_status,
  s.effective_from,
  s.effective_to,
  s.confidence,
  s.source_type,
  s.assumption_summary,
  c.chokepoint_name,
  i.lane_id,
  l.origin_node,
  n.node_name AS origin_name,
  n.node_region AS origin_region,
  l.dest_region AS destination_region,
  l.service_level,
  l.transit_target_days AS baseline_transit_days,
  i.impact_status,
  i.applicability_reason,
  i.capacity_reduction_pct,
  i.transit_delay_days,
  i.freight_uplift_pct,
  i.disruption_probability,
  i.mitigation_strategy,
  i.mitigation_delay_days,
  i.mitigation_cost_uplift_pct,
  l.transit_target_days + i.transit_delay_days AS simulated_transit_days,
  l.transit_target_days + i.mitigation_delay_days AS mitigated_transit_days,
  i.notes
FROM NETWORK_RISK_SCENARIO s
JOIN SCENARIO_LANE_IMPACT i ON i.scenario_id = s.scenario_id
JOIN SUPPLY_CHAIN.RAW.LANE l ON l.lane_id = i.lane_id
JOIN SUPPLY_CHAIN.RAW.NODE n ON n.node_id = l.origin_node
LEFT JOIN SUPPLY_CHAIN.RAW.GEO_CHOKEPOINT c ON c.chokepoint_id = s.chokepoint_id;

-- Evidence. The affected lane count comes from the generated lane population,
-- so assert non-zero coverage rather than a brittle hand-maintained count.
SELECT
  'simulated scenario header' AS check_name,
  COUNT(*) AS found,
  1 AS expected_minimum,
  IFF(COUNT(*) >= 1, 'PASS', 'FAIL') AS verdict
FROM NETWORK_RISK_SCENARIO
WHERE scenario_id = 'SCN-HORMUZ-001'
UNION ALL
SELECT
  'simulated APAC-to-EU lane impacts',
  COUNT(*),
  1,
  IFF(COUNT(*) >= 1, 'PASS', 'FAIL')
FROM SCENARIO_LANE_IMPACT
WHERE scenario_id = 'SCN-HORMUZ-001'
UNION ALL
SELECT
  'non-realized scenario status',
  COUNT(*),
  1,
  IFF(COUNT(*) = 1, 'PASS', 'FAIL')
FROM NETWORK_RISK_SCENARIO
WHERE scenario_id = 'SCN-HORMUZ-001' AND status = 'SIMULATED';
