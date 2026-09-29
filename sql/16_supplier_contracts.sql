-- ---------------------------------------------------------------------------
-- 16 - Supplier contracts: the unstructured source, and what it is worth.
--
-- Every other source in this ontology is a table. The brief names supplier
-- systems, and in practice the most consequential supplier data is not in a
-- table at all: it is the contract. The on-time commitment a supplier signed,
-- how that commitment is measured, and what a miss costs them are written in
-- prose, in slightly different words in every agreement, and read by a person
-- when -- and only when -- somebody thinks to look.
--
-- This file makes the contract a first-class ontology entity:
--
--   RAW.SUPPLIER_CONTRACT_DOC          one free-text agreement per supplier
--   CANONICAL.DIM_SUPPLIER_CONTRACT    the terms, extracted by AI_EXTRACT
--   GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY
--                                      extraction scored against ground truth
--   GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE
--                                      governed OTD vs. the signed commitment
--   GOVERNANCE.V_CONTRACT_IMPACT       the one-row headline the app renders
--   SEMANTIC.SUPPLIER_CONTRACT_SEARCH  Cortex Search over the clause text
--   SEMANTIC.SC_CONTRACT               the semantic view the agent queries
--
-- WHY THE DOCUMENTS ARE GENERATED, AND WHY THAT IS STILL A REAL TEST
-- The contracts are synthetic, like every other row here, and are written from
-- three differently-worded templates so the extraction has to read rather than
-- pattern-match: "95%", "ninety-five per cent (95%)" and "0.95 of all lines" all
-- mean the same commitment. The generator keeps its own answers in
-- RAW.SUPPLIER_CONTRACT_TERMS_TRUTH, which nothing downstream reads except the
-- accuracy view. So the extraction is SCORED, not asserted -- the same standard
-- the drift test applies to metrics and the eval applies to the chat layer.
--
-- THE FINDING THIS FILE EXISTS TO PRODUCE
-- 13_divergence_impact.sql counts the suppliers the legacy definition wrongly
-- clears. That is a count. Joined to the contract, it becomes money: every one
-- of those suppliers that also breached its signed commitment carries a penalty
-- that the legacy dashboard would never have prompted anyone to claim.
--
-- A SECOND FINDING, WHICH IS A GOVERNANCE FINDING RATHER THAN A NUMBER
-- Roughly a quarter of the agreements define on-time delivery as a monthly
-- average -- the average-of-averages definition this project exists to retire.
-- For those suppliers the contract itself encodes the non-governed metric, so
-- the enforceable number and the governed number differ by construction. They
-- are flagged DEFINITION_CONFLICT for procurement to renegotiate, not silently
-- rescored.
--
-- SCOPE. Penalty rates, caps and commitments are ILLUSTRATIVE, the same
-- convention as sql/03_targets.sql. What is not illustrative is the arithmetic:
-- late-line value is summed from the same 420,000 receipt lines the governed
-- metric is defined over, and both OTD figures are the ones 13 already publishes.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE WAREHOUSE COMPUTE_WH;

-- ---------------------------------------------------------------------------
-- 1. Ground truth. The generator's answers, kept apart from the documents.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE RAW.SUPPLIER_CONTRACT_TERMS_TRUTH
  COMMENT = 'Generator ground truth for the synthetic supplier contracts. Read ONLY by GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY to score AI_EXTRACT. Never a source for any business metric.'
AS
SELECT
  s.supplier_id,
  s.supplier_name,
  s.supplier_region,
  'SCA-' || RIGHT(s.supplier_id, 4) || '-' || (2024 + ABS(HASH(s.supplier_id, 'yr')) % 2)  AS contract_number,
  ABS(HASH(s.supplier_id, 'tpl')) % 3                                                    AS template_id,
  [0.80, 0.82, 0.85, 0.86, 0.88][ABS(HASH(s.supplier_id, 'otd')) % 5]::NUMBER(4,2)       AS otd_commitment,
  IFF(ABS(HASH(s.supplier_id, 'basis')) % 100 < 25, 'MONTHLY_AVERAGE', 'PER_LINE')       AS otd_basis,
  [1, 2, 3, 5][ABS(HASH(s.supplier_id, 'pen')) % 4]::NUMBER(4,1)                         AS penalty_pct,
  [25000, 50000, 100000, 250000][ABS(HASH(s.supplier_id, 'cap')) % 4]::NUMBER(12,0)      AS penalty_cap_usd,
  (14 + ABS(HASH(s.supplier_id, 'lt')) % 47)::NUMBER(4,0)                                AS lead_time_days,
  ['Net 30', 'Net 45', 'Net 60', 'Net 90'][ABS(HASH(s.supplier_id, 'pay')) % 4]::STRING   AS payment_terms,
  ['FCA', 'DAP', 'DDP', 'EXW', 'CIF'][ABS(HASH(s.supplier_id, 'inc')) % 5]::STRING        AS incoterm,
  DATE '2024-10-01'                                                                      AS effective_date,
  DATEADD('year', 2 + ABS(HASH(s.supplier_id, 'exp')) % 2, DATE '2024-09-30')            AS expiry_date
FROM RAW.SUPPLIER s;

-- ---------------------------------------------------------------------------
-- 2. The documents. Free text, three wordings, nothing structured about them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE RAW.SUPPLIER_CONTRACT_DOC
  COMMENT = 'Unstructured source: one supply agreement per supplier as free text. The only structured fields are the document id and the supplier it was filed under; every commercial term lives in the prose and reaches the ontology through AI_EXTRACT.'
AS
WITH t AS (
  SELECT *,
    CASE otd_commitment WHEN 0.80 THEN 'eighty' WHEN 0.82 THEN 'eighty-two'
      WHEN 0.85 THEN 'eighty-five' WHEN 0.86 THEN 'eighty-six' ELSE 'eighty-eight' END AS otd_words,
    TO_VARCHAR(otd_commitment * 100, '99')                                     AS otd_pct_txt,
    TO_VARCHAR(penalty_cap_usd, '999,999')                                      AS cap_txt
  FROM RAW.SUPPLIER_CONTRACT_TERMS_TRUTH
)
SELECT
  'DOC-' || supplier_id                                   AS doc_id,
  supplier_id,
  contract_number || '.txt'                               AS file_name,
  CASE template_id
  WHEN 0 THEN
    'SUPPLY AGREEMENT No. ' || contract_number || '\n\n'
    || 'This Supply Agreement is entered into between Buyer and ' || supplier_name
    || ' ("Supplier"), with its principal place of business in the ' || supplier_region || ' region, effective '
    || TO_VARCHAR(effective_date, 'MMMM DD, YYYY') || ' and expiring ' || TO_VARCHAR(expiry_date, 'MMMM DD, YYYY') || '.\n\n'
    || '4. DELIVERY PERFORMANCE. 4.1 Supplier shall deliver no fewer than ' || TRIM(otd_pct_txt)
    || '% of purchase order lines on or before the confirmed delivery date. '
    || IFF(otd_basis = 'PER_LINE',
         '4.2 Performance is measured across all purchase order lines received in the quarter, each line counting equally.',
         '4.2 Performance is measured as the simple average of the monthly on-time percentages reported in the quarter.')
    || ' 4.3 Standard lead time is ' || lead_time_days || ' calendar days from order acknowledgement.\n\n'
    || '5. SERVICE CREDITS. Where Supplier fails to meet clause 4.1, Supplier shall credit Buyer '
    || penalty_pct || '% of the invoiced value of each late line, not to exceed USD ' || TRIM(cap_txt) || ' per contract year.\n\n'
    || '7. COMMERCIAL TERMS. Payment terms are ' || payment_terms || ' from receipt of a valid invoice. Goods are delivered '
    || incoterm || ' (Incoterms 2020).'
  WHEN 1 THEN
    'MASTER PURCHASE AGREEMENT - Ref ' || contract_number || '\n'
    || 'Counterparty: ' || supplier_name || ' (' || supplier_region || ')\n'
    || 'Term: commencing ' || TO_VARCHAR(effective_date, 'YYYY-MM-DD') || ', ending ' || TO_VARCHAR(expiry_date, 'YYYY-MM-DD') || '\n\n'
    || 'Schedule B - Service Levels\n'
    || 'The Vendor commits that ' || otd_words || ' per cent (' || TRIM(otd_pct_txt) || '%) of order lines will arrive by the promised date. '
    || IFF(otd_basis = 'PER_LINE',
         'Compliance is calculated line by line over every receipt in the review period.',
         'Compliance is calculated by averaging each month''s on-time rate over the review period.')
    || ' Quoted replenishment lead time: ' || lead_time_days || ' days.\n'
    || 'Schedule C - Remedies\n'
    || 'For any review period below the service level, the Vendor will issue a rebate equal to ' || penalty_pct
    || ' percent of the value of late lines. Aggregate rebates are capped at $' || TRIM(cap_txt) || ' annually.\n'
    || 'Schedule D - Commercial\n'
    || 'Settlement ' || payment_terms || '. Delivery basis ' || incoterm || '.'
  ELSE
    'Contract ' || contract_number || ' - summary of agreed terms with ' || supplier_name || '.\n'
    || 'We (the purchaser) and ' || supplier_name || ' agree the following from ' || TO_VARCHAR(effective_date, 'DD Mon YYYY')
    || ' until ' || TO_VARCHAR(expiry_date, 'DD Mon YYYY') || '. '
    || 'Lead time is ' || lead_time_days || ' days. '
    || 'The supplier must achieve on-time delivery on at least ' || TO_VARCHAR(otd_commitment, '0.00') || ' of all lines'
    || IFF(otd_basis = 'PER_LINE', ', counted per receipt line', ', counted as the mean of monthly rates')
    || '. If it does not, it owes a penalty of ' || penalty_pct || '% on the value of the late lines, with a yearly ceiling of USD '
    || TRIM(cap_txt) || '. Invoices are paid ' || payment_terms || '; shipping terms ' || incoterm || '.'
  END                                                     AS contract_text,
  -- GENERATED rows have ground truth and are scored; INGESTED rows arrive later
  -- through INGEST_SUPPLIER_CONTRACT and have none, so they are not.
  'GENERATED'                                             AS source,
  CURRENT_TIMESTAMP()                                     AS loaded_at
FROM t;

-- ---------------------------------------------------------------------------
-- 3. Extraction. AI_EXTRACT reads each document. This account rejects the
--    scores argument on text input, so certainty is judged by validation
--    instead: a term that fails to parse or is out of range is flagged
--    NEEDS_REVIEW and routed to a person rather than into a metric.
--
--    ONE DEFINITION OF EXTRACTION. The questions and the parsing live in this
--    procedure and nowhere else. The bulk load below calls it with NULL (every
--    document); INGEST_SUPPLIER_CONTRACT calls it with one supplier. A second
--    copy of the prompt would be free to drift from the first -- the same
--    failure, in the unstructured path, that the drift test catches for metrics.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE CANONICAL.DIM_SUPPLIER_CONTRACT (
  doc_id           STRING NOT NULL,
  supplier_id      STRING NOT NULL,
  file_name        STRING,
  contract_number  STRING,
  otd_commitment   NUMBER(6,4),
  otd_basis        STRING,
  penalty_pct      NUMBER(6,2),
  penalty_cap_usd  NUMBER(14,0),
  lead_time_days   NUMBER(6,0),
  payment_terms    STRING,
  incoterm         STRING,
  expiry_date      DATE,
  needs_review     BOOLEAN,
  extraction_raw   VARIANT,
  extracted_at     TIMESTAMP_LTZ,
  CONSTRAINT pk_dim_supplier_contract PRIMARY KEY (supplier_id)
) COMMENT = 'sco:SupplierContract - commercial terms extracted from RAW.SUPPLIER_CONTRACT_DOC by AI_EXTRACT (GOVERNANCE.EXTRACT_SUPPLIER_CONTRACTS). One row per supplier. NEEDS_REVIEW marks any extraction whose metric-bearing terms failed to parse or fell out of range.';

CREATE OR REPLACE PROCEDURE GOVERNANCE.EXTRACT_SUPPLIER_CONTRACTS(P_SUPPLIER_ID STRING)
  RETURNS NUMBER
  LANGUAGE SQL
  COMMENT = 'Runs AI_EXTRACT over supplier contract text and upserts CANONICAL.DIM_SUPPLIER_CONTRACT. NULL = every document; a supplier id = that supplier only. Returns rows merged.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  -- ALL = every document, ONE = the named supplier, RETRY = documents whose last
  -- extraction came back with no response. AI_EXTRACT occasionally returns
  -- {"error": "Empty extraction input"} for a perfectly valid 469-character
  -- document and succeeds on the next call; without a retry that document
  -- sits in NEEDS_REVIEW and the accuracy figure drops for a transient reason.
  mode STRING DEFAULT IFF(:P_SUPPLIER_ID IS NULL, 'ALL', 'ONE');
  merged NUMBER DEFAULT 0;
  failed NUMBER DEFAULT 0;
BEGIN
  FOR attempt IN 1 TO 3 DO
  MERGE INTO CANONICAL.DIM_SUPPLIER_CONTRACT tgt
  USING (
    WITH x AS (
      SELECT
        d.doc_id, d.supplier_id, d.file_name,
        AI_EXTRACT(
          text => d.contract_text,
          responseFormat => {
            'contract_number': 'What is the contract or agreement reference number?',
            'otd_commitment':  'What minimum percentage of order lines must be delivered on time? Answer with the number only.',
            'otd_basis':       'Is on-time performance measured per individual line, or as an average of monthly rates? Answer PER_LINE or MONTHLY_AVERAGE.',
            'penalty_pct':     'What percentage of the value of late lines is owed as a penalty, credit or rebate? Answer with the number only.',
            'penalty_cap_usd': 'What is the annual cap on penalties, credits or rebates in US dollars? Answer with the number only.',
            'lead_time_days':  'What is the lead time in days? Answer with the number only.',
            'payment_terms':   'What are the payment terms, for example Net 30?',
            'incoterm':        'What is the Incoterm or delivery basis?',
            'expiry_date':     'On what date does the agreement end? Answer in YYYY-MM-DD format.'
          }
        ) AS r
      FROM RAW.SUPPLIER_CONTRACT_DOC d
      WHERE (:mode = 'ALL')
         OR (:mode = 'ONE' AND d.supplier_id = :P_SUPPLIER_ID)
         OR (:mode = 'RETRY' AND d.supplier_id IN (
               SELECT supplier_id FROM CANONICAL.DIM_SUPPLIER_CONTRACT
                WHERE extraction_raw:response IS NULL OR IS_NULL_VALUE(extraction_raw:response)))
    ),
    p AS (
      SELECT
        doc_id, supplier_id, file_name, r,
        TRY_TO_NUMBER(REGEXP_SUBSTR(r:response:otd_commitment::STRING, '[0-9]+(\\.[0-9]+)?'), 10, 4) AS otd_raw,
        TRY_TO_NUMBER(REGEXP_SUBSTR(r:response:penalty_pct::STRING, '[0-9]+(\\.[0-9]+)?'), 6, 2)     AS penalty_pct,
        TRY_TO_NUMBER(REGEXP_REPLACE(r:response:penalty_cap_usd::STRING, '[^0-9.]', ''), 14, 0)      AS penalty_cap_usd,
        TRY_TO_NUMBER(REGEXP_SUBSTR(r:response:lead_time_days::STRING, '[0-9]+'))                    AS lead_time_days
      FROM x
    )
    SELECT
      doc_id,
      supplier_id,
      file_name,
      r:response:contract_number::STRING                                         AS contract_number,
      -- "95", "95%" and "0.95" all normalise to 0.95.
      IFF(otd_raw > 1, otd_raw / 100, otd_raw)::NUMBER(6,4)                      AS otd_commitment,
      IFF(CONTAINS(UPPER(r:response:otd_basis::STRING), 'MONTH'), 'MONTHLY_AVERAGE', 'PER_LINE') AS otd_basis,
      penalty_pct,
      penalty_cap_usd,
      lead_time_days,
      -- Canonicalised: 'Settlement Net 90.' and 'Net 90 from receipt of invoice' are one term.
      'Net ' || REGEXP_SUBSTR(r:response:payment_terms::STRING, 'Net\\s*([0-9]+)', 1, 1, 'ie', 1) AS payment_terms,
      UPPER(REGEXP_SUBSTR(r:response:incoterm::STRING, '[A-Za-z]{3}'))           AS incoterm,
      TRY_TO_DATE(r:response:expiry_date::STRING)                                AS expiry_date,
      -- A term that would feed a metric but did not parse, or parsed out of range,
      -- goes to a person rather than into the compliance view as a silent NULL.
      (otd_raw IS NULL OR penalty_pct IS NULL OR penalty_cap_usd IS NULL
       OR IFF(otd_raw > 1, otd_raw / 100, otd_raw) NOT BETWEEN 0.5 AND 1)        AS needs_review,
      r                                                                          AS extraction_raw,
      CURRENT_TIMESTAMP()                                                        AS extracted_at
    FROM p
  ) src
  ON tgt.supplier_id = src.supplier_id
  WHEN MATCHED THEN UPDATE SET
    doc_id = src.doc_id, file_name = src.file_name, contract_number = src.contract_number,
    otd_commitment = src.otd_commitment, otd_basis = src.otd_basis, penalty_pct = src.penalty_pct,
    penalty_cap_usd = src.penalty_cap_usd, lead_time_days = src.lead_time_days,
    payment_terms = src.payment_terms, incoterm = src.incoterm, expiry_date = src.expiry_date,
    needs_review = src.needs_review, extraction_raw = src.extraction_raw, extracted_at = src.extracted_at
  WHEN NOT MATCHED THEN INSERT
    (doc_id, supplier_id, file_name, contract_number, otd_commitment, otd_basis, penalty_pct,
     penalty_cap_usd, lead_time_days, payment_terms, incoterm, expiry_date, needs_review,
     extraction_raw, extracted_at)
  VALUES
    (src.doc_id, src.supplier_id, src.file_name, src.contract_number, src.otd_commitment,
     src.otd_basis, src.penalty_pct, src.penalty_cap_usd, src.lead_time_days, src.payment_terms,
     src.incoterm, src.expiry_date, src.needs_review, src.extraction_raw, src.extracted_at);
    IF (attempt = 1) THEN merged := SQLROWCOUNT; END IF;
    SELECT COUNT(*) INTO :failed FROM CANONICAL.DIM_SUPPLIER_CONTRACT
     WHERE extraction_raw:response IS NULL OR IS_NULL_VALUE(extraction_raw:response);
    IF (failed = 0) THEN BREAK; END IF;
    mode := 'RETRY';
  END FOR;
  RETURN merged;
END;
$$;

CALL GOVERNANCE.EXTRACT_SUPPLIER_CONTRACTS(NULL);

-- ---------------------------------------------------------------------------
-- 4. Extraction accuracy, measured. Field by field against the generator.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY
  COMMENT = 'AI_EXTRACT scored against generator ground truth, per field. The unstructured path is held to the same standard as the drift test: measured, not asserted.'
AS
WITH j AS (
  SELECT t.*, c.otd_commitment AS x_otd, c.otd_basis AS x_basis, c.penalty_pct AS x_pen,
         c.penalty_cap_usd AS x_cap, c.lead_time_days AS x_lt, c.payment_terms AS x_pay,
         c.incoterm AS x_inc, c.expiry_date AS x_exp, c.contract_number AS x_num
    FROM RAW.SUPPLIER_CONTRACT_TERMS_TRUTH t
    JOIN CANONICAL.DIM_SUPPLIER_CONTRACT c USING (supplier_id)
    -- Only documents the generator wrote have ground truth. An amendment that
    -- arrived through INGEST_SUPPLIER_CONTRACT would otherwise be "wrong" for
    -- differing from the contract it replaced.
    JOIN RAW.SUPPLIER_CONTRACT_DOC d ON d.supplier_id = c.supplier_id AND d.source = 'GENERATED'
)
SELECT field, COUNT(*) AS documents, COUNT_IF(ok) AS correct, ROUND(COUNT_IF(ok) / COUNT(*), 4) AS accuracy
FROM (
  SELECT 'otd_commitment'  AS field, x_otd = otd_commitment                     AS ok FROM j UNION ALL
  SELECT 'otd_basis',                x_basis = otd_basis                               FROM j UNION ALL
  SELECT 'penalty_pct',              x_pen = penalty_pct                               FROM j UNION ALL
  SELECT 'penalty_cap_usd',          x_cap = penalty_cap_usd                           FROM j UNION ALL
  SELECT 'lead_time_days',           x_lt = lead_time_days                             FROM j UNION ALL
  SELECT 'payment_terms',            UPPER(x_pay) = UPPER(payment_terms)               FROM j UNION ALL
  SELECT 'incoterm',                 x_inc = incoterm                                  FROM j UNION ALL
  SELECT 'expiry_date',              x_exp = expiry_date                               FROM j UNION ALL
  SELECT 'contract_number',          x_num = contract_number                           FROM j
)
GROUP BY field;

-- ---------------------------------------------------------------------------
-- 5. Compliance: the governed metric against the signed commitment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE
  COMMENT = 'Per supplier: governed and legacy supplier OTD (read from V_SUPPLIER_OTD_VERDICT), the contracted commitment extracted from the agreement, breach flags under each definition, and the penalty the contract entitles Buyer to claim.'
AS
-- Both OTD figures are READ from V_SUPPLIER_OTD_VERDICT (13), not re-derived.
-- That view already scores every supplier under the governed and the legacy
-- definition; computing them again here would be a second implementation of
-- the metric, free to drift from the first -- the exact failure this ontology
-- exists to prevent. Only the money is new: late-line value, from the same fact.
WITH late AS (
  SELECT supplier_id,
         COUNT_IF(is_on_time = 0)                                   AS late_lines,
         SUM(IFF(is_on_time = 0, received_qty * actual_price, 0))   AS late_line_value
    FROM CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
   GROUP BY supplier_id
)
SELECT
  s.supplier_id, s.supplier_name, s.supplier_region, s.supplier_tier,
  c.contract_number, c.otd_commitment, c.otd_basis, c.penalty_pct, c.penalty_cap_usd,
  c.lead_time_days, c.payment_terms, c.incoterm, c.expiry_date, c.needs_review,
  v.receipt_lines, l.late_lines, l.late_line_value,
  v.governed_otd,
  v.legacy_otd,
  v.governed_otd < c.otd_commitment                             AS breach_governed,
  v.legacy_otd   < c.otd_commitment                             AS breach_legacy,
  -- Penalty is only claimable on a governed breach, and never above the cap.
  IFF(v.governed_otd < c.otd_commitment,
      LEAST(c.penalty_cap_usd, l.late_line_value * c.penalty_pct / 100), 0)::NUMBER(14,2) AS penalty_exposure_usd,
  -- The money a legacy dashboard leaves on the table: breached, but shown as compliant.
  IFF(v.governed_otd < c.otd_commitment AND v.legacy_otd >= c.otd_commitment,
      LEAST(c.penalty_cap_usd, l.late_line_value * c.penalty_pct / 100), 0)::NUMBER(14,2) AS penalty_missed_by_legacy_usd,
  c.otd_basis = 'MONTHLY_AVERAGE'                               AS definition_conflict,
  CASE
    WHEN c.needs_review THEN 'NEEDS_REVIEW'
    WHEN v.governed_otd < c.otd_commitment AND v.legacy_otd >= c.otd_commitment THEN 'HIDDEN_BREACH'
    WHEN v.governed_otd < c.otd_commitment THEN 'BREACH'
    ELSE 'COMPLIANT'
  END                                                           AS compliance_status
FROM RAW.SUPPLIER s
JOIN CANONICAL.DIM_SUPPLIER_CONTRACT     c USING (supplier_id)
JOIN GOVERNANCE.V_SUPPLIER_OTD_VERDICT   v USING (supplier_id)
JOIN late                                l USING (supplier_id);

CREATE OR REPLACE VIEW GOVERNANCE.V_CONTRACT_IMPACT
  COMMENT = 'One-row headline for the contract layer: breaches, penalty exposure, the share of it a legacy dashboard would hide, definition conflicts, and extraction accuracy.'
AS
SELECT
  COUNT(*)                                                        AS contracts,
  COUNT_IF(breach_governed)                                       AS breaches_governed,
  COUNT_IF(breach_legacy)                                         AS breaches_legacy,
  COUNT_IF(compliance_status = 'HIDDEN_BREACH')                   AS hidden_breaches,
  SUM(penalty_exposure_usd)                                       AS penalty_exposure_usd,
  SUM(penalty_missed_by_legacy_usd)                               AS penalty_missed_by_legacy_usd,
  COUNT_IF(definition_conflict)                                   AS definition_conflicts,
  COUNT_IF(needs_review)                                          AS needs_review,
  (SELECT ROUND(SUM(correct) / NULLIF(SUM(documents), 0), 4)
     FROM GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY)              AS extraction_accuracy
FROM GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE;

-- ---------------------------------------------------------------------------
-- 6. Cortex Search over the clause text, for questions a number cannot answer
--    ("what does our agreement with X say about late deliveries?").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE CORTEX SEARCH SERVICE SEMANTIC.SUPPLIER_CONTRACT_SEARCH
  ON contract_text
  ATTRIBUTES supplier_name, supplier_region
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = '1 day'
  COMMENT = 'Semantic search over supplier agreement text. Grounds clause-level answers; never a source for a metric value.'
AS
SELECT d.doc_id, d.file_name, d.contract_text, s.supplier_name, s.supplier_region
  FROM RAW.SUPPLIER_CONTRACT_DOC d
  JOIN RAW.SUPPLIER s USING (supplier_id);

-- ---------------------------------------------------------------------------
-- 7. The semantic view. Contract terms become ontology, not column names.
-- ---------------------------------------------------------------------------
-- SUPPLIER is joined as the conformed dimension rather than read off the
-- compliance view's own columns, so /ontology draws SupplierContract -> Supplier
-- as an edge of the same graph instead of an island with look-alike columns.
CREATE OR REPLACE SEMANTIC VIEW SEMANTIC.SC_CONTRACT
  TABLES (
    CONTRACT as SUPPLY_CHAIN.GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE primary key (SUPPLIER_ID)
      with synonyms=('supplier contract','supply agreement','contract compliance')
      comment='sco:SupplierContract - one agreement per supplier, terms extracted by AI_EXTRACT from the contract text, scored against the governed supplier OTD. Fact, contract grain.',
    SUPPLIER as SUPPLY_CHAIN.RAW.SUPPLIER primary key (SUPPLIER_ID)
      with synonyms=('supplier','vendor') comment='sco:Supplier - the contracting party. Conformed dimension.'
  )
  RELATIONSHIPS (
    CONTRACT_TO_SUPPLIER as CONTRACT(SUPPLIER_ID) references SUPPLIER(SUPPLIER_ID)
  )
  FACTS (
    CONTRACT.COMMITMENT as contract.otd_commitment comment='Contracted minimum on-time share.',
    CONTRACT.GOVERNED as contract.governed_otd comment='Governed line-weighted supplier OTD.',
    CONTRACT.EXPOSURE as contract.penalty_exposure_usd comment='Claimable penalty, capped.',
    CONTRACT.MISSED as contract.penalty_missed_by_legacy_usd comment='Penalty hidden by the legacy definition.',
    CONTRACT.LATE_VALUE as contract.late_line_value comment='Value of late receipt lines.',
    CONTRACT.IS_BREACH as IFF(contract.breach_governed, 1, 0) comment='1 when governed OTD is below commitment.',
    CONTRACT.IS_CONFLICT as IFF(contract.definition_conflict, 1, 0) comment='1 when the contract measures OTD as a monthly average.'
  )
  DIMENSIONS (
    SUPPLIER.SUPPLIER_NAME as supplier.supplier_name with synonyms=('supplier','vendor') comment='Supplier name.',
    SUPPLIER.SUPPLIER_REGION as supplier.supplier_region with synonyms=('sourcing region','region') comment='Sourcing region.',
    SUPPLIER.SUPPLIER_TIER as supplier.supplier_tier with synonyms=('tier') comment='Supplier tier.',
    CONTRACT.CONTRACT_NUMBER as contract.contract_number comment='Agreement reference.',
    CONTRACT.OTD_BASIS as contract.otd_basis comment='How the contract measures on-time: PER_LINE (governed) or MONTHLY_AVERAGE (conflicts with the governed definition).',
    CONTRACT.COMPLIANCE_STATUS as contract.compliance_status with synonyms=('status')
      comment='COMPLIANT, BREACH, HIDDEN_BREACH (breached but shown compliant by the legacy definition) or NEEDS_REVIEW.',
    CONTRACT.INCOTERM as contract.incoterm comment='Delivery basis.',
    CONTRACT.PAYMENT_TERMS as contract.payment_terms comment='Payment terms.'
  )
  METRICS (
    CONTRACT.CONTRACT_BREACH_RATE as AVG(contract.is_breach)
      with synonyms=('breach rate','contract breach rate') comment='Share of suppliers whose governed OTD is below their contracted commitment.',
    CONTRACT.TOTAL_PENALTY_EXPOSURE as SUM(contract.exposure)
      with synonyms=('penalty exposure','service credits owed','claimable penalties') comment='Claimable contractual penalties, each capped at its annual limit.',
    CONTRACT.HIDDEN_PENALTY_EXPOSURE as SUM(contract.missed)
      with synonyms=('hidden penalties','unclaimed penalties') comment='Penalties on breaches the legacy average-of-averages definition reports as compliant.',
    CONTRACT.AVG_OTD_COMMITMENT as AVG(contract.commitment)
      with synonyms=('contracted on-time commitment') comment='Average contracted on-time commitment.',
    CONTRACT.DEFINITION_CONFLICT_COUNT as SUM(contract.is_conflict)
      with synonyms=('definition conflicts') comment='Contracts that measure OTD with the non-governed monthly-average definition.'
  )
  COMMENT = 'Supplier contract compliance. Unstructured agreements, extracted by AI_EXTRACT, joined to the governed supplier OTD.'
  AI_VERIFIED_QUERIES (
    PENALTY_EXPOSURE_BY_REGION AS (
      QUESTION 'How much contractual penalty exposure do we have by sourcing region?'
      VERIFIED_AT 1790553600 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)' ONBOARDING_QUESTION true
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_CONTRACT DIMENSIONS supplier.supplier_region METRICS contract.total_penalty_exposure, contract.contract_breach_rate) ORDER BY total_penalty_exposure DESC'
    ),
    HIDDEN_BREACHES AS (
      QUESTION 'Which suppliers breached their contract but look compliant on the legacy dashboard?'
      VERIFIED_AT 1790553600 VERIFIED_BY '(STEWARD = SC_ONTOLOGY_STEWARD)'
      SQL 'SELECT * FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.SC_CONTRACT DIMENSIONS supplier.supplier_name, contract.compliance_status METRICS contract.hidden_penalty_exposure) WHERE compliance_status = ''HIDDEN_BREACH'' ORDER BY hidden_penalty_exposure DESC'
    )
  );

-- ---------------------------------------------------------------------------
-- 8. Ingest: one new or amended agreement, end to end.
--
-- Input:      a supplier id and the agreement as free text.
-- Processing: file the document, AI_EXTRACT its terms (the same procedure the
--             bulk load uses), refresh the search index, re-score compliance
--             against the governed OTD.
-- Output:     what was extracted, and the compliance verdict before and after.
--
-- The OTD in the verdict is never touched here: it is read from
-- V_SUPPLIER_OTD_VERDICT like every other consumer, so an amendment can change
-- what a supplier promised but never what the governed metric says they did.
--
-- To restore the generated corpus after a demo: node scripts/rebuild.mjs --only 16
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE GOVERNANCE.INGEST_SUPPLIER_CONTRACT(P_SUPPLIER_ID STRING, P_CONTRACT_TEXT STRING)
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Files one supplier agreement (free text), extracts its terms with AI_EXTRACT, refreshes contract search, and returns the extracted terms with the compliance verdict before and after.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  known NUMBER;
  before_row VARIANT;
  after_row VARIANT;
BEGIN
  SELECT COUNT(*) INTO :known FROM RAW.SUPPLIER WHERE supplier_id = :P_SUPPLIER_ID;
  IF (known = 0) THEN
    RETURN OBJECT_CONSTRUCT('error', 'Unknown supplier ' || :P_SUPPLIER_ID || ' - contracts attach to a conformed SUPPLIER.');
  END IF;
  IF (P_CONTRACT_TEXT IS NULL OR LENGTH(TRIM(P_CONTRACT_TEXT)) < 40) THEN
    RETURN OBJECT_CONSTRUCT('error', 'Contract text is empty or too short to extract from.');
  END IF;

  SELECT OBJECT_CONSTRUCT('otd_commitment', otd_commitment, 'otd_basis', otd_basis,
                          'compliance_status', compliance_status, 'penalty_exposure_usd', penalty_exposure_usd)
    INTO :before_row
    FROM GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE WHERE supplier_id = :P_SUPPLIER_ID;

  MERGE INTO RAW.SUPPLIER_CONTRACT_DOC tgt
  USING (SELECT :P_SUPPLIER_ID AS supplier_id, :P_CONTRACT_TEXT AS contract_text) src
  ON tgt.supplier_id = src.supplier_id
  WHEN MATCHED THEN UPDATE SET
    contract_text = src.contract_text, source = 'INGESTED', loaded_at = CURRENT_TIMESTAMP(),
    file_name = 'AMEND-' || src.supplier_id || '-' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDDHH24MISS') || '.txt'
  WHEN NOT MATCHED THEN INSERT (doc_id, supplier_id, file_name, contract_text, source, loaded_at)
    VALUES ('DOC-' || src.supplier_id, src.supplier_id,
            'NEW-' || src.supplier_id || '-' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDDHH24MISS') || '.txt',
            src.contract_text, 'INGESTED', CURRENT_TIMESTAMP());

  CALL GOVERNANCE.EXTRACT_SUPPLIER_CONTRACTS(:P_SUPPLIER_ID);
  ALTER CORTEX SEARCH SERVICE SEMANTIC.SUPPLIER_CONTRACT_SEARCH REFRESH;

  SELECT OBJECT_CONSTRUCT(
           'supplier', c.supplier_name,
           'extracted', OBJECT_CONSTRUCT('otd_commitment', d.otd_commitment, 'otd_basis', d.otd_basis,
                                         'penalty_pct', d.penalty_pct, 'penalty_cap_usd', d.penalty_cap_usd,
                                         'lead_time_days', d.lead_time_days, 'payment_terms', d.payment_terms,
                                         'incoterm', d.incoterm, 'needs_review', d.needs_review),
           'governed_otd', c.governed_otd,
           'legacy_otd', c.legacy_otd,
           'compliance_status', c.compliance_status,
           'penalty_exposure_usd', c.penalty_exposure_usd,
           'penalty_hidden_by_legacy_usd', c.penalty_missed_by_legacy_usd,
           'definition_conflict', c.definition_conflict)
    INTO :after_row
    FROM GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE c
    JOIN CANONICAL.DIM_SUPPLIER_CONTRACT d USING (supplier_id)
   WHERE c.supplier_id = :P_SUPPLIER_ID;

  RETURN OBJECT_CONSTRUCT('before', before_row, 'after', after_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Access. Procurement owns contracts; the steward audits them. Planning and
-- logistics see the governed OTD elsewhere and have no need of commercial terms.
-- ---------------------------------------------------------------------------
GRANT USAGE ON PROCEDURE GOVERNANCE.INGEST_SUPPLIER_CONTRACT(STRING, STRING) TO ROLE SC_PROCUREMENT;
GRANT USAGE ON PROCEDURE GOVERNANCE.INGEST_SUPPLIER_CONTRACT(STRING, STRING) TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON TABLE CANONICAL.DIM_SUPPLIER_CONTRACT              TO ROLE SC_PROCUREMENT;
GRANT SELECT ON TABLE CANONICAL.DIM_SUPPLIER_CONTRACT              TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW  GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE    TO ROLE SC_PROCUREMENT;
GRANT SELECT ON VIEW  GOVERNANCE.V_SUPPLIER_CONTRACT_COMPLIANCE    TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW  GOVERNANCE.V_CONTRACT_IMPACT                 TO ROLE SC_PROCUREMENT;
GRANT SELECT ON VIEW  GOVERNANCE.V_CONTRACT_IMPACT                 TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW  GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY    TO ROLE SC_PROCUREMENT;
GRANT SELECT ON VIEW  GOVERNANCE.V_CONTRACT_EXTRACTION_ACCURACY    TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON SEMANTIC VIEW SEMANTIC.SC_CONTRACT                 TO ROLE SC_PROCUREMENT;
GRANT SELECT ON SEMANTIC VIEW SEMANTIC.SC_CONTRACT                 TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE  ON CORTEX SEARCH SERVICE SEMANTIC.SUPPLIER_CONTRACT_SEARCH TO ROLE SC_PROCUREMENT;
GRANT USAGE  ON CORTEX SEARCH SERVICE SEMANTIC.SUPPLIER_CONTRACT_SEARCH TO ROLE SC_ONTOLOGY_STEWARD;

-- PERSONA_VIEW_ACCESS mirrors the two SC_CONTRACT grants above (90_verify_base.sql
-- counts them). Delete-then-insert so a re-run of this file cannot duplicate rows:
-- the table's primary key is declared, not enforced.
DELETE FROM GOVERNANCE.PERSONA_VIEW_ACCESS WHERE semantic_view = 'SC_CONTRACT';
INSERT INTO GOVERNANCE.PERSONA_VIEW_ACCESS (role_name, semantic_view)
SELECT * FROM VALUES ('SC_ONTOLOGY_STEWARD','SC_CONTRACT'), ('SC_PROCUREMENT','SC_CONTRACT');

-- Evidence.
SELECT * FROM GOVERNANCE.V_CONTRACT_IMPACT;
