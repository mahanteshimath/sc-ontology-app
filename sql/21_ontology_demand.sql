-- ---------------------------------------------------------------------------
-- 21 - Demand-driven ontology: what teams asked for, and could not have.
--
-- Every question the conversational layer declines is logged in
-- AGENT_QUESTION_LOG with its refusal reason. Read one at a time, a refusal is a
-- dead end. Read together they are the ontology's roadmap: the questions people
-- actually ask, ranked, with the metric that would answer each one.
--
-- NOT EVERY REFUSAL IS A GAP. Four kinds, and only two are work items:
--   ACCESS_DENIED        the metric exists, the persona is not granted it.
--                        Correct behaviour - the grant model working.
--   GUARDRAIL            the question is unsafe as asked (a balance summed over
--                        time, future-dated activity, an ambiguous "on-time").
--                        Correct behaviour - the ontology's rules working.
--   UNREGISTERED_METRIC  the measure already exists in a semantic view but is
--                        not in the governed registry, so it has no drift test,
--                        no target and cannot be answered. Cheap to close:
--                        one registry row and its bindings.
--   OUT_OF_SCOPE         the data is not in the ontology (margin, carbon, HR).
--                        A sourcing decision, not a modelling one.
--
-- AI_CLASSIFY does the reading; nothing here is a hand-labelled demo list. The
-- candidate list for UNREGISTERED_METRIC is built from INFORMATION_SCHEMA every
-- run - measures declared in a semantic view with no METRIC_BINDING - so the
-- moment one is promoted into the registry it stops being proposed.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;
USE WAREHOUSE COMPUTE_WH;

-- Measures that exist in a semantic view but are not governed metrics.
CREATE OR REPLACE VIEW V_UNREGISTERED_MEASURE
  COMMENT = 'Metrics declared in a semantic view with no METRIC_BINDING: answerable in principle, ungoverned in practice (no drift test, no target, not offered to the conversational layer).'
AS
SELECT
  LOWER(m.table_name) || '.' || LOWER(m.name) AS metric_reference,
  ARRAY_AGG(DISTINCT m.semantic_view_name) WITHIN GROUP (ORDER BY m.semantic_view_name) AS semantic_views,
  ANY_VALUE(m.comment) AS description
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_METRICS m
WHERE m.semantic_view_name NOT IN ('SC_SUPPLIER_LEGACY_DEFECT', 'SC_OUTLOOK')   -- negative control; predictions have their own registry
  AND NOT EXISTS (
    SELECT 1 FROM METRIC_BINDING b
     WHERE LOWER(b.metric_reference) = LOWER(m.table_name) || '.' || LOWER(m.name))
GROUP BY 1;

CREATE TABLE IF NOT EXISTS QUESTION_DEMAND (
  question_key      STRING NOT NULL COMMENT 'Normalised question text.',
  sample_question   STRING NOT NULL,
  refusal_reason    STRING,
  times_asked       NUMBER NOT NULL,
  personas          ARRAY,
  refusal_class     STRING,
  candidate_metric  STRING COMMENT 'metric_reference from V_UNREGISTERED_MEASURE, or NULL.',
  classified_at     TIMESTAMP_LTZ NOT NULL
) COMMENT = 'Refused conversational questions, deduplicated and classified by AI_CLASSIFY into why they were refused and which unregistered measure would answer them.';

CREATE OR REPLACE PROCEDURE CLASSIFY_QUESTION_DEMAND()
  RETURNS VARIANT
  LANGUAGE SQL
  COMMENT = 'Re-classifies every distinct refused question in AGENT_QUESTION_LOG. Candidate metrics are read from V_UNREGISTERED_MEASURE at run time.'
  EXECUTE AS OWNER
AS
$$
DECLARE
  candidates STRING;
  n NUMBER;
BEGIN
  -- AI_CLASSIFY wants its category list as a constant, so the current set of
  -- unregistered measures is rendered into the statement. Every reference is
  -- validated as entity.metric before it is inlined.
  SELECT '[' || LISTAGG('{''label'': ''' || metric_reference || ''', ''description'': '''
               || REPLACE(LEFT(REGEXP_REPLACE(COALESCE(description, ''), '[^A-Za-z0-9 ,.()-]', ''), 140), '''', '') || '''}', ', ')
         || ', {''label'': ''none'', ''description'': ''No listed measure answers this question.''}]'
    INTO :candidates
    FROM V_UNREGISTERED_MEASURE
   WHERE REGEXP_LIKE(metric_reference, '^[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*$');

  CREATE OR REPLACE TEMPORARY TABLE _refused AS
  SELECT LOWER(TRIM(REGEXP_REPLACE(question, '[[:space:]]+', ' '))) AS question_key,
         ANY_VALUE(question)                                        AS sample_question,
         ANY_VALUE(refusal_reason)                                  AS refusal_reason,
         COUNT(*)                                                   AS times_asked,
         ARRAY_AGG(DISTINCT persona_role)                           AS personas
    FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_QUESTION_LOG
   WHERE refused
   GROUP BY 1;

  CREATE OR REPLACE TEMPORARY TABLE _classified AS
  SELECT r.*,
         AI_CLASSIFY(
           'Question: ' || r.sample_question || ' | Refusal reason: ' || COALESCE(r.refusal_reason, ''),
           [
             {'label': 'ACCESS_DENIED', 'description': 'The metric exists but the asking persona is not granted the view that serves it.'},
             {'label': 'GUARDRAIL', 'description': 'Refused on purpose: ambiguous side, snapshot summed over time, future-dated activity, forecast beyond data, raw table access.'},
             {'label': 'UNREGISTERED_METRIC', 'description': 'Asks for an operational measure such as scrap, schedule adherence, forecast accuracy, stockouts or transit delay that the catalogue lacks.'},
             {'label': 'OUT_OF_SCOPE', 'description': 'Needs data the supply chain ontology does not hold: revenue, margin, emissions, headcount, customer satisfaction.'}
           ],
           {'task_description': 'Classify why a governed supply chain analytics assistant refused this question.'}
         ):labels[0]::STRING AS refusal_class
    FROM _refused r;

  -- The only dynamic step: the candidate list changes as measures are promoted.
  EXECUTE IMMEDIATE '
    CREATE OR REPLACE TEMPORARY TABLE _candidates AS
    SELECT c.question_key,
           AI_CLASSIFY(c.sample_question, ' || candidates || ',
             {''task_description'': ''Which supply chain measure would answer this question? Choose none if no listed measure fits.''}
           ):labels[0]::STRING AS candidate_metric
      FROM _classified c
     WHERE c.refusal_class = ''UNREGISTERED_METRIC''';

  DELETE FROM QUESTION_DEMAND;
  INSERT INTO QUESTION_DEMAND
  SELECT c.question_key, c.sample_question, c.refusal_reason, c.times_asked, c.personas, c.refusal_class,
         NULLIF(k.candidate_metric, 'none'), CURRENT_TIMESTAMP()
    FROM _classified c
    LEFT JOIN _candidates k USING (question_key);
  n := SQLROWCOUNT;
  RETURN OBJECT_CONSTRUCT('questions_classified', n);
END;
$$;

CALL CLASSIFY_QUESTION_DEMAND();

-- Refresh weekly: demand moves slowly, and classification is the only cost here.
CREATE OR REPLACE TASK CLASSIFY_QUESTION_DEMAND_WEEKLY
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 0 7 * * 1 UTC'
  COMMENT = 'Monday 07:00 UTC: re-read the refused-question log into QUESTION_DEMAND.'
AS
  CALL SUPPLY_CHAIN.GOVERNANCE.CLASSIFY_QUESTION_DEMAND();
ALTER TASK CLASSIFY_QUESTION_DEMAND_WEEKLY RESUME;

-- The roadmap: each unregistered measure ranked by the demand it would satisfy.
CREATE OR REPLACE VIEW V_ONTOLOGY_DEMAND
  COMMENT = 'Unregistered measures ranked by how many refused questions they would answer, and for which personas. The next metrics to promote into the registry.'
AS
SELECT
  u.metric_reference,
  u.semantic_views,
  u.description,
  COUNT(q.question_key)                          AS refused_questions,
  COALESCE(SUM(q.times_asked), 0)                AS times_asked,
  ARRAY_UNION_AGG(q.personas)                    AS personas,
  ARRAY_AGG(q.sample_question) WITHIN GROUP (ORDER BY q.times_asked DESC) AS sample_questions
FROM V_UNREGISTERED_MEASURE u
LEFT JOIN QUESTION_DEMAND q ON q.candidate_metric = u.metric_reference
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW V_REFUSAL_MIX
  COMMENT = 'Why questions were refused. ACCESS_DENIED and GUARDRAIL are the governance working; UNREGISTERED_METRIC and OUT_OF_SCOPE are the roadmap.'
AS
SELECT refusal_class,
       COUNT(*)          AS distinct_questions,
       SUM(times_asked)  AS times_asked,
       refusal_class IN ('ACCESS_DENIED', 'GUARDRAIL') AS governance_working
  FROM QUESTION_DEMAND
 GROUP BY refusal_class;

GRANT SELECT ON VIEW V_ONTOLOGY_DEMAND TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON VIEW V_REFUSAL_MIX     TO ROLE SC_ONTOLOGY_STEWARD;
GRANT SELECT ON TABLE QUESTION_DEMAND  TO ROLE SC_ONTOLOGY_STEWARD;

SELECT * FROM V_REFUSAL_MIX ORDER BY times_asked DESC;
SELECT metric_reference, refused_questions, times_asked FROM V_ONTOLOGY_DEMAND WHERE refused_questions > 0 ORDER BY times_asked DESC;
