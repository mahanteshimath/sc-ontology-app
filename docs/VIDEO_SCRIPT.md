# 5-minute video script - one workflow, end to end, in Cortex Code

**Format required:** screen recording of an end-to-end workflow executed through the CoCo CLI,
showing Input -> Processing -> Output, one fully working workflow, 2-3 modular skills.

**The workflow:** *a supplier signs a contract amendment -> it becomes governed ontology -> every
persona still gets one answer -> anyone can ask about it in plain English.*

**Skills shown (4):** `document-intelligence` (extract), `data-quality` (prove consistency),
`agent-studio` (conversational answer over semantic views), `lineage` (blast radius).

Every number below was produced by a dry run of this exact sequence. If your numbers differ,
you forgot `npm run demo-reset`.

---

## Before you record (10 minutes, once)

```powershell
cd "<repo>\sc-ontology-app"
cortex connections set pramogm-ln72054
npm run demo-reset          # restores the 300 generated contracts (~25 s)
npm run dev                 # second terminal - the app for the last minute
```

- Sign in to `http://localhost:3000` as the steward in a browser tab, open `/consistency` and
  `/impact` once so they are warm.
- On `/ask`, click the mic once and say anything: the first click downloads the Whisper model into
  the browser cache (tens of MB, one time), and you do not want that progress bar on camera. Allow
  microphone access when Chrome/Edge asks.
- Terminal: dark theme, font 18pt+, window 1600x900. Close everything else.
- Open `docs/demo/amendment_SUP-00042.txt` in the editor, split left of the terminal.
- Rehearse the prompts twice. Type them from this page; do not improvise wording on camera.
- If your CoCo build supports the `$skill-name` shorthand, prefix each prompt with it (shown below)
  so the skill load is visible on screen. If not, drop the prefix; the skill auto-loads.
  (Confirmed in the CoCo reference: `$` invokes a skill, `%` mentions a Cortex Agent, `@` references
  a file - so `@docs/demo/amendment_SUP-00042.txt` also works in step 1.)

**Reset between takes:** `npm run demo-reset`. The ingest changes one supplier; the reset restores it.

---

## 0:00 - 0:25 | Hook  (browser, `/consistency`)

**Screen:** the two supplier OTD numbers side by side.

> "Same metric. Same 420,000 receipt lines. One team's dashboard says 0.8826, another says 0.8758.
> That gap wrongly clears twelve suppliers, and it never errs the other way, so nobody ever
> complains and nobody ever checks. We built the ontology that makes this impossible, and we are
> going to run the whole thing from Cortex Code."

## 0:25 - 0:45 | What you are about to see  (one slide)

**Screen:** the architecture diagram from `docs/SUBMISSION_DECK.md` slide 4.

> "ERP, logistics, supplier and IoT data land in atomic facts. On top: governed semantic views -
> one definition per metric - and a drift test that proves every view agrees. One workflow now:
> a new supplier contract comes in as plain text, and we follow it all the way to a trusted answer."

---

## 0:45 - 1:45 | STEP 1 - INPUT -> PROCESSING  (skill: `document-intelligence`)

**Screen:** left, the amendment file. Highlight *"no fewer than 87%"*, *"4%"*, *"USD 100,000"*.

> "Input: an amendment, free text. Supplier 0042 has agreed to a higher on-time commitment:
> 87%, up from 85%. There is no structured field anywhere - the terms are in the prose."

**Type in CoCo:**

```
$document-intelligence Ingest the contract amendment in docs/demo/amendment_SUP-00042.txt for
supplier SUP-00042 using SUPPLY_CHAIN.GOVERNANCE.INGEST_SUPPLIER_CONTRACT, then show me what was
extracted and how the compliance verdict changed.
```

**Expected on screen (~10 s):** CoCo reads the file, calls the procedure, returns:

| | Before | After |
|---|---|---|
| OTD commitment | 0.85 | **0.87** (extracted) |
| Penalty | - | **4% of late-line value, cap $100,000** |
| Payment / Incoterm | - | Net 60 / DAP |
| Governed OTD | 0.8652 | 0.8652 (unchanged) |
| Legacy OTD | - | 0.8736 |
| Status | COMPLIANT | **HIDDEN_BREACH** |
| Exposure | $0 | **$17,324** |

> "Processing: AI_EXTRACT read the terms out of the prose - the same extraction procedure that
> loaded all 300 contracts, scored 2,700 out of 2,700 fields against ground truth. The contract
> changed what the supplier *promised*. It did not change what they *did*: governed OTD is still
> 0.8652, read from the governed view, never recomputed.
>
> And look at the verdict. HIDDEN BREACH. On the governed metric, 0.8652 is below 87% - they owe us
> $17,000. On the legacy dashboard, 0.8736 clears 87%. The old number would have waved this
> through. The contract is now a first-class entity in the ontology and searchable, in one call."

---

## 1:45 - 2:40 | STEP 2 - PROVE IT IS ONE ANSWER  (skill: `data-quality`)

> "Now the brief's hardest requirement: the same metric must resolve identically for planning,
> procurement and logistics. Not claimed - executed."

**Type in CoCo:**

```
$data-quality Prove that the canonical metrics resolve identically for planning, procurement and
logistics: run npm run persona-proof, then call SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST() and
summarise both.
```

**Expected on screen (~40 s total):**

```
  Supplier On-Time Delivery    canonical     0.875824   IDENTICAL
      SC_PLANNER       via SC_ONTOLOGY_360      0.875824
      SC_PROCUREMENT   via SC_SUPPLIER          0.875824
      SC_LOGISTICS     via SC_ONTOLOGY_360      0.875824
  ...
  5/5 metrics identical across 3 personas (22 persona-scoped executions, tolerance 1e-9)
```

then the drift test: every metric `PASS`, spread `0`.

> "Twenty-two executions. Each one runs under that persona's own Snowflake role, secondary roles
> off, through every view that role is granted. On-time delivery, fill rate, days of inventory,
> landed cost: identical to the sixth decimal, and identical to the canonical SQL on the atomic
> fact. The drift test does the same every morning at six, and we keep the broken legacy view
> deployed on purpose, so you can see the test is capable of failing."

---

## 2:40 - 3:45 | STEP 3 - OUTPUT: ask in plain English  (skill: `agent-studio`)

> "Output. Any team, plain English, answered from the semantic views - business meaning, not
> column names."

**Type in CoCo:**

```
$agent-studio Using the semantic view SUPPLY_CHAIN.SEMANTIC.SC_CONTRACT, which suppliers breached
their contract but look compliant on the legacy dashboard, and how much penalty is hidden?
```

**Expected on screen:** Cortex Analyst resolves to the verified query
(`contract.hidden_penalty_exposure` by `supplier.supplier_name` where `HIDDEN_BREACH`). **19
suppliers, $196,156** - Supplier 0042, ingested two minutes ago, is in the list.

> "Nineteen. It was eighteen before the amendment - the new contract is already in the answer.
> A hundred and ninety-six thousand dollars in penalties that the old definition hides. The model
> didn't invent that SQL: it matched a verified query the steward signed, so it returns the same
> number every time."

**Stronger alternative - ask the governed Cortex Agent itself** (`%` mentions an agent in CoCo).
Verified: it routes to its `Contract_Analyst` tool and answers with the same number. It takes
~40 s, so speed that segment up in editing.

```
%SC_ONTOLOGIST_AGENT Which suppliers breached their contract but look compliant on the legacy
dashboard, and how much penalty is hidden in total?
```

> "Same question, asked of the production agent. It picked the contract tool on its own, out of
> eleven, and landed on the same figure. Two engines, one definition."

**Type in CoCo (follow-up):**

```
What does our agreement with Supplier 0042 Materials say about late deliveries? Use the Cortex
Search service SUPPLY_CHAIN.SEMANTIC.SUPPLIER_CONTRACT_SEARCH and quote the clause.
```

**Expected:** the top hit is `AMEND-SUP-00042-....txt`, quoting clause 4.1 / clause 5.

> "Numbers come from the semantic view; evidence comes from the document. The agent is told never
> to read a figure out of a clause."

---

## 3:45 - 4:05 | STEP 4 - Safe to change?  (skill: `lineage`)

**Type in CoCo:**

```
$lineage What depends on SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE downstream, two levels deep?
```

**Expected (verified):** distance 1 - `SC_SUPPLIER`, `SC_ONTOLOGY_360`, `V_SUPPLIER_CONTRACT_COMPLIANCE`,
the legacy pre-aggregate; distance 2 - `SC_CONTRACT`, `SC_SUPPLIER_LEGACY_DEFECT`,
`V_SUPPLIER_OTD_VERDICT`, the drift baseline, predictions, and the **Cortex Agent**
`SC_ONTOLOGIST_AGENT`.

> "One fact feeds two semantic views, the contract verdicts, the drift test, the forecasts - and
> the agent itself. Before anyone changes it, we know exactly what it would break."

---

## 4:05 - 4:35 | The same workflow, in the product  (browser)

**Screen:** `/ask`, signed in as the steward. Click the **mic**, say *"What is our on-time
delivery?"*, stop. The transcript lands in the box (on-device Whisper, nothing leaves the laptop);
press Enter. Then `/impact` for 3 seconds.

> "Same ontology, in the app - and you can just talk to it. The speech never leaves this laptop.
> 'On-time delivery' is two metrics here, inbound and outbound, so the app answers both and says
> why instead of guessing one. The green badge is Snowflake's own certification tag, plus fifteen
> data-quality monitors and the drift test, checked every morning. And on /impact: 19 hidden
> breaches, the clause behind each one, every figure naming its source."

(Ask the same question a second time if you have 5 spare seconds: the answer comes back in under
2 s with a *mapping reused · value live* chip - the model is skipped, the governed query is not.)

## 4:35 - 5:00 | Impact and close  (one slide: scorecard)

> "Fifteen of fifteen bindings, zero spread. 53 of 60 conversational questions right on the latest full run, failures
> published. The Cortex Agent reproduces the canonical definition on 4 of 4. 2,700 contract fields
> extracted correctly. $832,000 of claimable penalties, $196,000 of them invisible to the old
> number. And all of it is a CI gate: a pull request that breaks a definition fails the build. A new
> metric is one registry row; the ontology exports to OWL for any graph tool; and every other agent
> in the company reaches the same numbers through a governed MCP server.
>
> One definition. Every team. The same answer - and a test that proves it tomorrow."

---

## Timing budget

| Segment | Time | Where | Skill |
|---|---|---|---|
| Hook | 0:25 | browser | - |
| Architecture | 0:20 | slide | - |
| Step 1 Input -> Processing | 1:00 | CoCo | `document-intelligence` |
| Step 2 One answer, proven | 0:55 | CoCo | `data-quality` |
| Step 3 Conversational output | 1:05 | CoCo | `agent-studio` |
| Step 4 Blast radius | 0:20 | CoCo | `lineage` |
| Product | 0:30 | browser | - |
| Close | 0:25 | slide | - |

Running long? Cut step 4 first, then the search follow-up in step 3. Never cut step 2 - it is the
brief's explicit requirement.

## Recording rules that win

- **Cut the waits, never the results.** Speed up the 10-40 s tool runs 4x in editing, with a small
  on-screen "4x" tag, then hold 3 seconds on each output.
- **Zoom on the proof.** Zoom into `HIDDEN_BREACH`, `5/5 metrics identical`, `19` and `$196,156` as
  you say them.
- **Caption every step** in the corner: `INPUT`, `PROCESSING`, `OUTPUT`, and the skill name. Judges
  score against the rubric; make the rubric visible.
- **Say "synthetic data, illustrative targets" once**, in the architecture segment, then move on.
- **Record a clean take after `npm run demo-reset`.** If CoCo phrases a table differently, that is
  fine; the numbers must not change.
