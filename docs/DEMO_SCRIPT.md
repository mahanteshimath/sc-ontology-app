# 5-minute demo script

Judges review many projects fast. This is the click path that proves the three judging
criteria in order, in under five minutes.

**Before you present:**

```bash
SMOKE_BASE=https://sc-ontology-app.vercel.app npm run prewarm
```

`/api/ask` is ~14s cold and 5–11s warm. A judge's first click should not be the cold one.

---

## 0. Open cold on `/consistency` (45s)

Do **not** open on the home page. The dashboard is good and it is not the argument; every
team has a dashboard. Open where nobody else can follow.

Point at the two numbers side by side and say:

> "Same metric. Same 420,000 receipt lines. The legacy definition says 0.882631, the governed
> one says 0.875824. That 0.0068 is the meeting you have all sat in — the one where two teams
> arrive with different numbers and spend the hour arguing about whose is right instead of what
> to do. We didn't just fix it. We left the broken view deployed, bound to the metric, so you
> can watch the test catch it."

Then scroll to **What that spread actually costs**:

> "And here is why two thirds of a percentage point is not rounding. Nobody acts on the number,
> they act on the verdict. Against the governed target, 54 of 300 suppliers genuinely qualify.
> The legacy definition reports 66. Twelve suppliers get a clean bill of health they did not earn
> — the compliant list is inflated by 22%.
>
> Now look at the last tile: **zero false fails.** The error only ever runs one way. A defect that
> wrongly escalates a supplier is found within a week, because the supplier disputes it and
> somebody rechecks the arithmetic. A defect that wrongly *clears* a supplier generates no
> complaint from anyone, so it survives indefinitely. The cost of an ungoverned metric is not a
> wrong dashboard. It is a review that never happens."

That is the whole pitch. Everything after it is evidence.

## 1. `/ontology` — the entity model (45s)

> "The ontology is Supplier → Part → Plant → Shipment → Order → Customer, exactly as named in
> the brief: 12 entities, 15 relationships, the four canonical metrics, plus IoT shipment
> telemetry — the fourth source the brief names alongside ERP, logistics and supplier systems."

Point out that the diagram is read live from `INFORMATION_SCHEMA` on the deployed semantic view,
so it is structurally incapable of drifting from what the app queries.

Then scroll to **Hierarchies** and make the point that separates this from a data dictionary:

> "The brief asks for hierarchies. A semantic view has no hierarchy construct, so these have to be
> declared — which is exactly why each one is checked instead of trusted. Every level is joined
> back to the deployed view, and every rollup is measured against the source dimension: 2,000
> materials roll into 8 families roll into 4 segments, and zero of them map to more than one
> parent.
>
> Two rollups that looked obviously right were measured and rejected — commodity group does not
> roll into sourcing region, and customer segment does not roll into sales region. Six and four
> violations respectively. They are cross-regional by construction, so they are declared as their
> own two-level hierarchies rather than stacked into a drill path that would double count."

## 2. Back to `/consistency` — cross-persona execution (60s)

- Pick a governed metric in the runner. It re-executes once per persona role, through each
  semantic view that persona can reach, under that role's own grants. Identical values.
- Then point at **Persona access model**: the EU logistics role sees fewer rows because of a row
  access policy, and computes on-time delivery with exactly the same definition.

> "Narrowing which rows a team can see must never change what a metric means. Those are separate
> concerns and they are separately enforced — by Snowflake, not by the app."

## 3. `/consistency` — conversational accuracy, scored (45s)

Scroll to **Conversational accuracy, scored**.

> "Every governed metric here is drift-tested rather than asserted. For a long time the
> conversational layer was the exception: 60 golden questions existed and nothing ran them. Our
> own README said a test that has only ever passed is indistinguishable from a test that is not
> running — and the one thing we hadn't run was that one.
>
> This is the run. Each question is asked over HTTP as its own persona, so what is scored is the
> whole governed path, not the prompt. Eight questions must be *refused* — refusing correctly is
> as much a pass as resolving correctly, because an invented metric looks exactly like a real one
> while a refusal is visibly a refusal. Three are genuinely ambiguous and must ask rather than
> guess."

Then scroll to **What it got wrong** and do not skip it:

> "And we publish the failures. An accuracy figure without the failures behind it is a scoreboard,
> not a diagnostic — and a question set tuned until it is green has stopped being a test.
>
> One of these found a real bug. Q53 asks procurement for freight bill variance. Procurement is
> granted the supplier view and not the landed-cost view, so it should be refused on access. It
> was answered — because the metric is also bound to the cross-domain view, which procurement
> *can* read. The domain grants were decorative. That is a broken access control, it was found by
> the evaluation rather than by review, and it is fixed: the domain grant now decides what you may
> ask about, and the cross-domain view only decides where it executes."

## 4. `/consistency` — two engines, one definition (45s)

> "We built a Cortex Agent and then deliberately did not route the app through it, because an
> agent resolves permissions from the user's *default* role rather than the session role — so the
> EU persona would silently get all-region numbers. That is a decision, and read quickly it looks
> like a gap. So we ran both."

Point at the table:

> "The result splits on exactly one variable. Where the agent reused a **verified query**, it
> matched the canonical definition exactly. Where it **derived its own SQL**, it returned a number
> matching neither the registry nor its own previous run — fill rate came back 0.973944 on one run
> and 0.973633 on the next.
>
> Free text to SQL is non-deterministic at the third decimal place. That is invisible on a
> dashboard and decisive in a review. The application never writes SQL — it resolves registered
> metric ids and assembles the query from the registry — so it cannot do this."

## 5. `/ask` — the conversational layer, live (45s)

Ask as two personas (`logistics`, then `logistics-eu`):

- "What is our on-time delivery?"
- Show the EU answer: same definition, correctly scoped rows.
- Follow up with "and by supplier region?" — the transcript understands the reference and the
  chart regroups without re-explaining.
- Optionally ask an off-ontology question ("what's our customer satisfaction score?") to show the
  refusal naming the closest governed alternatives.

## 6. Close (20s)

> "Fourteen metrics, twenty-eight bindings, zero spread on the last drift run. Seven hierarchies
> with every rollup measured. Sixty conversational questions scored, failures published. A
> negative control kept deployed on purpose so the test can be seen failing, not just passing.
>
> One definition. Every team. The same answer — and a way to prove it tomorrow, not just today."

---

### If live Snowflake or the network has issues

Fall back to the recorded 2–3 minute version of this same script. Record it once before
presenting; do not attempt to narrate a live outage.

### Reproducing the evidence

```bash
npm run dev                          # in another shell
npm run eval                         # scores the 60 questions, writes AGENT_EVAL_RUN
npm run parity                       # agent vs application vs canonical
node scripts/rebuild.mjs --verify    # SQL checks, including the drift gate
```
