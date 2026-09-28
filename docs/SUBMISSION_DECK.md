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
 SEMANTIC  SC_ONTOLOGY_360 + 9 domain views   <-- the only query surface
              |                      |
              v                      v
 GOVERNANCE  metric registry,     Cortex Agent (11 tools)
   drift test (daily), persona         |
   grants + row access policy          |
              |                        |
              v                        v
         Next.js app: /ask, /consistency, /ontology, /impact ...
         queries run AS the persona's Snowflake role
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
| Impact of changing a view | - | `lineage` |
| App | `app/`, `app.yml` | `snowflake-apps` |

Modules connect through three contracts only: atomic `CANONICAL` facts, the metric registry
(`METRIC_DEFINITION` + `METRIC_BINDING`), and persona access (`PERSONA_VIEW_ACCESS` + row access
policy). `node scripts/rebuild.mjs` rebuilds all of it, 6.1M rows, in ~4.5 minutes.

> Before presenting: confirm the skill column against how your team actually built each file.

---

## Section 3 - Impact Statement

### 6. Measured outcomes

| | Measure | Value |
|---|---|---|
| Consistency | Metric bindings matching the canonical value | **15 / 15, zero spread** |
| Accuracy | Conversational eval, 60 questions, run as each persona | **86.7%** (52/60), failures published |
| Accuracy | Cortex Agent vs app vs canonical SQL | **4 / 4 reconciled** |
| Accuracy | Contract terms extracted by AI_EXTRACT | **2,700 / 2,700 fields** |
| Decisions | Suppliers wrongly cleared by the legacy metric | **12** (compliant list +22%) |
| Money | Claimable contract penalties | **$815,222** (67 suppliers) |
| Money | Penalties hidden by the legacy metric | **$178,832** (18 suppliers) |
| Time | Governed, persona-scoped answer | **18.4 s** mean |
| Time | vs manual reconciliation (4 h, *assumed*) | ~780x faster *(assumption, labelled)* |

Source: `GOVERNANCE.V_IMPACT_SCORECARD` - `/impact`. Every row names its source object; the only
assumption is labelled as one.

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
- **Industry-agnostic.** Registry + bindings + drift test + negative control + scored eval applies
  anywhere two teams compute "the same" metric: finance close, clinical ops, retail.

---

## 9. Close

> "One definition. Every team. The same answer - and a test that proves it tomorrow, not just
> today. We even left the broken definition deployed, so you can watch the test catch it."

---

### Presenter notes

- Prewarm before presenting: `SMOKE_BASE=<url> npm run prewarm` (`/api/ask` is ~14 s cold).
- Demo click path: [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md).
- The data is synthetic and targets are `ILLUSTRATIVE`; say so once, then point out that the
  arithmetic is computed from the same atomic facts the governed metrics use.
- Record a 2-3 minute fallback video of the demo; do not narrate a live outage.
