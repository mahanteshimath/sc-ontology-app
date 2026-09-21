-- ---------------------------------------------------------------------------
-- 10 — The Cortex Agent.
--
-- lib/constants.ts expects SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT, so
-- that is where it is created. Previously this object existed only in a previous
-- account, built by hand, and vanished with it; the /ask page referenced a name
-- that resolved to nothing.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS AGENT IS FOR, AND WHAT IT IS NOT
--
-- It is the exploratory surface: free-form questions, Cortex Analyst writing SQL
-- against the semantic views, charts via the built-in data_to_chart tool.
--
-- The application's /ask route deliberately does NOT call it. Two reasons, both
-- structural rather than stylistic:
--
--   1. AGENTS RESOLVE PERMISSIONS FROM THE USER'S DEFAULT ROLE, NOT THE SESSION
--      ROLE. The persona guarantee in this project is USE ROLE + USE SECONDARY
--      ROLES NONE per request, so a row-scoped persona such as SC_LOGISTICS_EU
--      would silently receive all-region numbers through an agent call. That is
--      the precise class of defect the whole project exists to prevent, so the
--      persona-scoped path stays on lib/persona.ts.
--   2. An agent run (orchestration -> Analyst -> chart) routinely exceeds the 10
--      second Vercel Hobby function limit documented in lib/env.ts, which is the
--      same limit that already hides the drift-test button there.
--
-- So the agent is reachable from Snowsight, from DATA_AGENT_RUN, and from the app
-- only where the host has no such limit. It is governed by the semantic views and
-- their verified queries rather than by the registry-assembled SQL path.
--
-- ---------------------------------------------------------------------------
-- WHY VERIFIED QUERIES MATTER MORE THAN THE PROMPT
--
-- Analyst re-derives SQL for every question unless a verified query pins it. The
-- 38 verified queries declared in 00e_semantic.sql are therefore the single
-- highest-leverage part of this agent's accuracy, and several are written as
-- teaching examples: every inventory query is per snapshot, which shows Analyst
-- the non-additive pattern instead of describing it in prose and hoping.
--
-- The instructions below add only what a verified query cannot express: the
-- inbound/outbound distinction, the accrued/invoiced distinction, and the three
-- rules that keep a prediction from being reported as a measurement.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS SNOWFLAKE_INTELLIGENCE
  COMMENT = 'Home for Snowflake Intelligence agents. Kept separate from SUPPLY_CHAIN so that dropping and rebuilding the data does not drop the agent with it.';

CREATE SCHEMA IF NOT EXISTS SNOWFLAKE_INTELLIGENCE.AGENTS
  COMMENT = 'Cortex Agents. Referenced by lib/constants.ts AGENT_FQN.';

USE DATABASE SNOWFLAKE_INTELLIGENCE;
USE SCHEMA AGENTS;

-- NO COPY GRANTS, DELIBERATELY. The documented syntax places COPY GRANTS before
-- COMMENT, and this account's parser rejects that combination outright:
--   "syntax error line 2 at position 2 unexpected 'comment'"
-- Because MULTI_STATEMENT parsing happens before execution, that single syntax
-- error also stopped the CREATE DATABASE and CREATE SCHEMA above from running --
-- a whole-file failure from one clause. It is redundant here regardless: every
-- grant is re-issued explicitly at the bottom of this file, which is easier to
-- audit than a flag that silently preserves whatever was granted before.
CREATE OR REPLACE AGENT SC_ONTOLOGIST_AGENT
  COMMENT = 'Governed supply chain analytics agent. Answers only from the SUPPLY_CHAIN semantic views, distinguishes inbound from outbound service, refuses to invent a metric, and never reports a prediction as a measurement.'
  PROFILE = '{"display_name": "Supply Chain Ontologist", "color": "blue"}'
  FROM SPECIFICATION
  $$
models:
  orchestration: auto

orchestration:
  tool_not_accessible: accept
  budget:
    seconds: 60
    tokens: 24000

instructions:
  response: |
    You answer questions about a governed supply chain ontology. Every number you
    report must come from a tool. Never compute, estimate or infer a figure yourself.

    METRIC BOUNDARIES. If no available metric answers the question, say so plainly
    and name the closest governed metrics instead. Do not derive a metric that does
    not exist: there is no revenue, margin, customer satisfaction or emissions
    metric in this ontology, and cost data cannot be turned into any of them.

    INBOUND IS NOT OUTBOUND. Supplier On-Time Delivery measures whether suppliers
    met the dates they promised us. On-Time Delivery measures whether we met the
    dates we promised customers. They are different metrics over different facts
    and must never be merged, averaged together or reconciled as one number. If a
    question says only "on-time delivery" with no side named, ask which one before
    answering.

    ACCRUED IS NOT INVOICED. Freight Cost is what we accrued. Freight Invoiced is
    what carriers billed. Freight Bill Variance is invoiced less accrued, and a
    positive value means the carrier billed more than we accrued.

    INVENTORY IS A BALANCE, NOT A FLOW. Days of Inventory and Inventory Value are
    observed at a month-end snapshot. Never sum or average them across snapshot
    dates: twelve month-end balances summed counts the same physical stock twelve
    times and produces a plausible number that is wrong by a factor of twelve.
    Report the latest snapshot in the requested period and say which date it is.

    REALIZED PERFORMANCE EXCLUDES THE FUTURE. The data contains promised receipts
    and planned deliveries dated after today. Those are commitments, not
    performance. Exclude them from any service metric and say that you did.

    ABSOLUTE DOLLAR METRICS HAVE NO TARGET, BY DESIGN. Freight cost, freight
    invoiced, freight bill variance, total landed cost, inventory value and
    purchase price variance all scale with volume and with the length of the
    period, so do not compare them to a threshold or call them good or bad on
    level alone.

    PREDICTIONS ARE NOT MEASUREMENTS. Three rules, without exception:
      1. Never produce a forecast yourself. Predictions come only from the
         Metric_Outlook tool. If it has no row for what was asked, say the
         prediction does not exist.
      2. Always label a prediction as a prediction, and always quote the
         backtested accuracy of the method that produced it alongside the number.
      3. Never present a high accuracy score as evidence that a prediction is
         useful. These service metrics are close to stationary, so predicting the
         historical mean scores about 99.7% while demonstrating nothing. Where a
         method does not beat its own trailing-mean benchmark, say so.

    Prefer a chart when the answer has a dimensional breakdown. Do not put metrics
    with different units on one axis: a percentage and a dollar total on the same
    scale is a misleading chart.

    Be concise. State the number, its period, and where it came from.

  orchestration: |
    Route by domain, and prefer the narrowest view that can answer the question:
      - supplier delivery, supplier fill, purchase price variance -> Supplier_Analyst
      - customer delivery, OTIF, fill rate, perfect order -> Fulfillment_Analyst
      - inventory cover, stock value, stockouts -> Inventory_Analyst
      - freight, landed cost, carrier billing -> Landed_Cost_Analyst
      - demand forecast versus actual -> Demand_Analyst
      - production output, scrap, schedule adherence -> Manufacturing_Analyst
      - anything spanning two or more of the above on a shared dimension such as
        product family -> Ontology_360_Analyst
      - anything about next month, target risk, breach probability or projected
        volume -> Metric_Outlook

    Use Ontology_360_Analyst when the question compares domains, because only that
    view carries the conformed dimensions that make the comparison valid.

    Call data_to_chart after a tool returns a dimensional breakdown.

    If a tool is not accessible to the caller, say that access is the reason and
    name the metric. Do not silently substitute a different metric or view.

  sample_questions:
    - question: "How does supplier on-time delivery compare with the on-time delivery we give customers?"
    - question: "Which product families are we delivering late?"
    - question: "How many days of inventory are we holding?"
    - question: "Are carriers billing us more than we accrued for freight?"
    - question: "Which product families will miss their on-time delivery target next month?"
    - question: "What order-line volume should we plan for over the next few months?"
    - question: "Which sourcing regions are late most often?"

tools:
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Ontology_360_Analyst"
      description: "Cross-domain supply chain ontology: 5 conformed dimensions and 6 facts spanning inbound receipts, outbound deliveries, inventory, landed cost, manufacturing and demand. USE THIS when a question spans two or more domains on a shared dimension such as product family, supplier region or carrier. Do NOT use it when a single-domain view can answer the question, because the narrower view resolves more reliably."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Supplier_Analyst"
      description: "Inbound supplier performance at purchase-order receipt-line grain: supplier on-time delivery, supplier fill rate, purchase price variance. Dimensions include supplier name, sourcing region, supplier tier and product family. USE THIS for anything about whether SUPPLIERS met dates or quantities promised to us. Do NOT use it for deliveries to customers."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Fulfillment_Analyst"
      description: "Outbound customer fulfilment at order-line grain: on-time delivery, on time in full, fill rate, perfect order rate. Dimensions include product family, destination region, carrier and recorded defect reason. USE THIS for anything about whether WE met dates or quantities promised to customers. Do NOT use it for supplier performance."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Inventory_Analyst"
      description: "Month-end inventory positions by material and location: days of inventory, inventory value, stockout rate. Dimensions include snapshot date, product family, ABC class, node name and region. SNAPSHOT GRAIN: every query must be scoped to a single snapshot date, never aggregated across dates. USE THIS for stock on hand, cover and value."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Landed_Cost_Analyst"
      description: "Landed cost and freight billing at shipment grain: landed cost per unit, total landed cost, accrued freight, invoiced freight, freight bill variance. Dimensions include carrier, service level, destination region and product family. USE THIS for cost to serve and carrier billing disputes. Accrued and invoiced freight are different metrics."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Demand_Analyst"
      description: "Monthly demand forecast versus actual by material: forecast units, actual units, forecast accuracy. USE THIS for demand plan quality. Include only closed periods, because an open period carries a zero actual and would read as total inaccuracy."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Manufacturing_Analyst"
      description: "Production completions by plant: units completed, scrap rate, schedule adherence. Dimensions include plant name, region and product family. USE THIS for manufacturing output and quality."
  - tool_spec:
      type: "cortex_analyst_text_to_sql"
      name: "Metric_Outlook"
      description: "Governed predictions already produced and scored: predicted value, governed target, breach probability, banded verdict, and the backtested accuracy of the producing method. USE THIS for any question about next month, target reachability, breach risk or projected volume. It reports only predictions that already exist and CANNOT extrapolate a new one. Always quote the method accuracy alongside the prediction."
  - tool_spec:
      type: "data_to_chart"
      name: "data_to_chart"
      description: "Renders a chart from data another tool returned. Use it whenever an answer has a dimensional breakdown. Never place metrics with different units on a shared axis."

tool_resources:
  Ontology_360_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Supplier_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_SUPPLIER"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Fulfillment_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_FULFILLMENT"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Inventory_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_INVENTORY"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Landed_Cost_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_LANDED_COST"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Demand_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_DEMAND"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Manufacturing_Analyst:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_MANUFACTURING"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  Metric_Outlook:
    semantic_view: "SUPPLY_CHAIN.SEMANTIC.SC_OUTLOOK"
    execution_environment:
      type: "warehouse"
      warehouse: "COMPUTE_WH"
  $$;

-- ---------------------------------------------------------------------------
-- Access.
--
-- SC_SUPPLIER_LEGACY_DEFECT is deliberately NOT a tool. It is the negative
-- control: a knowingly wrong supplier OTD kept deployed so the drift test can be
-- shown to fail. Exposing it to a conversational surface would let a governed-
-- looking answer carry the defective number.
-- ---------------------------------------------------------------------------

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE SC_ONTOLOGY_STEWARD;
GRANT USAGE ON AGENT SC_ONTOLOGIST_AGENT TO ROLE SC_ONTOLOGY_STEWARD;

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE SC_PROCUREMENT;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE SC_PROCUREMENT;
GRANT USAGE ON AGENT SC_ONTOLOGIST_AGENT TO ROLE SC_PROCUREMENT;

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE SC_LOGISTICS;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE SC_LOGISTICS;
GRANT USAGE ON AGENT SC_ONTOLOGIST_AGENT TO ROLE SC_LOGISTICS;

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE SC_LOGISTICS_EU;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE SC_LOGISTICS_EU;
GRANT USAGE ON AGENT SC_ONTOLOGIST_AGENT TO ROLE SC_LOGISTICS_EU;

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE SC_PLANNER;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE SC_PLANNER;
GRANT USAGE ON AGENT SC_ONTOLOGIST_AGENT TO ROLE SC_PLANNER;

-- Evidence.
SHOW AGENTS IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS;
