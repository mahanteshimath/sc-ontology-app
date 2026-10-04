-- ---------------------------------------------------------------------------
-- 26 — Column masking: material cost is commercially sensitive.
--
-- MATERIAL_COST on a shipment is standard cost times quantity — it exposes the
-- negotiated cost of goods per lane and customer, which procurement owns and
-- logistics has no need to see. Logistics still sees every freight, duty and
-- handling component and the total, so its cost-to-serve analysis is intact.
--
-- WHY THIS CANNOT CHANGE A GOVERNED NUMBER. No semantic-view fact or metric
-- references MATERIAL_COST (grep sql/ for "\.material_cost": only 00d), and
-- TOTAL_LANDED_COST is materialised at build time in 00d, so landed cost per
-- unit is identical for every persona. Masking changes what a persona can SEE in
-- the drill-down, never what a metric SAYS — which is the line between
-- governance and inconsistency.
--
-- The policy is tag-based: SC_SENSITIVITY = 'CONFIDENTIAL' carries the policy,
-- so any future column tagged CONFIDENTIAL is masked without another ALTER.
-- Idempotent.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE TAG IF NOT EXISTS SC_SENSITIVITY
  ALLOWED_VALUES 'PUBLIC', 'INTERNAL', 'CONFIDENTIAL'
  COMMENT = 'Data sensitivity. CONFIDENTIAL columns are masked by MP_CONFIDENTIAL_NUMBER for roles without a commercial need.';

CREATE MASKING POLICY IF NOT EXISTS MP_CONFIDENTIAL_NUMBER AS (val NUMBER) RETURNS NUMBER ->
  CASE
    WHEN IS_ROLE_IN_SESSION('SC_PROCUREMENT')
      OR IS_ROLE_IN_SESSION('SC_ONTOLOGY_STEWARD')
      OR IS_ROLE_IN_SESSION('SC_ANALYST_SQLGEN')
      OR IS_ROLE_IN_SESSION('ACCOUNTADMIN')
      THEN val
    ELSE NULL
  END
  COMMENT = 'Commercial cost data: visible to procurement and the steward, NULL for every other persona.';

-- Re-runnable: unset first so the SET below never fails on "already attached".
ALTER TAG SC_SENSITIVITY UNSET MASKING POLICY MP_CONFIDENTIAL_NUMBER;
ALTER TAG SC_SENSITIVITY SET MASKING POLICY MP_CONFIDENTIAL_NUMBER;

ALTER TABLE CANONICAL.FCT_LANDED_COST_SHIPMENT
  MODIFY COLUMN MATERIAL_COST SET TAG GOVERNANCE.SC_SENSITIVITY = 'CONFIDENTIAL';

-- Verification: logistics sees NULL, procurement/steward see the value, the metric is unchanged.
SELECT policy_name, policy_kind, ref_column_name, tag_name
  FROM TABLE(INFORMATION_SCHEMA.POLICY_REFERENCES(
         REF_ENTITY_NAME => 'SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT', REF_ENTITY_DOMAIN => 'table'));
