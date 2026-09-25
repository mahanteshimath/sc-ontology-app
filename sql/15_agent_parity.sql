-- ---------------------------------------------------------------------------
-- 15 — Agent/application parity.
--
-- /api/ask deliberately does not route through SNOWFLAKE_INTELLIGENCE.AGENTS.
-- SC_ONTOLOGIST_AGENT, and the reasons are structural rather than stylistic:
-- an agent resolves permissions from the user's DEFAULT role rather than the
-- session role, so the per-request USE ROLE + USE SECONDARY ROLES NONE guarantee
-- would not hold and SC_LOGISTICS_EU would silently receive all-region numbers.
--
-- That is a good reason and it is also an easy thing to disbelieve. Read quickly,
-- "we built a Cortex Agent and then routed around it" looks like a gap rather
-- than a decision, and the only honest way to settle it is to run both and
-- compare.
--
-- WHAT PARITY MEANS HERE. The two paths are NOT the same mechanism and are not
-- supposed to be:
--
--   agent        chooses a domain semantic view, writes its own SQL (or reuses a
--                verified query), executes under the agent's resolved role
--   application  chooses registered metric ids, assembles SQL from the registry,
--                executes SC_ONTOLOGY_360 under the persona's role
--
-- Different engine, different view, different SQL. If the ontology is doing its
-- job the NUMBER is identical anyway, because both are evaluating the same
-- governed definition. That is the claim this table tests.
--
-- WHY RECORDED RATHER THAN RUN ON PAGE LOAD. A full agent turn routinely takes
-- longer than the serverless budget, so putting it on the request path would
-- make the page that proves the system is trustworthy the page most likely to
-- time out. Drift is handled the same way: run on a schedule, record, display
-- the recorded run with its timestamp.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE TABLE IF NOT EXISTS AGENT_PARITY_RESULT (
  run_id                 STRING NOT NULL,
  run_at                 TIMESTAMP_LTZ NOT NULL,
  question               STRING NOT NULL,
  metric_id              STRING,
  agent_value            FLOAT   COMMENT 'What the Cortex Agent returned.',
  agent_semantic_view    STRING  COMMENT 'Domain view the agent routed to.',
  agent_sql              STRING  COMMENT 'SQL the agent actually executed.',
  agent_verified_query   BOOLEAN COMMENT 'TRUE when the agent reused a stored verified query rather than deriving SQL.',
  agent_latency_ms       NUMBER,
  app_value              FLOAT   COMMENT 'What the governed application path returned.',
  app_semantic_view      STRING,
  app_persona            STRING  COMMENT 'Role the application query executed as.',
  app_latency_ms         NUMBER,
  canonical_value        FLOAT   COMMENT 'METRIC_DEFINITION.CANONICAL_SQL evaluated independently. The tie-breaker: it says which engine is faithful to the definition when the two disagree.',
  spread                 FLOAT   COMMENT 'ABS(agent - app).',
  status                 STRING  NOT NULL COMMENT 'MATCH, AS_OF_GAP (agent equals canonical; the residual is the governed as-of rule), DIVERGE, or ERROR.',
  detail                 STRING,
  CONSTRAINT pk_agent_parity PRIMARY KEY (run_id, question)
)
COMMENT = 'Two engines, one definition. Records the Cortex Agent and the governed application path answering the same question, so the decision to keep them separate is demonstrable rather than merely explained.';

CREATE OR REPLACE VIEW V_AGENT_PARITY_LATEST
  COMMENT = 'Most recent parity run, one row per question.'
AS
SELECT *
  FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_PARITY_RESULT
 WHERE run_id = (
   SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_PARITY_RESULT ORDER BY run_at DESC LIMIT 1
 );
