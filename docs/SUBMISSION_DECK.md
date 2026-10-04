# Submission deck - slide content

Slide-by-slide copy mapped to the three required sections of the submission guidelines
(Problem Brief, Architecture Diagram, Impact Statement). Every number is read from a governed
object; the source is named beside it so a judge can check it on the live app.

Suggested length: 9 slides, ~3 minutes if narrated. Open on slide 2, not slide 1.

---

## 1. Title

**Supply Chain Ontology - one definition, every team, the same answer.**
Governed conversational analytics on Snowflake semantic views. Team 3M-ONTOLOGIST.

Live: https://sc-ontology-app.vercel.app

---

## Section 1 - Problem Brief

### 2. The meeting everyone has sat in  *(open here)*

Two numbers, side by side, same 420,000 receipt lines:

| Definition | Supplier on-time delivery |
|---|---|
| Legacy (average of monthly averages) | **0.882631** |
| Governed (every receipt line counts once) | **0.875824** |

> "Same question, two answers. The hour gets spent on whose number is right, not on what to do."

Source: `SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT` vs `SEMANTIC.SC_SUPPLIER` - `/consistency`

### 3. Who, what hurts, and why it survives

- **Industry:** manufacturing supply chain - ERP, logistics, supplier and IoT systems, each with its
  own definition of "on-time".
- **Personas:** Planning (inventory, demand), Procurement (supplier performance, contracts),
  Logistics (fulfilment, freight; plus an EU-scoped variant), and the Ontology Steward.
- **Pain:** the same metric resolves differently per team, and the disagreement is found in a review
  meeting, not a test.
- **Why it survives:** the legacy definition wrongly clears **12 of 300** suppliers (compliant list
  **+22%**) and wrongly escalates **zero**. A false fail gets disputed within a week; a false pass
  generates no complaint, so nobody ever rechecks it.
- **The improvement:** metrics are defined once, as Snowflake semantic views, and *proven* identical
  for every persona on a daily schedule.

Source: `GOVERNANCE.V_DIVERGENCE_IMPACT`

---

## Section 2 - Architecture Diagram

### 4. Data flow

```
 STRUCTURED                         UNSTRUCTURED
 ERP  PO receipts, sales orders     Supplier contracts (free text, 300)
 WMS  inventory snapshots                 | AI_EXTRACT  (scored vs ground truth)
 TMS  shipments, freight bills            | Cortex Search
 IoT  shipment telemetry                  v
   |                               DIM_SUPPLIER_CONTRACT
   v                                      |
 RAW --> CANONICAL (atomic-grain facts) <-+
              |
              v
 SEMANTIC  12 semantic views (360, value chain, 9 domains, 1 defect control)   <-- the only query surface
              |      CERTIFIED tag (SNOWFLAKE.CORE.CERTIFICATION_STATUS)
              |                      |
              v                      v
 GOVERNANCE  metric registry + SCOR,  Cortex Agent (11 tools)
   drift test (daily), 15 DMFs,          |        MCP server SC_ONTOLOGY_MCP
   persona grants + row access policy,   |        (governed_metric, agent, search;
   refusal classifier -> roadmap         |         no raw SQL tool)
              |                          |               |
              v                          v               v
         Next.js app: /ask (voice), /consistency,    any MCP client
         /ontology (OWL export), /impact              (IDE, other agents)
         queries run AS the persona's Snowflake role
              ^
 CI  GitHub Actions (OIDC) -> CALL CI_GOVERNANCE_GATE()  fails the PR on drift / DQ / certification
```

Key point for the slide: **the drift test compares every view against an independent canonical SQL
on the atomic fact**, so two views cannot agree while both being wrong.

### 5. CoCo skills and how the modules plug together

| Layer | SQL module | Cortex Code skill |
|---|---|---|
| Sources and facts | `00a`-`00d`, `11` | `sql-author` |
| Semantic views, verified queries, agent | `00e`, `07`, `10` | `agent-studio` |
| Roles, row access policy, persona grants | `00a`, `00f` | `data-governance` |
| Drift test, daily schedule, alert, negative control | `00f`, `04`, `06` | `data-quality`, `snowflake-tasks`, `alert` |
| Forecast and breach prediction | `07b`, `08` | `machine-learning` |
| Contract extraction | `16` | `document-intelligence`, `cortex-ai-function-studio` |
| SCOR industry alignment | `18` | `sql-author` |
| Certification + data-quality monitors, trust badge | `19` | `certify-object`, `data-quality` |
| MCP server for other agents | `20` | `sql-author` (no dedicated skill) |
| Refusal classification -> ontology roadmap | `21` | `cortex-ai-function-studio` (AI_CLASSIFY) |
| CI governance gate | `22`, `.github/workflows/governance-gate.yml` | `ci-cd` |
| Weekly contract-breach digest | `23` | `snowflake-tasks`, `notification` |
| Impact of changing a view | - | `lineage` |
| App (voice input, OWL/JSON-LD export) | `app/`, `app.yml` | `snowflake-apps` |

Modules connect through three contracts only: atomic `CANONICAL` facts, the metric registry
(`METRIC_DEFINITION` + `METRIC_BINDING`), and persona access (`PERSONA_VIEW_ACCESS` + row access
policy). `node scripts/rebuild.mjs` rebuilds all of it, 6.1M rows, in ~4.5 minutes.

**One workflow, end to end (the video):**

```
INPUT        docs/demo/amendment_SUP-00042.txt   (free text: commitment 85% -> 87%)
   |  $document-intelligence
PROCESSING   GOVERNANCE.INGEST_SUPPLIER_CONTRACT  -> AI_EXTRACT -> DIM_SUPPLIER_CONTRACT
             -> search index refresh -> compliance re-scored against the governed OTD   (~9 s)
   |  $data-quality
PROOF        npm run persona-proof   5/5 metrics identical, 22 persona-scoped executions
             METRIC_DRIFT_TEST()     every binding PASS, zero spread
   |  $agent-studio  /  %SC_ONTOLOGIST_AGENT
OUTPUT       "Which suppliers breached but look compliant?"  -> 19 suppliers, $196,156
             (18 before the amendment - the new contract is already in the answer)
```

> Before presenting: confirm the skill column against how your team actually built each file.

---

## Section 3 - Impact Statement

### 6. Measured outcomes

| | Measure | Value |
|---|---|---|
| Consistency | Metric bindings matching the canonical value | **15 / 15, zero spread** |
| Consistency | Same metric, planning vs procurement vs logistics, each under its own role | **5 / 5 identical** (22 executions) |
| Accuracy | Conversational eval, 60 questions, run as each persona | **93.3%** (56/60, latest full run), failures published |
| Accuracy | Cortex Agent vs app vs canonical SQL | **4 / 4 reconciled** |
| Accuracy | Contract terms extracted by AI_EXTRACT | **2,700 / 2,700 fields** |
| Decisions | Suppliers wrongly cleared by the legacy metric | **12** (compliant list +22%) |
| Money | Claimable contract penalties | **$815,222** (67 suppliers) |
| Money | Penalties hidden by the legacy metric | **$178,832** (18 suppliers) |
| Trust | Semantic views certified + DQ-monitored + drift-checked (`TRUSTED`) | **7 / 11**; 3 certified but their source tables have no DQ monitor yet (shown as such, not as trusted); the defect view is deliberately uncertified |
| Trust | Data-quality monitors on canonical facts (DMFs with expectations) | **15 / 15 passing** |
| Standards | Governed metrics mapped to SCOR | **13 / 15** (3 exact, 5 variant, 5 component); 2 declared not-in-SCOR |
| Time | Governed, persona-scoped answer | **4.2 s** mean (p95 5.8 s), latest full run |
| Time | Same question again (mapping reused, value re-queried live) | **1.7 s** (was 16-20 s) |
| Time | vs manual reconciliation (4 h, *assumed*) | ~3,421x faster *(assumption, labelled)* |

Source: `GOVERNANCE.V_IMPACT_SCORECARD` - `/impact`; trust rows `GOVERNANCE.V_TRUST_SIGNALS`; SCOR
`GOVERNANCE.METRIC_SCOR_ALIGNMENT`; repeat latency `scripts/probe-latency.mjs`. Every row names its
source object; the only assumption is labelled as one.

### 7. The finding nobody else will have

- **79 of 300 contracts** define on-time as a monthly average - the legacy definition, written into
  the agreement. The enforceable number and the governed number differ by construction.
- The ontology cannot fix a contract. It can flag every one for renegotiation, which a dashboard
  never would.

### 8. Scalability and beyond the demo

- **New metric = one registry row + bindings.** Drift test, registry page, consistency runner and
  `/ask` pick it up with no code change.
- **New source = a new canonical fact.** IoT telemetry and contracts were both added this way,
  without touching the base semantic layer.
- **New document type reuses the contract pattern:** quality certificates, rate confirmations,
  customs declarations. Extract, score against a labelled sample, route low-certainty terms to
  review.
- **The roadmap writes itself.** Every refused question is classified by AI_CLASSIFY (access denied /
  guardrail / unregistered metric / out of scope). Unregistered-metric demand is ranked, so the
  steward promotes what teams actually asked for - forecast totals and schedule adherence lead
  today. Source: `GOVERNANCE.V_ONTOLOGY_DEMAND` - `/impact`.
- **Every agent gets the same number.** `GOVERNANCE.SC_ONTOLOGY_MCP` exposes the governed metrics,
  the agent and contract search over MCP, executing as the caller (row access policy honoured:
  EU logistics gets 0.8959, global logistics 0.8855), with no raw-SQL tool.
- **Portable ontology.** `/api/ontology` exports OWL/SKOS (Turtle or JSON-LD), generated from the
  deployed view and the registry, with SCOR codes as `skos:exactMatch` / `closeMatch`.
- **Governance in the build.** A PR that makes a binding drift, fails a DQ monitor, certifies the
  defect view or leaves a metric SCOR-unmapped fails CI (`CI_GOVERNANCE_GATE`, proven red and green).
- **Industry-agnostic.** Registry + bindings + drift test + negative control + scored eval applies
  anywhere two teams compute "the same" metric: finance close, clinical ops, retail.

---

## 9. Close

> "One definition. Every team. The same answer - and a test that proves it tomorrow, not just
> today. We even left the broken definition deployed, so you can watch the test catch it."

---

### Presenter notes

- Prewarm before presenting: `SMOKE_BASE=<url> npm run prewarm` (`/api/ask` is ~14 s cold; a repeated
  question is ~1.7 s because the resolver mapping is reused - the value is always re-queried).
- Judge questions and prepared answers: [`JUDGE_QA.md`](JUDGE_QA.md).
- Demo click path: [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md). Recorded video: [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md).
- The data is synthetic and targets are `ILLUSTRATIVE`; say so once, then point out that the
  arithmetic is computed from the same atomic facts the governed metrics use.
- Record a 2-3 minute fallback video of the demo; do not narrate a live outage.
