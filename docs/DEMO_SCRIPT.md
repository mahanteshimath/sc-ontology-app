# 5-minute demo script

Judges review many projects fast. This is the click path that proves the three judging
criteria in order, in under five minutes. Pre-warm `/api/ask` a few minutes before
presenting — cold start is ~14s and should not be the first thing a judge sees:

```bash
SMOKE_BASE=https://sc-ontology-app.vercel.app SMOKE_PASSWORD=... npm run prewarm
```

## 0. Open on `/` (30s)
Say: "Supply chain data is scattered across ERP, logistics, supplier and IoT systems with
inconsistent definitions — the same question returns different answers to different teams.
This is a governed ontology and conversational layer that guarantees it doesn't."

Point at one headline metric tile. Note the target, prior-period and YoY deltas are already
on screen — this is a real operating console, not a mockup.

## 1. `/ontology` — the entity model (45s)
Say: "The ontology is Supplier → Part → Plant → Shipment → Order → Customer, exactly as
named in the brief — 12 entities, 15 relationships, the four canonical metrics named in
the brief (on-time delivery, fill rate, days of inventory, landed cost), plus IoT
shipment telemetry — the fourth data source the brief names alongside ERP, logistics and
supplier systems."

Point out: this diagram is read live from `INFORMATION_SCHEMA` on the deployed semantic
view — it is structurally incapable of drifting from what the app actually queries.

## 2. `/consistency` — the win condition, proven (90s)
This is the centerpiece. Say: "Here is the actual problem statement, reproduced and
solved."

- Show the same metric (e.g. supplier on-time delivery) executed as three personas
  side by side — Planning, Procurement, Logistics — landing on the identical number.
- Point at the negative control, `SC_SUPPLIER_LEGACY_DEFECT`: it deliberately reproduces
  the classic "average of averages" bug and reports **0.882631** against the correct
  **0.875824** — a measured 0.006807 spread.
- Say: "This isn't asserted in a README, it's a scheduled test. `METRIC_DRIFT_TEST()` runs
  daily and compares every governed view against an independently computed canonical
  value. The negative control stays deployed on purpose, so the test can be shown
  failing, not just passing."

## 3. `/ask` — the conversational layer, guarded (90s)
Ask the same question as two different signed-in personas (e.g. `logistics` and
`logistics-eu`):

- "What is our on-time delivery?"
- Show the persona-scoped answer changes for the EU role — same metric definition,
  correctly scoped rows, not a different number for a different reason.
- Ask a follow-up: "and by supplier region?" — show the transcript understands the
  reference and the chart regroups without re-explaining the question.
- Optionally ask an off-ontology question ("what's our customer satisfaction score?")
  to show the refusal: the model may only choose ids from the registered metric
  catalogue, so an unregistered concept is declined rather than guessed at.

## 4. `/network-risk` — from governed number to operational action (45s)
Say: "The ontology isn't just a reporting layer — it drives an operational read."

Show a lane-level disruption scenario (e.g. a chokepoint) and how it ties back to the
same NODE/LANE entities from the ontology diagram in step 1.

## 5. Close (20s)
Say: "Fourteen metrics, twenty-eight bindings, zero spread on the last drift run, and a
negative control that proves the test isn't just green by default. One definition, every
team, the same answer."

---

### If live Snowflake/network has issues
Fall back to the recorded 2-3 minute version of this same script. Record it once before
presenting; do not attempt to narrate a live outage.
