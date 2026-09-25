-- ---------------------------------------------------------------------------
-- 12 — Ontology hierarchies.
--
-- The problem statement names four things an ontology must define: entities,
-- relationships, HIERARCHIES, and canonical metrics. Three of them were already
-- derived from INFORMATION_SCHEMA and therefore incapable of drifting from the
-- deployed views. Hierarchies were not: they were a hard-coded array in
-- app/ontology/page.tsx, and three of the level names in it
-- (SUPPLIER, NODE, CUSTOMER) were not dimensions of SC_ONTOLOGY_360 at all.
-- Nothing failed. The page simply described a rollup that did not exist.
--
-- WHY THIS IS A TABLE WHEN THE REST OF THE CATALOGUE IS A VIEW
-- A Snowflake semantic view has no hierarchy construct, so unlike entities and
-- relationships there is nothing in INFORMATION_SCHEMA to read a hierarchy back
-- from. A declaration is therefore unavoidable. What IS avoidable is an
-- UNCHECKED declaration, and that is what this file removes:
--
--   1. RESOLUTION. Every declared level is joined to
--      INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS, so a level naming a dimension the
--      view does not have is visibly unresolved rather than silently rendered.
--   2. ROLLUP. Every parent/child pair is MEASURED against the conformed
--      dimension it is sourced from. A hierarchy level only rolls up if each
--      child value has exactly one parent value; anything else is a
--      classification wearing a hierarchy's clothes.
--
-- Rule 2 is not theoretical either. Two plausible-looking rollups were proposed
-- and both are false in this data:
--     SUPPLIER_GROUP  -> SUPPLIER_REGION   6 groups span more than one region
--     CUSTOMER_SEGMENT-> CUSTOMER_REGION   4 segments span more than one region
-- Commodity group and go-to-market segment are cross-regional by construction.
-- Stacking them into a single chain would have produced a drill path that double
-- counts, so they are declared as their own two-level hierarchies instead.
--
-- ORDER. This must follow 01_calendar_dimension.sql: the TIME hierarchy's levels
-- only exist on SC_ONTOLOGY_360 after 01 splices CALENDAR in, and the resolution
-- check would report four MISSING levels if it ran before.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE TABLE ONTOLOGY_HIERARCHY (
  hierarchy_id    STRING NOT NULL COMMENT 'Stable id of the hierarchy.',
  hierarchy_name  STRING NOT NULL COMMENT 'Display name.',
  semantic_view   STRING NOT NULL COMMENT 'Semantic view the levels must resolve against.',
  entity          STRING NOT NULL COMMENT 'Ontology entity the hierarchy belongs to.',
  level_no        NUMBER NOT NULL COMMENT 'Level, 1 = finest grain. Levels must be contiguous from 1.',
  level_dimension STRING NOT NULL COMMENT 'Dimension name within the entity, as declared in the semantic view.',
  source_table    STRING NOT NULL COMMENT 'Conformed dimension table the rollup is measured against.',
  source_column   STRING NOT NULL COMMENT 'Column in SOURCE_TABLE backing this level.',
  description     STRING COMMENT 'What this level means in business terms.',
  CONSTRAINT pk_ontology_hierarchy PRIMARY KEY (hierarchy_id, level_no)
)
COMMENT = 'Declared drill paths. A declaration alone proves nothing: VALIDATE_ONTOLOGY_HIERARCHY measures every level against the deployed view and the source data.';

INSERT INTO ONTOLOGY_HIERARCHY
  (hierarchy_id, hierarchy_name, semantic_view, entity, level_no, level_dimension, source_table, source_column, description)
SELECT * FROM VALUES
 -- Product. The only three-plus-level chain over a business dimension, and the
 -- one the application groups by most often.
 ('PRODUCT','Product','SC_ONTOLOGY_360','PART',1,'MATERIAL','SUPPLY_CHAIN.RAW.PART','MATERIAL_ID','The material itself. Finest grain of everything bought, made, stocked and sold.'),
 ('PRODUCT','Product','SC_ONTOLOGY_360','PART',2,'PRODUCT_FAMILY','SUPPLY_CHAIN.RAW.PART','PRODUCT_FAMILY','Product family. The most-used analytical grouping in the application.'),
 ('PRODUCT','Product','SC_ONTOLOGY_360','PART',3,'BUSINESS_SEGMENT','SUPPLY_CHAIN.RAW.PART','BUSINESS_SEGMENT','Reporting segment the family rolls into.'),

 -- Sourcing and commodity are SIBLINGS, not a chain. See the header note.
 ('SOURCING','Sourcing geography','SC_ONTOLOGY_360','SUPPLIER',1,'SUPPLIER_NAME','SUPPLY_CHAIN.RAW.SUPPLIER','SUPPLIER_NAME','The vendor.'),
 ('SOURCING','Sourcing geography','SC_ONTOLOGY_360','SUPPLIER',2,'SUPPLIER_REGION','SUPPLY_CHAIN.RAW.SUPPLIER','SUPPLIER_REGION','Region goods are sourced from. The inbound region.'),

 ('COMMODITY','Commodity','SC_ONTOLOGY_360','SUPPLIER',1,'SUPPLIER_NAME','SUPPLY_CHAIN.RAW.SUPPLIER','SUPPLIER_NAME','The vendor.'),
 ('COMMODITY','Commodity','SC_ONTOLOGY_360','SUPPLIER',2,'SUPPLIER_GROUP','SUPPLY_CHAIN.RAW.SUPPLIER','SUPPLIER_GROUP','Commodity group the vendor is managed under. Crosses regions by design.'),

 ('NETWORK','Network','SC_ONTOLOGY_360','NODE',1,'NODE_NAME','SUPPLY_CHAIN.RAW.NODE','NODE_NAME','Plant or distribution centre.'),
 ('NETWORK','Network','SC_ONTOLOGY_360','NODE',2,'NODE_REGION','SUPPLY_CHAIN.RAW.NODE','NODE_REGION','Region the node serves.'),

 ('ACCOUNT','Account','SC_ONTOLOGY_360','CUSTOMER',1,'CUSTOMER_NAME','SUPPLY_CHAIN.RAW.CUSTOMER','CUSTOMER_NAME','The account.'),
 ('ACCOUNT','Account','SC_ONTOLOGY_360','CUSTOMER',2,'CUSTOMER_SEGMENT','SUPPLY_CHAIN.RAW.CUSTOMER','CUSTOMER_SEGMENT','Go-to-market segment. Crosses regions by design.'),

 ('SALES_GEO','Sales geography','SC_ONTOLOGY_360','CUSTOMER',1,'CUSTOMER_NAME','SUPPLY_CHAIN.RAW.CUSTOMER','CUSTOMER_NAME','The account.'),
 ('SALES_GEO','Sales geography','SC_ONTOLOGY_360','CUSTOMER',2,'CUSTOMER_REGION','SUPPLY_CHAIN.RAW.CUSTOMER','CUSTOMER_REGION','Region the account is managed in. Where the account sits, not where goods went.'),

 -- Time. Only resolvable after 01 splices CALENDAR into SC_ONTOLOGY_360.
 ('TIME','Time','SC_ONTOLOGY_360','CALENDAR',1,'CAL_DATE','SUPPLY_CHAIN.RAW.DATE_DIM','DATE_KEY','Calendar day. The event date of every day-grain fact.'),
 ('TIME','Time','SC_ONTOLOGY_360','CALENDAR',2,'CAL_MONTH','SUPPLY_CHAIN.RAW.DATE_DIM','MONTH_START','First day of the calendar month.'),
 ('TIME','Time','SC_ONTOLOGY_360','CALENDAR',3,'CAL_QUARTER','SUPPLY_CHAIN.RAW.DATE_DIM','FISCAL_QUARTER','Fiscal quarter, calendar-aligned.'),
 ('TIME','Time','SC_ONTOLOGY_360','CALENDAR',4,'CAL_YEAR','SUPPLY_CHAIN.RAW.DATE_DIM','YEAR_NUM','Calendar year.');

CREATE OR REPLACE TABLE ONTOLOGY_HIERARCHY_VALIDATION (
  run_id            STRING NOT NULL COMMENT 'One id per validation run.',
  run_at            TIMESTAMP_LTZ NOT NULL,
  hierarchy_id      STRING NOT NULL,
  level_no          NUMBER NOT NULL,
  level_dimension   STRING NOT NULL,
  resolves          BOOLEAN COMMENT 'TRUE when the level names a dimension the semantic view actually declares.',
  rollup_status     STRING COMMENT 'BASE for level 1, PASS when every child has exactly one parent, FAIL when it does not, ERROR when the test could not run.',
  distinct_children NUMBER COMMENT 'Distinct values at the level below.',
  distinct_parents  NUMBER COMMENT 'Distinct values at this level.',
  violation_count   NUMBER COMMENT 'Child values mapping to more than one parent. Must be 0.',
  detail            STRING
)
COMMENT = 'Per-level evidence that a declared hierarchy is real. Written by VALIDATE_ONTOLOGY_HIERARCHY.';

-- ---------------------------------------------------------------------------
-- VALIDATE_ONTOLOGY_HIERARCHY — the control.
--
-- Same shape as METRIC_DRIFT_TEST and for the same reason: a per-level failure is
-- recorded and the loop continues, because a run that stops at the first broken
-- level reports nothing about the other sixteen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE VALIDATE_ONTOLOGY_HIERARCHY()
RETURNS TABLE()
LANGUAGE SQL
COMMENT = 'Checks every declared hierarchy level resolves to a dimension of its semantic view, and measures each parent/child pair against the source dimension to confirm it is a true rollup. Writes ONTOLOGY_HIERARCHY_VALIDATION.'
AS $$
DECLARE
  v_run_id   STRING;
  v_run_at   TIMESTAMP_LTZ;
  v_hid      STRING;
  v_lvl      NUMBER;
  v_dim      STRING;
  v_entity   STRING;
  v_view     STRING;
  v_src      STRING;
  v_col      STRING;
  v_psrc     STRING;
  v_pcol     STRING;
  v_resolves BOOLEAN;
  v_status   STRING;
  v_kids     NUMBER;
  v_parents  NUMBER;
  v_viol     NUMBER;
  v_detail   STRING;
  v_sql      STRING;
  res        RESULTSET;
  -- The level below is carried alongside each level so the rollup can be tested
  -- without a second lookup. LAG over the same hierarchy gives the child.
  levels CURSOR FOR
    SELECT hierarchy_id, level_no, level_dimension, entity, semantic_view,
           source_table, source_column,
           LAG(source_table)  OVER (PARTITION BY hierarchy_id ORDER BY level_no) AS child_table,
           LAG(source_column) OVER (PARTITION BY hierarchy_id ORDER BY level_no) AS child_column
      FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_HIERARCHY
     ORDER BY hierarchy_id, level_no;
BEGIN
  v_run_id := UUID_STRING();
  v_run_at := CURRENT_TIMESTAMP();

  FOR l IN levels DO
    v_hid    := l.hierarchy_id;
    v_lvl    := l.level_no;
    v_dim    := l.level_dimension;
    v_entity := l.entity;
    v_view   := l.semantic_view;
    v_src    := l.source_table;
    v_col    := l.source_column;
    v_psrc   := l.child_table;
    v_pcol   := l.child_column;
    v_kids   := NULL;
    v_parents:= NULL;
    v_viol   := NULL;

    -- 1. Does the semantic view actually declare this dimension?
    SELECT COUNT(*) > 0 INTO v_resolves
      FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS
     WHERE semantic_view_name = :v_view AND table_name = :v_entity AND name = :v_dim;

    -- 2. Is it a true rollup from the level below?
    IF (v_pcol IS NULL) THEN
      v_status := 'BASE';
      v_detail := 'finest grain; nothing below it to roll up';
    ELSEIF (v_psrc <> v_src) THEN
      -- Two levels sourced from different tables cannot be tested with one GROUP BY,
      -- and a hierarchy that spans dimensions is a join, not a rollup.
      v_status := 'ERROR';
      v_detail := 'level is sourced from ' || v_src || ' but the level below is from ' || v_psrc;
    ELSE
      BEGIN
        -- Counted in one pass, but the populations are counted OUTSIDE the
        -- violation filter: a WHERE n > 1 wrapped around the whole thing would
        -- report the size of the broken part rather than of the level.
        v_sql := 'WITH g AS (SELECT ' || v_pcol || ' AS child, COUNT(DISTINCT ' || v_col
              || ') AS parents FROM ' || v_src || ' GROUP BY 1) '
              || 'SELECT COUNT(*), (SELECT COUNT(DISTINCT ' || v_col || ') FROM ' || v_src
              || '), COUNT_IF(parents > 1) FROM g';
        LET rres RESULTSET := (EXECUTE IMMEDIATE :v_sql);
        LET rcur CURSOR FOR rres;
        OPEN rcur;
        FETCH rcur INTO v_kids, v_parents, v_viol;
        CLOSE rcur;
        v_status := IFF(COALESCE(v_viol, 1) = 0, 'PASS', 'FAIL');
        v_detail := v_kids || ' ' || v_pcol || ' values roll into ' || v_parents || ' '
                 || v_col || ' values; ' || v_viol || ' map to more than one';
      EXCEPTION
        WHEN OTHER THEN
          v_status := 'ERROR';
          v_detail := 'rollup test failed: ' || SQLERRM;
      END;
    END IF;

    IF (NOT v_resolves) THEN
      v_detail := v_entity || '.' || v_dim || ' is not a dimension of ' || v_view || '. ' || v_detail;
    END IF;

    INSERT INTO SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_HIERARCHY_VALIDATION
      (run_id, run_at, hierarchy_id, level_no, level_dimension, resolves,
       rollup_status, distinct_children, distinct_parents, violation_count, detail)
    SELECT :v_run_id, :v_run_at, :v_hid, :v_lvl, :v_dim, :v_resolves,
           :v_status, :v_kids, :v_parents, :v_viol, :v_detail;
  END FOR;

  res := (
    SELECT hierarchy_id, level_no, level_dimension, resolves, rollup_status,
           distinct_children, distinct_parents, violation_count, detail
      FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_HIERARCHY_VALIDATION
     WHERE run_id = :v_run_id
     ORDER BY hierarchy_id, level_no
  );
  RETURN TABLE(res);
END;
$$;

-- What /ontology renders: the declaration, its resolution against the deployed
-- view, and the latest measured rollup result, in one row per level.
CREATE OR REPLACE VIEW V_ONTOLOGY_HIERARCHY
  COMMENT = 'Declared hierarchy levels joined to the deployed semantic view and to the most recent validation run. A level that does not resolve, or does not roll up, is visible rather than silently rendered.'
AS
WITH latest AS (
  SELECT *
    FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_HIERARCHY_VALIDATION
  QUALIFY ROW_NUMBER() OVER (PARTITION BY hierarchy_id, level_no ORDER BY run_at DESC) = 1
)
SELECT
  h.hierarchy_id,
  h.hierarchy_name,
  h.semantic_view,
  h.entity,
  h.level_no,
  h.level_dimension,
  h.entity || '.' || h.level_dimension AS dimension_ref,
  h.source_table,
  h.source_column,
  h.description,
  (d.name IS NOT NULL)                 AS resolves,
  MAX(h.level_no) OVER (PARTITION BY h.hierarchy_id) AS level_count,
  v.rollup_status,
  v.distinct_children,
  v.distinct_parents,
  v.violation_count,
  v.detail                             AS validation_detail,
  v.run_at                             AS validated_at
FROM SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_HIERARCHY h
LEFT JOIN SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS d
       ON d.semantic_view_name = h.semantic_view
      AND d.table_name         = h.entity
      AND d.name               = h.level_dimension
LEFT JOIN latest v
       ON v.hierarchy_id = h.hierarchy_id
      AND v.level_no     = h.level_no;

CALL VALIDATE_ONTOLOGY_HIERARCHY();

-- Assertions. 90_verify_base.sql repeats these so a later change to a semantic
-- view is caught by the verification phase, not only on the day this file runs.
SELECT 'every hierarchy level resolves to a deployed dimension' AS check_name,
       COUNT_IF(NOT resolves) AS unresolved,
       IFF(COUNT_IF(NOT resolves) = 0, 'PASS', 'FAIL') AS status
  FROM V_ONTOLOGY_HIERARCHY;

SELECT 'every declared rollup is a true functional dependency' AS check_name,
       COUNT_IF(rollup_status NOT IN ('PASS','BASE')) AS bad_levels,
       IFF(COUNT_IF(rollup_status NOT IN ('PASS','BASE')) = 0, 'PASS', 'FAIL') AS status
  FROM V_ONTOLOGY_HIERARCHY;
