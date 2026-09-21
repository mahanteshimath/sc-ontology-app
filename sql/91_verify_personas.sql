-- ---------------------------------------------------------------------------
-- 91 — Persona and row-scope verification.
--
-- WHAT THIS PROVES, AND WHY IT IS THE HARDEST THING HERE TO PROVE
--
-- The claim is that SC_LOGISTICS and SC_LOGISTICS_EU share ONE metric definition
-- and differ only in the rows they can see. That claim is easy to assert and easy
-- to get wrong in a way nothing notices: if the row access policy silently fails
-- to attach, both roles return identical numbers and the demo still "works".
--
-- So the test is a comparison, not an inspection. Same view, same metric
-- reference, same period -- only the role changes. The EU figure must differ from
-- the all-region figure, and the EU row count must be strictly smaller.
--
-- WHY THE DESIGNED GAP IS 1.5 PERCENTAGE POINTS. It was originally 0.2pp, which
-- reproduced the gap this dataset historically showed. Measured over a single
-- month (~14k EU order lines, standard error ~0.3pp) the observed gap came out at
-- 0.01pp and its sign was not stable. An assertion that can pass or fail on
-- sampling noise proves nothing, so 00c widened the designed difference until it
-- sits unambiguously outside the noise. See the header of 00c.
--
-- Run this AFTER 00a-00f and 01. It only reads.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. The policy is attached to both outbound facts.
--
-- Checked first because every comparison below is meaningless if it is not. A
-- table may carry only one row access policy, which is why 00f issues
-- DROP ALL ROW ACCESS POLICIES before adding it.
-- ---------------------------------------------------------------------------

SELECT
  'row access policy attached to ' || ref_entity_name AS check_name,
  policy_name                                        AS found,
  'RAP_SHIP_REGION'                                  AS expected,
  IFF(policy_name = 'RAP_SHIP_REGION', 'PASS', 'FAIL') AS verdict
FROM TABLE(SUPPLY_CHAIN.INFORMATION_SCHEMA.POLICY_REFERENCES(
             REF_ENTITY_NAME => 'SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT',
             REF_ENTITY_DOMAIN => 'TABLE'))
WHERE policy_kind = 'ROW_ACCESS_POLICY'
UNION ALL
SELECT
  'row access policy attached to ' || ref_entity_name,
  policy_name,
  'RAP_SHIP_REGION',
  IFF(policy_name = 'RAP_SHIP_REGION', 'PASS', 'FAIL')
FROM TABLE(SUPPLY_CHAIN.INFORMATION_SCHEMA.POLICY_REFERENCES(
             REF_ENTITY_NAME => 'SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT',
             REF_ENTITY_DOMAIN => 'TABLE'))
WHERE policy_kind = 'ROW_ACCESS_POLICY';

-- ---------------------------------------------------------------------------
-- 2. The persona catalogue is internally consistent.
--
-- PERSONA_CATALOG derives view_count from PERSONA_VIEW_ACCESS, so the count on
-- screen cannot disagree with the list beside it. Asserted anyway, because the
-- view could be replaced by a table by someone tidying up.
-- ---------------------------------------------------------------------------

SELECT 'persona count' AS check_name, COUNT(*) AS found, 5 AS expected,
       IFF(COUNT(*) = 5, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG;

SELECT
  role_name                                      AS check_name,
  view_count                                     AS found,
  ARRAY_SIZE(SPLIT(accessible_semantic_views, ', ')) AS expected,
  IFF(view_count = ARRAY_SIZE(SPLIT(accessible_semantic_views, ', ')), 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG
ORDER BY role_name;

SELECT
  'SC_LOGISTICS_EU declares a restricted row scope' AS check_name,
  row_scope                                        AS found,
  'SHIP_REGION = EU'                               AS expected,
  IFF(row_scope = 'SHIP_REGION = EU', 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG
WHERE role_name = 'SC_LOGISTICS_EU';

-- ROW_SCOPE IS MATCHED AS A STRING LITERAL BY THE APPLICATION.
--
-- app/api/consistency/route.ts:77 keeps only personas whose rowScope equals
-- exactly 'ALL REGIONS' when judging cross-persona agreement, because a
-- row-scoped persona legitimately returns a different number without the
-- definition having changed.
--
-- Seeding these as 'ALL_ROWS' instead -- which reads the same to a human, and
-- which no other assertion in this directory can see -- made zero personas
-- comparable. /consistency then observed no values at all and reported
-- supplier_otd_pct as UNPROVEN, on the single page whose purpose is to prove the
-- numbers agree. The smoke check caught it; nothing in SQL did. Hence this.
SELECT
  'unscoped personas use the exact literal the app matches on' AS check_name,
  COUNT_IF(row_scope = 'ALL REGIONS')                          AS found,
  4                                                            AS expected,
  IFF(COUNT_IF(row_scope = 'ALL REGIONS') = 4, 'PASS',
      'FAIL - /consistency will report every metric UNPROVEN') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG;

-- Exactly one role is region-scoped. If PERSONA_REGION_SCOPE ever contained a
-- role that should be unrestricted, that role would see nothing at all, because
-- the policy's middle branch returns FALSE for a scoped role on a non-matching
-- region.
SELECT 'roles carrying a region scope' AS check_name,
       COUNT(DISTINCT role_name) AS found, 1 AS expected,
       IFF(COUNT(DISTINCT role_name) = 1, 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE;

-- ---------------------------------------------------------------------------
-- 3. THE COMPARISON. One definition, two row scopes.
--
-- Run as each role in turn. The two OTD figures must differ and the EU line count
-- must be strictly smaller. Identical figures mean the policy is not filtering,
-- whatever the attachment check above says.
-- ---------------------------------------------------------------------------

USE ROLE SC_LOGISTICS;
USE WAREHOUSE COMPUTE_WH;

SELECT
  'SC_LOGISTICS  — Aug 2026 OTD, all regions'  AS scope,
  CURRENT_ROLE()                               AS role_in_effect,
  otd_pct                                      AS otd_aug_2026
FROM SEMANTIC_VIEW(
  SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT
  METRICS order_fulfillment.otd_pct
  WHERE order_fulfillment.delivery_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
);

SELECT
  'SC_LOGISTICS  — rows visible' AS scope,
  CURRENT_ROLE()                 AS role_in_effect,
  COUNT(*)                       AS visible_order_lines,
  COUNT(DISTINCT ship_region)    AS distinct_ship_regions
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT;

USE ROLE SC_LOGISTICS_EU;
USE WAREHOUSE COMPUTE_WH;

SELECT
  'SC_LOGISTICS_EU — Aug 2026 OTD, same definition' AS scope,
  CURRENT_ROLE()                                    AS role_in_effect,
  otd_pct                                           AS otd_aug_2026
FROM SEMANTIC_VIEW(
  SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT
  METRICS order_fulfillment.otd_pct
  WHERE order_fulfillment.delivery_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
);

-- The strongest single assertion in this file: under the EU role, the only
-- ship_region visible anywhere in the fact is EU.
SELECT
  'SC_LOGISTICS_EU sees only EU rows' AS check_name,
  COUNT(DISTINCT ship_region)         AS distinct_ship_regions,
  1                                   AS expected,
  MAX(ship_region)                    AS only_region,
  IFF(COUNT(DISTINCT ship_region) = 1 AND MAX(ship_region) = 'EU', 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT;

SELECT
  'SC_LOGISTICS_EU sees only EU shipments' AS check_name,
  COUNT(DISTINCT ship_region)              AS distinct_ship_regions,
  1                                        AS expected,
  MAX(ship_region)                         AS only_region,
  IFF(COUNT(DISTINCT ship_region) = 1 AND MAX(ship_region) = 'EU', 'PASS', 'FAIL') AS verdict
FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT;

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 4. The gap, computed in one statement.
--
-- Run with owner's rights so both populations are visible at once. This is the
-- number 00c was tuned to produce: an unambiguous difference, not a coin flip.
-- ---------------------------------------------------------------------------

WITH g AS (
  SELECT
    AVG(is_on_time)                                           AS otd_all,
    AVG(IFF(ship_region = 'EU', is_on_time, NULL))             AS otd_eu,
    COUNT(*)                                                  AS lines_all,
    COUNT_IF(ship_region = 'EU')                              AS lines_eu
  FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
  WHERE delivery_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
)
SELECT
  'EU row scope produces a distinguishable figure' AS check_name,
  ROUND(otd_all, 6)                                AS otd_all_regions,
  ROUND(otd_eu, 6)                                 AS otd_eu_only,
  ROUND(ABS(otd_eu - otd_all), 6)                  AS gap,
  lines_all, lines_eu,
  -- 0.003 is ten times the standard error of a single month's EU population, so
  -- clearing it cannot happen by chance.
  IFF(ABS(otd_eu - otd_all) > 0.003 AND lines_eu < lines_all, 'PASS',
      'FAIL - the gap is within sampling noise, so this proves nothing about row scoping') AS verdict
FROM g;
