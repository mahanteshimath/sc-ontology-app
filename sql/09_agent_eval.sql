-- ---------------------------------------------------------------------------
-- 09 — Agent evaluation set. 60 golden questions.
--
-- WHY THIS IS NOT ALL HAPPY-PATH. A conversational layer over governed metrics
-- has two failure modes, and only one of them is "gave the wrong number". The
-- other is "answered a question it had no business answering", which is worse,
-- because a refusal is visibly a refusal while an invented metric looks exactly
-- like a real one. So:
--
--   * 8 questions MUST be refused. Refusing correctly is as much a pass as
--     resolving correctly, which is why SHOULD_ANSWER is a column rather than an
--     assumption.
--   * 3 are genuinely ambiguous and must trigger a clarifying question rather
--     than a confident guess. The commonest is "on-time delivery" with no side
--     named: inbound supplier OTD and outbound customer OTD are different
--     metrics over different facts, and picking one silently is the exact
--     conflation this ontology exists to prevent.
--   * 4 are traps aimed at the failure modes this project was built around:
--     summing a snapshot across months, averaging monthly rates, conflating
--     inbound with outbound, and treating a prediction as a measurement.
--
-- HOW TO SCORE IT. A question passes when:
--   SHOULD_ANSWER = TRUE  -> the resolved metric ids equal EXPECTED_METRIC_IDS
--                            (order-insensitive) and the tool used is the one in
--                            EXPECTED_TOOL.
--   SHOULD_ANSWER = FALSE -> the layer declines, and the refusal names a governed
--                            alternative instead of trailing off.
-- EXPECTED_BEHAVIOUR carries the human-readable pass condition for the cases
-- where "the right ids" is not the whole story.
--
-- Deliberately NOT stored as a pass/fail column. Scoring belongs to a run, not to
-- the question, and baking a result into the question set is how an evaluation set
-- quietly becomes a record of one good day.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE TABLE IF NOT EXISTS AGENT_EVAL_QUESTION (
  question_id         STRING NOT NULL,
  category            STRING NOT NULL,
  persona_role        STRING,
  question            STRING NOT NULL,
  should_answer       BOOLEAN NOT NULL,
  expected_metric_ids STRING,
  expected_tool       STRING,
  expected_behaviour  STRING,
  added_on            DATE DEFAULT CURRENT_DATE(),
  CONSTRAINT pk_agent_eval_question PRIMARY KEY (question_id)
)
COMMENT = 'Golden question set for measuring conversational accuracy. A question with should_answer = FALSE must be refused, not answered.';

TRUNCATE TABLE AGENT_EVAL_QUESTION;

INSERT INTO AGENT_EVAL_QUESTION
  (question_id, category, persona_role, question, should_answer, expected_metric_ids, expected_tool, expected_behaviour)
SELECT * FROM VALUES
 -- ---------------- INBOUND_SERVICE (5) ----------------
 ('Q01','INBOUND_SERVICE','SC_PROCUREMENT','What is our supplier on-time delivery?',TRUE,'supplier_otd_pct','SC_SUPPLIER','Single overall figure, no dimension.'),
 ('Q02','INBOUND_SERVICE','SC_PROCUREMENT','Which sourcing regions are late most often?',TRUE,'supplier_otd_pct','SC_SUPPLIER','Broken down by supplier_region, ascending.'),
 ('Q03','INBOUND_SERVICE','SC_PROCUREMENT','Are our tier-1 suppliers more reliable than tier-3?',TRUE,'supplier_otd_pct','SC_SUPPLIER','Broken down by supplier_tier.'),
 ('Q04','INBOUND_SERVICE','SC_PROCUREMENT','Do suppliers ship us complete orders?',TRUE,'supplier_fill_rate','SC_SUPPLIER','Resolves to fill rate, not OTD.'),
 ('Q05','INBOUND_SERVICE','SC_PROCUREMENT','Which product families do suppliers short-ship most?',TRUE,'supplier_fill_rate','SC_SUPPLIER','Broken down by product_family.'),

 -- ---------------- OUTBOUND_SERVICE (5) ----------------
 ('Q06','OUTBOUND_SERVICE','SC_LOGISTICS','What is our on-time delivery to customers?',TRUE,'otd_pct','SC_FULFILLMENT','Outbound metric, single figure.'),
 ('Q07','OUTBOUND_SERVICE','SC_LOGISTICS','Which product families are we delivering late?',TRUE,'otd_pct','SC_FULFILLMENT','Broken down by product_family.'),
 ('Q08','OUTBOUND_SERVICE','SC_LOGISTICS','Which carrier is hurting our delivery performance?',TRUE,'otd_pct','SC_FULFILLMENT','Broken down by carrier.'),
 ('Q09','OUTBOUND_SERVICE','SC_LOGISTICS','What is our on time in full rate?',TRUE,'otif_pct','SC_FULFILLMENT','OTIF, not OTD.'),
 ('Q10','OUTBOUND_SERVICE','SC_LOGISTICS_EU','How are we doing on OTIF in Europe?',TRUE,'otif_pct','SC_FULFILLMENT','Must execute as SC_LOGISTICS_EU so the row scope, not a WHERE clause, restricts it to EU.'),

 -- ---------------- FILL_RATE (4) ----------------
 ('Q11','FILL_RATE','SC_LOGISTICS','What is our customer fill rate?',TRUE,'fill_rate_pct','SC_FULFILLMENT','Single figure.'),
 ('Q12','FILL_RATE','SC_LOGISTICS','Which destination regions have the worst fill rate?',TRUE,'fill_rate_pct','SC_FULFILLMENT','Broken down by ship_region.'),
 ('Q13','FILL_RATE','SC_PLANNER','Are we shipping short because of stock or allocation?',TRUE,'fill_rate_pct','SC_FULFILLMENT','Broken down by defect_reason; the reason lives on the fact, not in a separate metric.'),
 ('Q14','FILL_RATE','SC_LOGISTICS','Show me fill rate and on-time delivery together.',TRUE,'fill_rate_pct|otd_pct','SC_FULFILLMENT','Two metrics in one answer.'),

 -- ---------------- PERFECT_ORDER (3) ----------------
 ('Q15','PERFECT_ORDER','SC_LOGISTICS','What is our perfect order rate?',TRUE,'perfect_order_pct','SC_FULFILLMENT','Single figure.'),
 ('Q16','PERFECT_ORDER','SC_LOGISTICS','Why is our perfect order rate below OTIF?',TRUE,'perfect_order_pct|otif_pct','SC_FULFILLMENT','Must explain that perfect order adds the date-accepted condition, so it can only be lower.'),
 ('Q17','PERFECT_ORDER','SC_LOGISTICS','Which families never achieve a perfect order?',TRUE,'perfect_order_pct','SC_FULFILLMENT','Broken down by product_family.'),

 -- ---------------- LANDED_COST (5) ----------------
 ('Q18','LANDED_COST','SC_LOGISTICS','What is our landed cost per unit?',TRUE,'landed_cost_per_unit','SC_LANDED_COST','Ratio of sums, single figure.'),
 ('Q19','LANDED_COST','SC_LOGISTICS','Which carriers cost the most per unit shipped?',TRUE,'landed_cost_per_unit','SC_LANDED_COST','Broken down by carrier.'),
 ('Q20','LANDED_COST','SC_LOGISTICS','How much more does expedited freight cost us?',TRUE,'landed_cost_per_unit','SC_LANDED_COST','Broken down by service_level.'),
 ('Q21','LANDED_COST','SC_LOGISTICS','What is our total landed cost?',TRUE,'landed_cost_usd','SC_LANDED_COST','Absolute dollars; must not be reported against a target, because it has none by design.'),
 ('Q22','LANDED_COST','SC_LOGISTICS','What does it cost to serve each region?',TRUE,'landed_cost_usd|landed_cost_per_unit','SC_LANDED_COST','Broken down by ship_region.'),

 -- ---------------- FREIGHT_AUDIT (4) ----------------
 ('Q23','FREIGHT_AUDIT','SC_LOGISTICS','Are carriers billing us more than we accrued?',TRUE,'freight_bill_variance_usd','SC_LANDED_COST','A to-zero metric; positive means overbilling.'),
 ('Q24','FREIGHT_AUDIT','SC_LOGISTICS','Which carrier overbills us the most?',TRUE,'freight_bill_variance_usd','SC_LANDED_COST','Broken down by carrier, descending.'),
 ('Q25','FREIGHT_AUDIT','SC_LOGISTICS','What did we accrue for freight this period?',TRUE,'freight_cost_usd','SC_LANDED_COST','Accrued, not invoiced.'),
 ('Q26','FREIGHT_AUDIT','SC_LOGISTICS','What did carriers actually invoice us?',TRUE,'freight_invoiced_usd','SC_LANDED_COST','Invoiced, not accrued. Distinguishing these two is the point.'),

 -- ---------------- INVENTORY (6) ----------------
 ('Q27','INVENTORY','SC_PLANNER','How many days of inventory are we holding?',TRUE,'days_of_inventory','SC_INVENTORY','Must be read at a single snapshot, never averaged across months.'),
 ('Q28','INVENTORY','SC_PLANNER','Which product families are overstocked?',TRUE,'days_of_inventory','SC_INVENTORY','Per snapshot, broken down by product_family.'),
 ('Q29','INVENTORY','SC_PLANNER','How does inventory cover differ by ABC class?',TRUE,'days_of_inventory','SC_INVENTORY','Per snapshot, broken down by abc_class.'),
 ('Q30','INVENTORY','SC_PLANNER','What is our inventory value?',TRUE,'inventory_value_usd','SC_INVENTORY','Single snapshot.'),
 ('Q31','INVENTORY','SC_PLANNER','Which locations hold the most stock value?',TRUE,'inventory_value_usd','SC_INVENTORY','Per snapshot, broken down by node_name.'),
 ('Q32','INVENTORY','SC_PLANNER','Show days of cover and stock value together.',TRUE,'days_of_inventory|inventory_value_usd','SC_INVENTORY','Both snapshot-scoped metrics at the same snapshot date.'),

 -- ---------------- PURCHASE_PRICE (4) ----------------
 ('Q33','PURCHASE_PRICE','SC_PROCUREMENT','What is our purchase price variance?',TRUE,'ppv','SC_SUPPLIER','Absolute dollars, unfavourable when positive.'),
 ('Q34','PURCHASE_PRICE','SC_PROCUREMENT','Which product families are we overpaying for?',TRUE,'ppv','SC_SUPPLIER','Broken down by product_family.'),
 ('Q35','PURCHASE_PRICE','SC_PROCUREMENT','Which supplier tier drives most of our price variance?',TRUE,'ppv','SC_SUPPLIER','Broken down by supplier_tier.'),
 ('Q36','PURCHASE_PRICE','SC_PROCUREMENT','Is our price variance getting worse or better?',TRUE,'ppv','SC_SUPPLIER','Time breakdown; must not be compared to a target, since PPV has none by design.'),

 -- ---------------- DEMAND_PLAN (3) ----------------
 ('Q37','DEMAND_PLAN','SC_PLANNER','How accurate is our demand forecast?',TRUE,NULL,'SC_DEMAND','Forecast accuracy is a semantic-view metric, not a registered governed metric; the answer must not claim registry governance for it.'),
 ('Q38','DEMAND_PLAN','SC_PLANNER','Which product families are hardest to forecast?',TRUE,NULL,'SC_DEMAND','Broken down by product_family.'),
 ('Q39','DEMAND_PLAN','SC_PLANNER','Did we plan enough volume for last month?',TRUE,NULL,'SC_DEMAND','Forecast versus actual for closed periods only; an open period has a zero actual.'),

 -- ---------------- MANUFACTURING (2) ----------------
 ('Q40','MANUFACTURING',NULL,'Which plants have the highest scrap rate?',TRUE,NULL,'SC_MANUFACTURING','Broken down by node_name.'),
 ('Q41','MANUFACTURING',NULL,'Are we completing production orders on schedule?',TRUE,NULL,'SC_MANUFACTURING','Schedule adherence, single figure.'),

 -- ---------------- CROSS_DOMAIN (2) ----------------
 ('Q42','CROSS_DOMAIN','SC_ONTOLOGY_STEWARD','How does supplier on-time delivery compare with the on-time delivery we give customers?',TRUE,'supplier_otd_pct|otd_pct','SC_ONTOLOGY_360','Both sides in one answer, and must state that one is inbound and one outbound.'),
 ('Q43','CROSS_DOMAIN','SC_ONTOLOGY_STEWARD','Show fill rate, days of inventory and landed cost per unit by product family.',TRUE,'fill_rate_pct|days_of_inventory|landed_cost_per_unit','SC_ONTOLOGY_360','Three metrics across three facts on the shared PART dimension. The snapshot metric must be pinned to one snapshot while the others span the period.'),

 -- ---------------- PREDICTION (2) ----------------
 ('Q44','PREDICTION','SC_ONTOLOGY_STEWARD','Which product families will miss their on-time delivery target next month?',TRUE,'otd_pct','SC_OUTLOOK','Must come from the prediction registry, be labelled a prediction, and be quoted with its backtested accuracy.'),
 ('Q45','PREDICTION','SC_PLANNER','What order-line volume should we plan for over the next few months?',TRUE,NULL,'SC_OUTLOOK','Volume forecast. Must not be presented as a governed metric: order_line_volume is deliberately not in the registry.'),

 -- ---------------- REFUSAL (8, should_answer = FALSE) ----------------
 ('Q46','REFUSAL',NULL,'What is our average customer satisfaction score?',FALSE,NULL,NULL,'No satisfaction metric exists. Must refuse and name the closest governed service metrics.'),
 ('Q47','REFUSAL',NULL,'What is our carbon footprint per shipment?',FALSE,NULL,NULL,'No emissions metric exists. Must refuse rather than derive one from freight cost.'),
 ('Q48','REFUSAL',NULL,'How many employees work in the Neuss distribution centre?',FALSE,NULL,NULL,'No HR data in the ontology. NODE has no headcount attribute.'),
 ('Q49','REFUSAL',NULL,'What is our gross margin by product family?',FALSE,NULL,NULL,'No revenue or margin metric exists; landed cost is cost only. Must not infer margin.'),
 ('Q50','REFUSAL',NULL,'Which supplier should we terminate?',FALSE,NULL,NULL,'A recommendation, not a metric. May surface worst-performing suppliers but must not issue the recommendation as an answer.'),
 ('Q51','REFUSAL',NULL,'What will our on-time delivery be in 2030?',FALSE,NULL,NULL,'Beyond any supported horizon. The prediction layer covers the next month, not five years.'),
 ('Q52','REFUSAL',NULL,'Show me the raw purchase order table.',FALSE,NULL,NULL,'No persona is granted RAW. Must refuse and point at the governed drill-down instead.'),
 ('Q53','REFUSAL','SC_PROCUREMENT','What is our freight bill variance?',FALSE,'freight_bill_variance_usd',NULL,'The metric exists but SC_PROCUREMENT is not granted SC_LANDED_COST. Must refuse on access, not pretend the metric is unknown.'),

 -- ---------------- AMBIGUITY (3) ----------------
 ('Q54','AMBIGUITY',NULL,'What is our on-time delivery?',TRUE,NULL,NULL,'Ambiguous between inbound supplier OTD and outbound customer OTD. Must ask which, not silently pick one.'),
 ('Q55','AMBIGUITY',NULL,'What are our freight costs?',TRUE,NULL,NULL,'Ambiguous between accrued freight_cost_usd and invoiced freight_invoiced_usd. Must ask which.'),
 ('Q56','AMBIGUITY',NULL,'How is our inventory doing?',TRUE,NULL,NULL,'Ambiguous between days of cover, stock value and stockout rate. Must ask, or answer all three and say so.'),

 -- ---------------- TRAP (4) ----------------
 ('Q57','TRAP','SC_PLANNER','What was our total inventory value over the last twelve months?',TRUE,'inventory_value_usd','SC_INVENTORY','THE SNAPSHOT TRAP. Summing twelve month-end balances counts the same stock twelve times. Must report a balance at one snapshot, or explain why a sum is meaningless here.'),
 ('Q58','TRAP','SC_PROCUREMENT','What is the average of our monthly supplier on-time delivery rates?',TRUE,'supplier_otd_pct','SC_SUPPLIER','THE AVERAGE-OF-AVERAGES TRAP. Must compute the line-weighted rate, and should note that averaging monthly rates gives a different, unweighted answer -- the defect SC_SUPPLIER_LEGACY_DEFECT preserves.'),
 ('Q59','TRAP',NULL,'Our suppliers deliver late, so why is our customer OTD high?',TRUE,'supplier_otd_pct|otd_pct','SC_ONTOLOGY_360','THE INBOUND/OUTBOUND TRAP. Must treat them as two distinct metrics over two distinct facts rather than reconciling them as one number.'),
 ('Q60','TRAP','SC_ONTOLOGY_STEWARD','What was our on-time delivery last month, including orders due next week?',TRUE,'otd_pct','SC_FULFILLMENT','THE AS-OF TRAP. Future-dated rows are promised activity, not performance. Must exclude them and say that it did.')
AS v(question_id, category, persona_role, question, should_answer, expected_metric_ids, expected_tool, expected_behaviour);

-- ---------------------------------------------------------------------------
-- Integrity: no expected metric id may be absent from the registry.
--
-- A typo here is silent and corrosive: the question can never pass, and the
-- evaluation looks like a model failure rather than a fixture bug.
-- ---------------------------------------------------------------------------

SELECT
  'eval questions referencing an unknown metric id' AS check_name,
  COUNT(*)                                          AS found,
  0                                                 AS expected,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM AGENT_EVAL_QUESTION q,
     LATERAL SPLIT_TO_TABLE(COALESCE(q.expected_metric_ids, ''), '|') v
WHERE TRIM(v.value) <> ''
  AND TRIM(v.value) NOT IN (SELECT metric_id FROM METRIC_DEFINITION);

SELECT
  'eval set shape' AS check_name,
  COUNT(*)                                     AS questions,
  COUNT(DISTINCT category)                     AS categories,
  COUNT_IF(NOT should_answer)                  AS must_refuse,
  COUNT_IF(category = 'AMBIGUITY')             AS ambiguous,
  COUNT_IF(category = 'TRAP')                  AS traps,
  IFF(COUNT(*) = 60 AND COUNT(DISTINCT category) = 15
      AND COUNT_IF(NOT should_answer) = 8
      AND COUNT_IF(category = 'AMBIGUITY') = 3
      AND COUNT_IF(category = 'TRAP') = 4, 'PASS', 'FAIL') AS verdict
FROM AGENT_EVAL_QUESTION;

-- Every governed metric must be exercised by at least one question, or the set
-- has a blind spot exactly where the registry says something matters.
SELECT
  'governed metrics not covered by any question' AS check_name,
  COUNT(*)                                      AS found,
  0                                             AS expected,
  LISTAGG(metric_id, ', ')                      AS uncovered,
  IFF(COUNT(*) = 0, 'PASS', 'FAIL') AS verdict
FROM METRIC_DEFINITION d
WHERE NOT EXISTS (
  SELECT 1
    FROM AGENT_EVAL_QUESTION q,
         LATERAL SPLIT_TO_TABLE(COALESCE(q.expected_metric_ids, ''), '|') v
   WHERE TRIM(v.value) = d.metric_id
);

GRANT SELECT ON TABLE AGENT_EVAL_QUESTION TO ROLE SC_ONTOLOGY_STEWARD;
