-- ---------------------------------------------------------------------------
-- 20 - One answer in every tool: a Snowflake-managed MCP server.
--
-- The brief asks that "any team" gets one consistent answer. Teams do not all
-- live in this app: analysts ask Claude or Copilot, engineers ask Cursor, and a
-- planner has a spreadsheet open. The Model Context Protocol lets all of those
-- call Snowflake directly, so this file exposes the governed layer - not the raw
-- tables - as an MCP server. Whatever assistant a team uses, the number it gets
-- is the registry's number.
--
-- THREE TOOLS, EACH A DIFFERENT KIND OF GUARANTEE
--   governed_metric    deterministic. Registry metric id in, the governed value
--                      out, with its definition, SCOR alignment, drift status and
--                      trust level. No model writes SQL. This is the tool that
--                      makes "0.875824 in Claude" provably the same number as
--                      "0.875824 in the app".
--   supply_chain_agent the Cortex Agent, for open questions across domains.
--   contract_search    clause text from supplier agreements, as evidence.
--
-- NO SYSTEM_EXECUTE_SQL, DELIBERATELY. Snowflake's own guidance: exposing raw SQL
-- on the server a business user talks to lets the client bypass the semantic
-- views, the verified queries and the drift contract. The whole point is that it
-- cannot.
--
-- CALLER'S RIGHTS, DELIBERATELY. MCP sessions run as the connecting user's role.
-- GOVERNED_METRIC is EXECUTE AS CALLER and queries through SC_ONTOLOGY_360, so
-- the caller's grants and the RAP_SHIP_REGION row access policy apply exactly as
-- they do in the app. An owner's-rights version would have been simpler and would
-- have handed an EU-scoped user all-region numbers through a side door - the
-- precise defect the persona model exists to prevent.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;
USE WAREHOUSE COMPUTE_WH;

CREATE OR REPLACE PROCEDURE GOVERNANCE.GOVERNED_METRIC(METRIC_ID STRING)
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Deterministic governed metric lookup for MCP clients. Pass a registry metric_id (or NULL / "list" for the catalogue). Runs as the caller, through SC_ONTOLOGY_360, so grants and row access policies apply.'
  EXECUTE AS CALLER
AS
$$
DECLARE
  ref STRING;
  meta VARIANT;
  catalogue VARIANT;
  rs RESULTSET;
  val FLOAT;
BEGIN
  IF (METRIC_ID IS NULL OR LOWER(TRIM(METRIC_ID)) IN ('', 'list', 'catalog', 'catalogue')) THEN
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT('metric_id', d.metric_id, 'business_name', d.business_name,
                                      'unit', d.unit, 'domain', d.domain, 'scor', s.scor_code))
             WITHIN GROUP (ORDER BY d.domain, d.metric_id)
      INTO :catalogue
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d
      LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_SCOR_ALIGNMENT s ON s.metric_id = d.metric_id;
    RETURN OBJECT_CONSTRUCT('governed_metrics', catalogue,
                            'usage', 'Call again with one metric_id to get its governed value.');
  END IF;

  -- The id is looked up by bind, never concatenated. Only a reference found in the
  -- registry, and shaped like entity.metric, ever reaches EXECUTE IMMEDIATE.
  SELECT MAX(b.metric_reference) INTO :ref
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING b
   WHERE b.metric_id = LOWER(TRIM(:METRIC_ID)) AND b.semantic_view = 'SC_ONTOLOGY_360';

  IF (ref IS NULL OR NOT REGEXP_LIKE(ref, '^[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*$')) THEN
    RETURN OBJECT_CONSTRUCT('error', 'Not a governed metric: ' || :METRIC_ID
                            || '. Call with "list" for the catalogue. This server never derives a metric the registry does not define.');
  END IF;

  -- Aliased to V: a cursor record cannot be read by position, and the metric's own
  -- column name varies by metric.
  rs := (EXECUTE IMMEDIATE 'SELECT $1::FLOAT AS V FROM (SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360 METRICS ' || ref || '))');
  LET cur CURSOR FOR rs;
  FOR r IN cur DO
    val := r.V;
  END FOR;

  SELECT OBJECT_CONSTRUCT(
           'metric_id', d.metric_id,
           'business_name', d.business_name,
           'definition', d.definition,
           'unit', d.unit,
           'owner', d.owner_role,
           'scope', 'All history, the same scope METRIC_DRIFT_TEST evaluates.',
           'scor', OBJECT_CONSTRUCT('code', s.scor_code, 'metric', s.scor_metric, 'alignment', s.alignment),
           'drift', OBJECT_CONSTRUCT('status', l.status, 'spread', l.value_spread, 'tested_at', l.run_at),
           'trust', t.trust_level,
           'target', d.target_value)
    INTO :meta
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d
    LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_SCOR_ALIGNMENT s ON s.metric_id = d.metric_id
    LEFT JOIN (SELECT metric_id, status, value_spread, run_at,
                      ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY run_at DESC) AS rn
                 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT) l
           ON l.metric_id = d.metric_id AND l.rn = 1
    LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.V_TRUST_SIGNALS t ON t.semantic_view = 'SC_ONTOLOGY_360'
   WHERE d.metric_id = LOWER(TRIM(:METRIC_ID));

  RETURN OBJECT_INSERT(OBJECT_INSERT(meta, 'value', ROUND(val, 6)), 'executed_as', CURRENT_ROLE());
END;
$$;

CREATE OR REPLACE MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP
  FROM SPECIFICATION $$
  tools:
    - title: "Governed supply chain metric"
      name: "governed_metric"
      type: "GENERIC"
      identifier: "SUPPLY_CHAIN.GOVERNANCE.GOVERNED_METRIC"
      description: "Returns the single governed value of a supply chain metric (supplier_otd_pct, otd_pct, fill_rate_pct, days_of_inventory, landed_cost_per_unit, and others) with its definition, SCOR alignment, drift status and trust level. Pass metric_id='list' for the catalogue. Use this whenever a number is needed: it is deterministic and identical to every other governed surface."
      config:
        type: "procedure"
        warehouse: "COMPUTE_WH"
        query_timeout: 60
        input_schema:
          type: "object"
          properties:
            metric_id:
              type: "string"
              description: "A registry metric id, or 'list' for the catalogue."
    - title: "Supply chain ontology agent"
      name: "supply_chain_agent"
      type: "CORTEX_AGENT_RUN"
      identifier: "SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT"
      description: "Governed agent for open supply chain questions across suppliers, fulfilment, inventory, landed cost, manufacturing, demand, predictions and supplier contracts. Answers only from certified semantic views and verified queries."
    - title: "Supplier contract search"
      name: "contract_search"
      type: "CORTEX_SEARCH_SERVICE_QUERY"
      identifier: "SUPPLY_CHAIN.SEMANTIC.SUPPLIER_CONTRACT_SEARCH"
      description: "Full text of supplier agreements. Use it to quote clauses - service levels, remedies, payment and delivery terms. It returns evidence, never metric values."
  $$;

-- Access mirrors the app: every persona may ask for governed metrics (row scope
-- still applies to them), procurement and the steward may also search contracts
-- (search enforces its own USAGE grant from sql/16).
GRANT USAGE ON PROCEDURE GOVERNANCE.GOVERNED_METRIC(STRING) TO ROLE SC_PLANNER;
GRANT USAGE ON PROCEDURE GOVERNANCE.GOVERNED_METRIC(STRING) TO ROLE SC_PROCUREMENT;
GRANT USAGE ON PROCEDURE GOVERNANCE.GOVERNED_METRIC(STRING) TO ROLE SC_LOGISTICS;
GRANT USAGE ON PROCEDURE GOVERNANCE.GOVERNED_METRIC(STRING) TO ROLE SC_LOGISTICS_EU;
GRANT USAGE ON PROCEDURE GOVERNANCE.GOVERNED_METRIC(STRING) TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE ON MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP TO ROLE SC_PLANNER;
GRANT USAGE ON MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP TO ROLE SC_PROCUREMENT;
GRANT USAGE ON MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP TO ROLE SC_LOGISTICS;
GRANT USAGE ON MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP TO ROLE SC_LOGISTICS_EU;
GRANT USAGE ON MCP SERVER GOVERNANCE.SC_ONTOLOGY_MCP TO ROLE SC_ONTOLOGY_STEWARD;

-- Evidence: the MCP tool returns the registry's canonical number.
CALL GOVERNANCE.GOVERNED_METRIC('supplier_otd_pct');
