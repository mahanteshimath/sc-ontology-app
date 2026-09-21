---
name: "update-readme-hackathon-winning-presentation"
created: "2026-09-20T20:02:16.731Z"
status: pending
---

# Plan: World-Class Hackathon README Overhaul

## 1. Context & Objectives

The project addresses the core challenge of **Supply Chain Ontology and Governed Conversational Analytics**:

- Supply chain data scattered across ERP, logistics, supplier, and IoT systems with inconsistent definitions leading to metric drift.
- Building an industry ontology (`Supplier` → `Part` → `Plant/Node` → `Shipment` → `Order` → `Customer` → `Calendar`), expressed as native Snowflake semantic views.
- Grounding Snowflake Cortex Agents and conversational analytics in shared definitions.
- Proving identical metric resolution across real persona roles (`SC_PLANNER`, `SC_PROCUREMENT`, `SC_LOGISTICS`, `SC_LOGISTICS_EU`).
- Delivering an end-to-end operational platform with automated drift detection, negative control testing, and a governed prediction layer.

---

## 2. Architecture & Diagrams to Add

We will embed detailed Mermaid diagrams:

1. **End-to-End System Architecture**: Raw/Canonical Data Layer → Semantic Layer (7 Views) → Governance & Drift Engine → Conversational & ML Services (Cortex Agent, Cortex Analyst, ML Forecast, Anomaly Detection) → Application Layer (Next.js UI, Personas).
2. **Supply Chain Entity-Relationship Ontology Graph**: Visualizing the conformed entities (`Part`, `Supplier`, `Node`, `Customer`, `Calendar`) and operational facts (`PurchaseOrder`, `OrderFulfillment`, `LandedCost`, `Inventory`, `ProductionOrder`, `Forecast`) with cardinality and relationship semantics.
3. **Governed Conversational Analytics Execution Flow**: User question → Cortex Model mapping to registry only (no raw SQL hallucination) → Persona RBAC execution via dedicated connection pool → Provable grounded answer with provenance badge.
4. **Governed Prediction & Reachability Architecture**: Showing the `PREDICTED` scope isolation, normal logistic reachability z-scores, ML volume forecasting, and backtested benchmark scoring.

---

## 3. Structural Sections for the New README.md

1. **Executive Summary & Hackathon Submission**:

   - Title, Team, Live Demo URL (`https://sc-ontology-app.vercel.app`), Demo Credentials, Project Mission.
   - Core Value Proposition: Eliminating metric drift across enterprise supply chain silos through semantic governance.

2. **The Real-World Supply Chain Problem & Measured Pre-Remediation Defects**:

   - The "Meeting-Room Disagreement" problem.
   - Concrete examples: The average-of-averages OTD defect (reproduced live in `SC_SUPPLIER_LEGACY_DEFECT`), snapshot stock non-additivity, future backlog pollution (2.8% future-dated rows distorting monthly metrics).

3. **The 3M Supply Chain Ontology Architecture**:

   - Core entities, dimensions, facts, and conformed calendar design.
   - Mermaid ER Diagram of the complete ontology.
   - The 7 Semantic Views catalog (`SC_ONTOLOGY_360`, `SC_SUPPLIER`, `SC_FULFILLMENT`, `SC_INVENTORY`, `SC_LANDED_COST`, `SC_DEMAND`, `SC_MANUFACTURING`).

4. **Canonical Metric Registry & Mathematical Definitions**:

   - Complete table of all 14 governed metrics:

     - Mathematical formula, numerator, denominator, atomic grain, business owner, target, thresholds, direction, and `as_of_scope`.
     - Explicit rationale for why dollar metrics (`freight_cost_usd`, `ppv`, etc.) are untargeted.

5. **Snowflake Cortex Agent & Conversational Layer**:

   - Agent architecture: `SNOWFLAKE_INTELLIGENCE.AGENTS.SC_ONTOLOGIST_AGENT` and `SC_ONTOLOGIST_AGENT_DEV`.
   - Tool routing: 8 Cortex Analyst tools mapped to semantic views + strict instructions.
   - Verified Query Library: 38 curated VQRs across all 7 views.
   - Golden Evaluation Benchmark (`AGENT_EVAL_QUESTION`, 60 questions, 15 categories, refusal testing, trap queries).
   - Usage Feedback Loop (`AGENT_QUESTION_LOG` & `AGENT_IMPROVEMENT_CANDIDATE`).

6. **Governed Prediction Layer (Reachability, ML Forecast & Anomaly Detection)**:

   - Analytical discovery: Stationarity vs. cross-sectional variance (why traditional trend forecasting on ratio metrics is vanity).
   - The 3 Governed Methods (`TARGET_BREACH` z-scores, `OTD_ANOMALY` anomaly detection, `VOLUME_FORECAST` ML.FORECAST).
   - Prediction Isolation & Governance (`as_of_scope: PREDICTED`, excluded from drift tests, backtested against canonical FORECAST\_ACCURACY/MAPE rubric).

7. **Cross-Persona Security & Real Snowflake RBAC**:

   - The 4 Persona Roles (`SC_PLANNER`, `SC_PROCUREMENT`, `SC_LOGISTICS`, `SC_LOGISTICS_EU`).
   - True Snowflake RBAC enforcement: connection pooling per role, secondary roles disabled, row access policies (RAP) for EU regional scoping.

8. **Automated Governance, Drift Alerts & Negative Controls**:

   - Automated Daily Task (`METRIC_DRIFT_TEST_DAILY`), Hourly Alert (`METRIC_DRIFT_FAILED`), and Email Notification (`SC_GOVERNANCE_EMAIL`).
   - The Negative Control Proof: How we deliberately proved the drift alarm actually sounds when bad arithmetic is introduced.

9. **Frontend Engineering & Design System (Operate-Mode Console)**:

   - Page Breakdown (`/`, `/ontology`, `/metrics`, `/consistency`, `/outlook`, `/ask`, `/operations`).
   - WCAG AA accessibility (7.94:1 dark, 5.75:1 light), custom Tailwind v4 dark variant, streaming Server Components.
   - Inlined SVG brand mark architecture (theme-aware `currentColor` resolution).

10. **Deployment, Operations & Verification Guide**:

    - Live URL, Vercel & Snowflake App Runtime (SPCS) deployment instructions.
    - Local development, test suites, automated smoke testing (`smoke.mjs`, `smoke-outlook.mjs`, `probe-asof.mjs`).

---

## 4. Critical Files

- README.md - The complete documentation file to update.
- sql/07\_verified\_queries.sql - Reference for verified queries and eval set SQL.
- sql/08\_prediction\_layer.sql - Reference for predictions and backtesting SQL.
- lib/constants.ts - Constants and metadata references.
