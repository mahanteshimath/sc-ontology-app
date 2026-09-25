-- ---------------------------------------------------------------------------
-- 14 — Scoring the evaluation set.
--
-- 09_agent_eval.sql defines 60 golden questions and says, in its header, that
-- scoring "belongs to a run, not to the question". That was correct and it was
-- also incomplete: nothing ran them. The project's own standard --
--
--   "A drift test that has only ever passed is indistinguishable from a drift
--    test that is not running."
--
-- -- applied to every governed metric and to nothing in the conversational
-- layer, which was the one part of the system whose accuracy was asserted rather
-- than measured. This file closes that.
--
-- WHY A RUN IS SCORED OVER HTTP RATHER THAN IN SQL
-- The thing under test is not a prompt, it is the whole governed path: resolve
-- the question against the registry, validate the model's choice against
-- INFORMATION_SCHEMA, assume the persona's role, apply the row access policy,
-- execute. Scoring the resolver alone would measure the easy half and report it
-- as the whole. scripts/eval.mjs therefore signs in as each question's persona
-- and drives /api/ask exactly as a browser does, and writes the outcome here.
--
-- THE THREE SCORING RULES, AND WHY THE MIDDLE ONE EXISTS
--
--   SHOULD_ANSWER = FALSE   pass when the layer declines. Eight questions.
--                           Refusing correctly is as much a pass as resolving
--                           correctly: an invented metric looks exactly like a
--                           real one, while a refusal is visibly a refusal.
--
--   EXPECTED_METRIC_IDS     pass when the layer does NOT silently commit to one
--     IS NULL               of the competing metrics -- it either asks, or
--                           answers with more than one and says so. Three
--                           questions. "What is our on-time delivery?" with no
--                           side named is the canonical case: inbound supplier
--                           OTD and outbound customer OTD are different metrics
--                           over different facts, and picking one quietly is the
--                           exact conflation this ontology exists to prevent.
--                           A confident single answer is therefore scored as a
--                           FAILURE even though the number it returns is real.
--
--   otherwise               pass when the resolved metric ids equal
--                           EXPECTED_METRIC_IDS, order-insensitive.
--
-- WHAT IS DELIBERATELY NOT SCORED. EXPECTED_TOOL names the semantic view the
-- Cortex Agent should route to. /api/ask always resolves against SC_ONTOLOGY_360
-- by design -- it is the cross-domain view, and routing is the agent's job, not
-- the application's -- so scoring the app against EXPECTED_TOOL would fail all
-- 60 for a difference that is architectural rather than wrong. The view actually
-- used is recorded so the omission is visible instead of silent.
--
-- ---------------------------------------------------------------------------
-- ONE QUESTION IS SCORED MORE STRICTLY THAN ITS OWN TEXT REQUIRES, ON PURPOSE
--
-- Q57's EXPECTED_BEHAVIOUR reads: "Must report a balance at one snapshot, OR
-- EXPLAIN WHY A SUM IS MEANINGLESS HERE." The layer takes the second path -- it
-- declines and explains that summing twelve month-end balances counts the same
-- stock twelve times -- which is a pass by the question's own wording and a
-- FAILURE by the three rules above, because the rules are set-equality on metric
-- ids and cannot express "either of two good outcomes".
--
-- The point is left on the table rather than special-cased. A scorer that starts
-- carrying exceptions for questions it knows it fails has stopped being a scorer,
-- and the exception would be indistinguishable from the same edit made to make a
-- number look better. One understated result is much cheaper than a scoring rule
-- nobody can trust.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE TABLE IF NOT EXISTS AGENT_EVAL_RUN (
  run_id           STRING NOT NULL COMMENT 'One id per scored run.',
  run_at           TIMESTAMP_LTZ NOT NULL,
  target_base      STRING COMMENT 'Deployment the run was scored against.',
  resolver_model   STRING COMMENT 'Model the conversational layer resolved with.',
  questions        NUMBER NOT NULL,
  passed           NUMBER NOT NULL,
  failed           NUMBER NOT NULL,
  errored          NUMBER NOT NULL COMMENT 'Questions the run could not score at all: transport failure, timeout, non-JSON response.',
  accuracy         FLOAT  NOT NULL COMMENT 'passed / questions.',
  refusals_expected NUMBER COMMENT 'Questions that must be declined.',
  refusals_correct  NUMBER COMMENT 'Of those, how many were.',
  ambiguity_correct NUMBER COMMENT 'Ambiguous questions that asked rather than guessed.',
  traps_correct     NUMBER COMMENT 'Trap questions resolved to the right metric.',
  mean_latency_ms   NUMBER,
  p95_latency_ms    NUMBER,
  CONSTRAINT pk_agent_eval_run PRIMARY KEY (run_id)
)
COMMENT = 'One row per scored run of the 60-question evaluation set. A run, not a verdict on the questions: baking a result into the question set is how an evaluation set quietly becomes a record of one good day.';

CREATE TABLE IF NOT EXISTS AGENT_EVAL_RESULT (
  run_id              STRING NOT NULL,
  question_id         STRING NOT NULL,
  category            STRING,
  persona_role        STRING,
  should_answer       BOOLEAN,
  expected_metric_ids STRING,
  resolved_metric_ids STRING,
  semantic_view_used  STRING COMMENT 'Always SC_ONTOLOGY_360 on the application path. Recorded so that is visible rather than assumed.',
  answerable          BOOLEAN COMMENT 'What the layer decided.',
  reason              STRING COMMENT 'The refusal reason, or the resolution rationale.',
  passed              BOOLEAN NOT NULL,
  failure_mode        STRING COMMENT 'Why it failed. NULL on a pass.',
  latency_ms          NUMBER,
  CONSTRAINT pk_agent_eval_result PRIMARY KEY (run_id, question_id)
)
COMMENT = 'Per-question outcome of one evaluation run. FAILURE_MODE is the field to read: an accuracy figure without the failures behind it is a scoreboard, not a diagnostic.';

-- The latest run, for the application. A view rather than a MAX() in the app so
-- the page cannot disagree with the table about which run is current.
CREATE OR REPLACE VIEW V_AGENT_EVAL_LATEST
  COMMENT = 'Most recent scored run of the evaluation set.'
AS
SELECT *
  FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_RUN
QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1;

CREATE OR REPLACE VIEW V_AGENT_EVAL_BY_CATEGORY
  COMMENT = 'Latest run broken down by question category, worst first. Where the conversational layer is weak, not merely how often it is right.'
AS
SELECT
  r.category,
  COUNT(*)                                            AS questions,
  COUNT_IF(r.passed)                                  AS passed,
  COUNT(*) - COUNT_IF(r.passed)                       AS failed,
  ROUND(COUNT_IF(r.passed) / NULLIF(COUNT(*), 0), 4)  AS accuracy,
  ROUND(AVG(r.latency_ms))                            AS mean_latency_ms
FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_RESULT r
JOIN SUPPLY_CHAIN.GOVERNANCE.V_AGENT_EVAL_LATEST l ON l.run_id = r.run_id
GROUP BY r.category;

-- The failures of the latest run, which is the half of the result worth reading.
CREATE OR REPLACE VIEW V_AGENT_EVAL_FAILURE
  COMMENT = 'Questions the latest run got wrong, with what was expected and what came back.'
AS
SELECT
  r.question_id, r.category, r.persona_role, q.question,
  r.expected_metric_ids, r.resolved_metric_ids, r.failure_mode, r.reason, r.latency_ms
FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_RESULT r
JOIN SUPPLY_CHAIN.GOVERNANCE.V_AGENT_EVAL_LATEST l ON l.run_id = r.run_id
LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_QUESTION q ON q.question_id = r.question_id
WHERE NOT r.passed;
