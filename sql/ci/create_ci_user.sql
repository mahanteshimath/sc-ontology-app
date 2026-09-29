-- ---------------------------------------------------------------------------
-- CI service user for .github/workflows/governance-gate.yml.
--
-- NOT part of scripts/rebuild.mjs, deliberately. Creating a principal is an
-- account-level change that someone should review and run by hand, once.
--
-- OIDC (workload identity federation): GitHub mints a short-lived token per job,
-- Snowflake matches its issuer + subject to this user. No password or key exists
-- to leak. The subject is exact and case-sensitive - it trusts pushes to main of
-- this repository and nothing else.
--
-- For pull requests from branches in this repo, GitHub's subject is
-- 'repo:<owner>/<repo>:pull_request'. Add a second user with that subject (same
-- role) if the gate should also authenticate on PRs - see the commented block.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;

CREATE USER IF NOT EXISTS SVC_GITHUB_ACTIONS
  TYPE = SERVICE
  DEFAULT_ROLE = SC_CI_GATE
  DEFAULT_WAREHOUSE = COMPUTE_WH
  COMMENT = 'GitHub Actions governance gate (OIDC). Role SC_CI_GATE: may call CI_GOVERNANCE_GATE only.'
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = 'https://token.actions.githubusercontent.com'
    SUBJECT = 'repo:mahanteshimath/sc-ontology-app:ref:refs/heads/main'
  );
GRANT ROLE SC_CI_GATE TO USER SVC_GITHUB_ACTIONS;

-- Pull requests (same-repo branches):
-- CREATE USER IF NOT EXISTS SVC_GITHUB_ACTIONS_PR
--   TYPE = SERVICE DEFAULT_ROLE = SC_CI_GATE DEFAULT_WAREHOUSE = COMPUTE_WH
--   WORKLOAD_IDENTITY = (TYPE = OIDC
--     ISSUER = 'https://token.actions.githubusercontent.com'
--     SUBJECT = 'repo:mahanteshimath/sc-ontology-app:pull_request');
-- GRANT ROLE SC_CI_GATE TO USER SVC_GITHUB_ACTIONS_PR;

-- If the account restricts inbound traffic, allow GitHub-hosted runners with the
-- Snowflake-managed rule (never a hand-maintained CIDR list):
--   SNOWFLAKE.NETWORK_SECURITY.GITHUBACTIONS_GLOBAL
