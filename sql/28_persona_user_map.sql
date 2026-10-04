-- =============================================================================
-- 28  SPCS caller -> persona mapping
--
-- Inside Snowflake App Runtime there is no demo sign-in: ingress authenticates the
-- caller and injects their user name (Sf-Context-Current-User). lib/session.ts maps
-- that user to exactly one persona role here, and every data route then executes
-- under that role, so row access and masking apply to the person asking.
--
-- AN UNMAPPED CALLER IS REFUSED (HTTP 403), never served under the application's own
-- identity. That fallback is what previously made the hosted persona proof void.
--
-- Idempotent: MERGE, safe to re-run.
-- =============================================================================

USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE TABLE IF NOT EXISTS PERSONA_USER_MAP (
  user_name    STRING NOT NULL COMMENT 'Snowflake LOGIN/user name as injected by SPCS ingress. Matched case-insensitively.',
  persona_role STRING NOT NULL COMMENT 'Exactly one persona role from PERSONA_CATALOG. The caller is served only under this role.',
  granted_by   STRING DEFAULT CURRENT_USER(),
  granted_at   TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_persona_user_map PRIMARY KEY (user_name)
)
COMMENT = 'Maps an SPCS-authenticated Snowflake user to one persona role. Unmapped users get no data.';

-- Seed: the account owner acts as the steward. Map real users with the same MERGE.
MERGE INTO PERSONA_USER_MAP t
USING (SELECT * FROM VALUES ('MONTY', 'SC_ONTOLOGY_STEWARD') AS v(user_name, persona_role)) s
   ON UPPER(t.user_name) = UPPER(s.user_name)
 WHEN MATCHED THEN UPDATE SET persona_role = s.persona_role
 WHEN NOT MATCHED THEN INSERT (user_name, persona_role) VALUES (s.user_name, s.persona_role);

-- A mapping to a role that is not a registered persona would be refused at request
-- time anyway; this makes the mistake visible at deploy time instead.
SELECT m.user_name, m.persona_role, IFF(p.role_name IS NULL, 'NOT A PERSONA', 'OK') AS status
  FROM PERSONA_USER_MAP m
  LEFT JOIN PERSONA_CATALOG p ON p.role_name = m.persona_role;
