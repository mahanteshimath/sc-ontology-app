-- ---------------------------------------------------------------------------
-- App service principal: the least-privilege identity the deployed app signs in as.
--
-- NOT part of scripts/rebuild.mjs, deliberately (same reasoning as
-- sql/ci/create_ci_user.sql): creating a principal is an account-level change that
-- someone should review and run by hand, once.
--
-- WHY. Outside SPCS the app previously signed in as a human user (MONTY) with a
-- password. That user also holds ACCOUNTADMIN, so a leaked Vercel env var was an
-- account-takeover credential. SVC_SC_ONTOLOGY_APP is TYPE = SERVICE (no password,
-- no MFA prompt, no Snowsight login), key-pair only, and its only role is
-- SC_APP_SERVICE.
--
-- WHAT SC_APP_SERVICE CAN DO. Nothing directly. It is a role container that holds
-- the five persona roles so lib/persona.ts can `USE ROLE <persona>` +
-- `USE SECONDARY ROLES NONE` per request. Its default primary role is
-- SC_ONTOLOGY_STEWARD (registry / catalogue reads). It holds no ACCOUNTADMIN,
-- SYSADMIN, SECURITYADMIN, no CREATE privilege anywhere, and no RAW access.
--
-- Setup:
--   1. openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out sc_app_rsa.p8 -nocrypt
--      openssl rsa -in sc_app_rsa.p8 -pubout -out sc_app_rsa.pub
--   2. Paste the public key body (no header/footer) into RSA_PUBLIC_KEY below, run this file.
--   3. Vercel env: SNOWFLAKE_USER=SVC_SC_ONTOLOGY_APP, SNOWFLAKE_ROLE=SC_ONTOLOGY_STEWARD,
--      SNOWFLAKE_PRIVATE_KEY=<contents of sc_app_rsa.p8>; remove SNOWFLAKE_PASSWORD.
-- ---------------------------------------------------------------------------

USE ROLE SECURITYADMIN;

CREATE ROLE IF NOT EXISTS SC_APP_SERVICE
  COMMENT = 'Container role for the app service principal. Holds only the persona roles; owns nothing, creates nothing.';

GRANT ROLE SC_PLANNER          TO ROLE SC_APP_SERVICE;
GRANT ROLE SC_PROCUREMENT      TO ROLE SC_APP_SERVICE;
GRANT ROLE SC_LOGISTICS        TO ROLE SC_APP_SERVICE;
GRANT ROLE SC_LOGISTICS_EU     TO ROLE SC_APP_SERVICE;
GRANT ROLE SC_ONTOLOGY_STEWARD TO ROLE SC_APP_SERVICE;

USE ROLE USERADMIN;

CREATE USER IF NOT EXISTS SVC_SC_ONTOLOGY_APP
  TYPE = SERVICE
  DEFAULT_ROLE = SC_ONTOLOGY_STEWARD
  DEFAULT_WAREHOUSE = COMPUTE_WH
  DEFAULT_SECONDARY_ROLES = ()
  COMMENT = 'Supply Chain Ontology app (Vercel/local). Key-pair only. Role SC_APP_SERVICE: persona roles only.';
-- ALTER USER SVC_SC_ONTOLOGY_APP SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';

USE ROLE SECURITYADMIN;
GRANT ROLE SC_APP_SERVICE TO USER SVC_SC_ONTOLOGY_APP;

-- Verification: the principal must hold no admin role, directly or inherited.
SHOW GRANTS TO USER SVC_SC_ONTOLOGY_APP;
SHOW GRANTS TO ROLE SC_APP_SERVICE;
