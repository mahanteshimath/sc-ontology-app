-- ---------------------------------------------------------------------------
-- 23 - The weekly contract-breach digest: the finding, delivered to a person.
--
-- A dashboard waits to be opened. The penalty a legacy definition hides is only
-- recovered if someone in procurement reads about it, so every Monday this sends
-- the steward the same figures /impact shows: breaches, claimable penalties, the
-- share hidden by the legacy definition, the suppliers behind them, the
-- definition conflicts to renegotiate, and any extraction waiting for review.
--
-- Uses SC_GOVERNANCE_EMAIL from sql/06 (Snowflake only delivers to verified
-- users' addresses in the account). CONTRACT_BREACH_DIGEST(FALSE) previews the
-- email without sending it; the task sends.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;
USE WAREHOUSE COMPUTE_WH;

CREATE OR REPLACE PROCEDURE CONTRACT_BREACH_DIGEST(P_SEND BOOLEAN)
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Composes the weekly contract-breach digest from V_CONTRACT_IMPACT and V_SUPPLIER_CONTRACT_COMPLIANCE. P_SEND = FALSE returns a preview; TRUE also emails it via SC_GOVERNANCE_EMAIL.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  subject STRING;
  body STRING;
  top_lines STRING;
  conflict_lines STRING;
  recipient STRING;
BEGIN
  SELECT LISTAGG('  - ' || supplier_name || ' (' || supplier_region || '): governed OTD '
                 || TRIM(TO_VARCHAR(governed_otd, '0.0000')) || ' vs contracted ' || TRIM(TO_VARCHAR(otd_commitment, '0.00'))
                 || IFF(compliance_status = 'HIDDEN_BREACH', ' [HIDDEN - legacy dashboard shows compliant]', '')
                 || ', claimable $' || TRIM(TO_VARCHAR(penalty_exposure_usd, '999,999')), '\n')
           WITHIN GROUP (ORDER BY IFF(compliance_status = 'HIDDEN_BREACH', 0, 1), penalty_exposure_usd DESC)
    INTO :top_lines
    FROM (SELECT * FROM V_SUPPLIER_CONTRACT_COMPLIANCE WHERE breach_governed
          ORDER BY IFF(compliance_status = 'HIDDEN_BREACH', 0, 1), penalty_exposure_usd DESC LIMIT 10);

  SELECT LISTAGG('  - ' || supplier_name || ' (' || contract_number || ')', '\n') WITHIN GROUP (ORDER BY supplier_name)
    INTO :conflict_lines
    FROM (SELECT * FROM V_SUPPLIER_CONTRACT_COMPLIANCE WHERE definition_conflict ORDER BY supplier_name LIMIT 5);

  SELECT 'Supply chain contracts: ' || hidden_breaches || ' hidden breaches, $'
           || TRIM(TO_VARCHAR(penalty_missed_by_legacy_usd, '999,999,999')) || ' unclaimed',
         'Weekly contract-breach digest - governed supplier OTD vs signed commitments.\n\n'
         || 'Claimable penalties:     $' || TRIM(TO_VARCHAR(penalty_exposure_usd, '999,999,999')) || ' across ' || breaches_governed || ' suppliers\n'
         || 'Hidden by legacy metric: $' || TRIM(TO_VARCHAR(penalty_missed_by_legacy_usd, '999,999,999')) || ' across ' || hidden_breaches || ' suppliers\n'
         || 'Definition conflicts:    ' || definition_conflicts || ' contracts measure OTD as a monthly average\n'
         || 'Awaiting human review:   ' || needs_review || ' extraction(s)\n'
         || 'Extraction accuracy:     ' || TRIM(TO_VARCHAR(extraction_accuracy * 100, '990.0')) || '% of fields vs ground truth\n\n'
         || 'Top breaches (hidden first):\n' || COALESCE(:top_lines, '  none') || '\n\n'
         || 'Contracts to renegotiate onto the governed definition (first 5 of ' || definition_conflicts || '):\n'
         || COALESCE(:conflict_lines, '  none') || '\n\n'
         || 'Source: SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE. OTD is read from the governed '
         || 'V_SUPPLIER_OTD_VERDICT, never recomputed. Targets and penalty terms are illustrative; the arithmetic is not.'
    INTO :subject, :body
    FROM V_CONTRACT_IMPACT;

  -- The recipient is account-specific and set by sql/06 (NOTIFICATION_SETTING).
  SELECT MAX(setting_value) INTO :recipient
    FROM NOTIFICATION_SETTING WHERE setting_key = 'STEWARD_EMAIL';
  IF (P_SEND AND recipient IS NOT NULL) THEN
    CALL SYSTEM$SEND_EMAIL('SC_GOVERNANCE_EMAIL', :recipient, :subject, :body);
  END IF;
  RETURN OBJECT_CONSTRUCT('sent', P_SEND AND recipient IS NOT NULL, 'recipient', recipient, 'subject', subject, 'body', body);
END;
$$;

CREATE OR REPLACE TASK CONTRACT_BREACH_DIGEST_WEEKLY
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 30 7 * * 1 UTC'
  COMMENT = 'Monday 07:30 UTC: email the contract-breach digest to the ontology steward.'
AS
  CALL SUPPLY_CHAIN.GOVERNANCE.CONTRACT_BREACH_DIGEST(TRUE);
-- Created SUSPENDED on purpose: resuming it sends real email every Monday. Turn it on deliberately:
--   ALTER TASK SUPPLY_CHAIN.GOVERNANCE.CONTRACT_BREACH_DIGEST_WEEKLY RESUME;
ALTER TASK CONTRACT_BREACH_DIGEST_WEEKLY SUSPEND;

-- Preview only - nothing is sent by the build.
CALL CONTRACT_BREACH_DIGEST(FALSE);
