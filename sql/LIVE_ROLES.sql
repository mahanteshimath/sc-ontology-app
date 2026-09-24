-- ============================================================================
-- LIVE_ROLES.sql — live roles, pulled 2026-09-24T07:44:27.648Z
-- ============================================================================

USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS SC_LOGISTICS
  COMMENT = 'Outbound transport and cost to serve. Sees fulfilment and landed cost, all regions.';
CREATE ROLE IF NOT EXISTS SC_LOGISTICS_ANALYST
  COMMENT = 'Accountable for the definition and target of the fulfilment and landed-cost metrics.';
CREATE ROLE IF NOT EXISTS SC_LOGISTICS_EU
  COMMENT = 'Regional variant of SC_LOGISTICS, row-scoped to EU shipments by a row access policy. Exists to demonstrate that one metric definition can serve different row scopes without being redefined.';
CREATE ROLE IF NOT EXISTS SC_ONTOLOGY_STEWARD
  COMMENT = 'Owns the semantic layer. The only persona that sees every view, the drift control and the consistency evidence.';
CREATE ROLE IF NOT EXISTS SC_PLANNER
  COMMENT = 'Demand and inventory planning. Sees forecast, inventory and fulfilment.';
CREATE ROLE IF NOT EXISTS SC_PLANNING_ANALYST
  COMMENT = 'Accountable for the definition and target of the inventory and demand metrics.';
CREATE ROLE IF NOT EXISTS SC_PROCUREMENT
  COMMENT = 'Direct materials buying. Sees supplier delivery, fill and purchase price variance.';
CREATE ROLE IF NOT EXISTS SC_PROCUREMENT_ANALYST
  COMMENT = 'Accountable for the definition and target of the supplier metrics.';

-- Role -> user grants (SHOW GRANTS OF ROLE)
GRANT ROLE SC_LOGISTICS TO USER MONTY;
GRANT ROLE SC_LOGISTICS_ANALYST TO USER MONTY;
GRANT ROLE SC_LOGISTICS_EU TO USER MONTY;
GRANT ROLE SC_ONTOLOGY_STEWARD TO USER MONTY;
GRANT ROLE SC_PLANNER TO USER MONTY;
GRANT ROLE SC_PLANNING_ANALYST TO USER MONTY;
GRANT ROLE SC_PROCUREMENT TO USER MONTY;
GRANT ROLE SC_PROCUREMENT_ANALYST TO USER MONTY;
