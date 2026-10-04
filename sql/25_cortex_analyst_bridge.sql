-- ---------------------------------------------------------------------------
-- 25 — Cortex Analyst bridge: generate with owner's rights, execute with caller's.
--
-- Cortex Analyst validates a semantic view against its base tables before it will
-- generate SQL. The persona roles are deliberately denied RAW (00a), so a
-- persona cannot call Analyst on SC_ONTOLOGY_360 directly — Analyst returns
-- 392705 "tables ... do not exist or are not authorized".
--
-- Rather than widening the personas, generation and execution are split:
--
--   1. ASK_CORTEX_ANALYST runs EXECUTE AS OWNER under SC_ANALYST_SQLGEN, a role
--      no user holds, which can read the views' base tables. It returns Analyst's
--      SQL TEXT and metadata — never a data row.
--   2. The app (app/api/ask/analyst) checks the SQL is one read-only
--      SEMANTIC_VIEW(...) query (lib/sql-guard.ts governedStatement) and runs it
--      on a connection that has assumed the persona role with secondary roles
--      off. Grants and RAP_SHIP_REGION therefore decide what the persona sees,
--      exactly as for the registry engine.
--
-- The procedure allow-lists the semantic views it will describe, so it cannot be
-- used to probe arbitrary objects.
-- Idempotent.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS SC_ANALYST_SQLGEN
  COMMENT = 'Owns ASK_CORTEX_ANALYST only. Can read the semantic views and their base tables so Cortex Analyst can validate them; never granted to a user. The procedure it owns returns SQL text, never rows.';
GRANT ROLE SC_ANALYST_SQLGEN TO ROLE SYSADMIN;
GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE SC_ANALYST_SQLGEN;
GRANT USAGE ON DATABASE SUPPLY_CHAIN TO ROLE SC_ANALYST_SQLGEN;
GRANT USAGE ON SCHEMA SUPPLY_CHAIN.RAW TO ROLE SC_ANALYST_SQLGEN;
GRANT USAGE ON SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_ANALYST_SQLGEN;
GRANT USAGE ON SCHEMA SUPPLY_CHAIN.SEMANTIC TO ROLE SC_ANALYST_SQLGEN;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.RAW TO ROLE SC_ANALYST_SQLGEN;
GRANT SELECT ON ALL TABLES IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_ANALYST_SQLGEN;
GRANT SELECT ON ALL VIEWS IN SCHEMA SUPPLY_CHAIN.CANONICAL TO ROLE SC_ANALYST_SQLGEN;
GRANT SELECT, REFERENCES ON ALL SEMANTIC VIEWS IN SCHEMA SUPPLY_CHAIN.SEMANTIC TO ROLE SC_ANALYST_SQLGEN;
GRANT CREATE PROCEDURE ON SCHEMA SUPPLY_CHAIN.SEMANTIC TO ROLE SC_ANALYST_SQLGEN;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE SC_ANALYST_SQLGEN;

USE ROLE SC_ANALYST_SQLGEN;
USE SECONDARY ROLES NONE;

CREATE OR REPLACE PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(QUESTION STRING, SEMANTIC_VIEW STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
COMMENT = 'Cortex Analyst SQL generator. Owner''s rights (SC_ANALYST_SQLGEN) so Analyst can validate the semantic view against its base tables. Returns SQL text and metadata only, never data rows; the caller executes the SQL under its own persona role.'
EXECUTE AS OWNER
AS
$$
import json
import _snowflake

ALLOWED = {
    "SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360",
    "SUPPLY_CHAIN.SEMANTIC.SC_VALUE_CHAIN",
}

def run(session, question, semantic_view):
    if semantic_view.upper() not in ALLOWED:
        return {"status": 400, "response": {"message": "semantic view not allowed"}}
    body = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": question[:500]}]}],
        "semantic_view": semantic_view,
    }
    resp = _snowflake.send_snow_api_request(
        "POST", "/api/v2/cortex/analyst/message", {}, {}, body, None, 50000
    )
    content = resp.get("content")
    try:
        parsed = json.loads(content) if isinstance(content, str) else content
    except Exception:
        parsed = {"raw": str(content)[:2000]}
    return {"status": resp.get("status"), "response": parsed}
$$;

USE ROLE ACCOUNTADMIN;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(STRING, STRING) TO ROLE SC_PLANNER;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(STRING, STRING) TO ROLE SC_PROCUREMENT;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(STRING, STRING) TO ROLE SC_LOGISTICS;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(STRING, STRING) TO ROLE SC_LOGISTICS_EU;
GRANT USAGE ON PROCEDURE SUPPLY_CHAIN.SEMANTIC.ASK_CORTEX_ANALYST(STRING, STRING) TO ROLE SC_ONTOLOGY_STEWARD;
