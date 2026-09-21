-- ---------------------------------------------------------------------------
-- 07 — Amending verified queries on an ALREADY-DEPLOYED semantic view.
--
-- THIS FILE NO LONGER ADDS VERIFIED QUERIES. It is the documented procedure for
-- changing them on a live view without retyping its definition. The queries
-- themselves are declared where the views are created:
--
--   sql/00e_semantic.sql          36 queries across 7 views
--   sql/07b_prediction_objects.sql  2 queries on SC_OUTLOOK
--   sql/93_verify_verified_queries.sql  executes all 38
--
-- ---------------------------------------------------------------------------
-- WHY THE SPLICE MOVED OUT OF THE BUILD
--
-- This file used to splice verified queries into deployed views with GET_DDL and
-- REPLACE. That is the correct tool for amending a live view and the wrong one for
-- a build, and the cost of using it here was severe: Pattern A anchors on the
-- string 'ai_verified_queries (' and is a SILENT NO-OP against a view that has no
-- such block yet. Every view except one lacked the block, so 37 of 38 verified
-- queries were never applied. Nothing failed, nothing warned, and the loss only
-- surfaced when the account was rebuilt and the count was measured at 1.
--
-- Declaring them inside CREATE SEMANTIC VIEW removes the failure mode rather than
-- guarding against it. sql/90_verify_base.sql now also asserts the count per view,
-- so a future regression is caught by the build instead of by an audit.
--
-- There is a second reason this file must not run the splices any more: now that
-- 00e declares the blocks, Pattern A DOES find its anchor, and re-applying it
-- fails with "Duplicate verified query name 'OTD_BY_PRODUCT_FAMILY'". A no-op
-- became a hard error the moment the underlying bug was fixed.
--
-- ---------------------------------------------------------------------------
-- THE PROCEDURE, FOR WHEN YOU DO NEED IT
--
-- `ALTER SEMANTIC VIEW` can only change the comment, so amending verified queries
-- on a live view requires CREATE OR ALTER with the FULL definition — and any
-- property omitted from that statement is UNSET. Retyping 20 KB of DDL by hand is
-- the real risk, so splice GET_DDL output instead.
--
-- Three rules that are easy to get wrong:
--   1. Rewrite `create or replace` to `create or alter`. CREATE OR REPLACE drops
--      every grant on the view.
--   2. Qualify the name. GET_DDL emits it unqualified.
--   3. ASSERT THE ANCHOR OCCURS EXACTLY ONCE BEFORE RELYING ON IT. A REPLACE that
--      matches nothing succeeds and changes nothing.
--
-- Pattern A — the view already has an ai_verified_queries block. Insert after the
-- opener so there is no need to find the matching close parenthesis:
--
--   DECLARE
--     ddl STRING;
--     n   NUMBER;
--   BEGIN
--     ddl := GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT');
--     n := REGEXP_COUNT(ddl, 'ai_verified_queries \\(');
--     IF (n <> 1) THEN
--       RETURN 'ABORT: anchor occurs ' || n || ' times, expected exactly 1';
--     END IF;
--     ddl := REPLACE(ddl, 'create or replace semantic view SC_FULFILLMENT',
--                         'create or alter semantic view SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT');
--     ddl := REPLACE(ddl, 'ai_verified_queries (', 'ai_verified_queries (' || $$
--       NEW_QUERY_NAME AS (
--         QUESTION 'your question?'
--         VERIFIED_AT 1789084800 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
--         SQL 'SELECT ...'
--       ),$$);
--     EXECUTE IMMEDIATE :ddl;
--     RETURN 'ok';
--   END;
--
-- Pattern B — the view has NO block yet. Strip the trailing semicolon and append
-- the clause after COMMENT:
--
--   ddl := RTRIM(ddl);
--   ddl := LEFT(ddl, LENGTH(ddl) - 1);   -- drop the trailing ';'
--   EXECUTE IMMEDIATE (ddl || ' ai_verified_queries ( ... );');
--
-- Every stored query must avoid single quotes in its SQL text. sql/93 extracts
-- them with the pattern SQL '([^'']*)' and would silently truncate at the first
-- inner quote, then execute the fragment. Expose a filter column as a DIMENSION
-- instead of writing WHERE col = 'literal'.
--
-- VERIFY AFTER EVERY SPLICE. If a splice altered a metric expression, the affected
-- metric stops agreeing with its canonical fact:
--
--   CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();   -- expect 14 PASS, zero spread
--   node scripts/rebuild.mjs --only 93                  -- expect 38 PASS
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

-- ---------------------------------------------------------------------------
-- The usage feedback loop.
--
-- AGENT_QUESTION_LOG and AGENT_IMPROVEMENT_CANDIDATE are created in
-- 00f_governance.sql, because the candidate view reads the log and 00f runs first.
-- The evaluation set lives in 09_agent_eval.sql.
--
-- Real questions beat imagined ones as a source of the next synonym or verified
-- query, which is why the log exists at all. AGENT_IMPROVEMENT_CANDIDATE ranks an
-- UNSTABLE_RESOLUTION worst -- the same question answered two different ways is
-- the failure this project exists to prevent, surfacing in the conversational
-- layer.
-- ---------------------------------------------------------------------------

-- Current state of the conversational assets, for the record.
SELECT 'SC_ONTOLOGY_360' AS semantic_view,
       REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360'), 'QUESTION\\s+''', 1, 'i') AS verified_queries
UNION ALL SELECT 'SC_SUPPLIER',      REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER'),      'QUESTION\\s+''', 1, 'i')
UNION ALL SELECT 'SC_FULFILLMENT',   REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT'),   'QUESTION\\s+''', 1, 'i')
UNION ALL SELECT 'SC_INVENTORY',     REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY'),     'QUESTION\\s+''', 1, 'i')
UNION ALL SELECT 'SC_LANDED_COST',   REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST'),   'QUESTION\\s+''', 1, 'i')
UNION ALL SELECT 'SC_DEMAND',        REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_DEMAND'),        'QUESTION\\s+''', 1, 'i')
UNION ALL SELECT 'SC_MANUFACTURING', REGEXP_COUNT(GET_DDL('SEMANTIC VIEW','SUPPLY_CHAIN.SEMANTIC.SC_MANUFACTURING'), 'QUESTION\\s+''', 1, 'i')
ORDER BY 1;
