# Judge Q&A - prepared answers

The questions a technical judge is most likely to ask, each with a short spoken answer and the
evidence to show on screen. Numbers are the ones the live objects return today; if one differs on
the day, say the live one.

---

## The idea

**"Isn't this just semantic views with a nicer UI? Where is the ontology?"**

> The semantic views are where the ontology is *enforced*. The ontology itself is 12 entity
> classes, 15 relationships and 7 drill hierarchies, read back out of the deployed view, so the
> diagram cannot drift from what is queried. Every rollup is measured, not assumed. It exports as
> OWL/SKOS, and 13 of the 15 metrics are mapped to SCOR codes.

Show: `/ontology` (stat tiles, hierarchy rollup status), then *Export as OWL/SKOS -> Turtle*.
Source: `GOVERNANCE.ONTOLOGY_ENTITY`, `ONTOLOGY_RELATIONSHIP`, `V_ONTOLOGY_HIERARCHY`, `/api/ontology`.

**"Snowflake has a Business Ontology feature. Why not use it?"**

> It is not enabled on this account, so we could not build on it. The design maps onto it: the
> entities, relationships and metric registry are ordinary governance tables, and the OWL export
> is a portable form of the same model. If the feature were switched on, it would be a new
> consumer of those tables, not a rewrite.

**"Why SCOR?"**

> It is the supply-chain standard a planner already knows. Three of our metrics are exact SCOR
> matches: perfect order RL.1.1, OTD RL.2.2 and days of inventory AM.2.2. Five are declared as
> variants, with the difference written down; fill rate, for example, is line-level where SCOR
> means order-level. PPV and freight bill variance are marked not-in-SCOR rather than forced into
> a code. The mapping is documentation. It never feeds a calculation.

Show: `/metrics`, the SCOR badge and the *SCOR alignment* field. Source: `GOVERNANCE.METRIC_SCOR_ALIGNMENT`.

---

## "Prove the numbers are the same"

**"How do you know planning, procurement and logistics really get the same number?"**

> We don't claim it, we execute it. `npm run persona-proof` opens a connection *as* each
> persona's Snowflake role, with secondary roles off, and runs every metric through every view
> that role is granted: 22 executions, identical to 1e-9. Separately, the drift test compares
> every binding with an independent canonical SQL on the atomic fact, daily at 06:00 UTC. That's 15 of
> 15 with zero spread.

Show: `/consistency` (pick supplier OTD), then `/metrics` (drift status per metric, *Run drift test*).
Source: `GOVERNANCE.METRIC_DRIFT_RESULT`.

**"Could two views agree and both be wrong?"**

> Not undetected. The drift test does not compare views with each other. It compares each view
> with canonical SQL written against the atomic fact, so a shared mistake in the semantic layer
> still fails.

**"Does the test ever actually fail?"**

> Yes, on purpose. We keep the legacy definition deployed as `SC_SUPPLIER_LEGACY_DEFECT`, and the
> test flags it every run: 0.8826 against 0.8758. The CI gate goes further and *fails* if the
> negative control ever stops diverging, because that would mean the test lost its teeth. We
> proved the gate red by certifying the defect view, then green again.

Source: `GOVERNANCE.CI_GATE_RUN` (one red run and two green runs recorded).

**"What happens when someone changes a definition?"**

> The registry is versioned, so a change is a new row with an effective date. The pull request
> runs `CI_GOVERNANCE_GATE()` through GitHub Actions with OIDC, so no password is stored. Drift, a
> failing DQ monitor, a certified defect view, extraction below 98% or an unmapped metric each
> fail the build. Lineage shows the blast radius before merge.

Files: `sql/22_ci_gate.sql`, `.github/workflows/governance-gate.yml`.

---

## The conversational layer

**"What stops the LLM inventing a metric or a number?"**

> Three things, all in code. First, the model only picks metric *ids* from the catalogue it is
> shown, and every id is re-validated against the registry. An invented id never reaches SQL.
> Second, the SQL is assembled from the registry binding, not written by the model. Third, the
> narration is generated *after* the number, and any figure in the prose that isn't in the result
> rows is rejected and replaced with a template.

Tests: `__tests__/api/ask.test.ts` ("discards a metric id the registry does not contain"),
`__tests__/api/narrate.test.ts`.

**"What about ambiguous questions like 'what is our on-time delivery?'"**

> That is two metrics here: supplier OTD inbound and customer OTD outbound. The model kept quietly
> picking one, so the rule is now enforced in code. An unqualified question gets both, labelled,
> with the reason. It only adds a metric the persona is already granted, so a tie-break can never
> widen access.

Show: `/ask` as the steward, "What is our on-time delivery?". Code: `lib/ambiguity.ts`.

**"How accurate is it?"**

> On 60 scored questions, each run as its persona, 54 are right, which is 90%. The failures are
> published by category on `/consistency`, not hidden. The most common remaining failure is a
> *superset*: answering supplier OTD plus supplier fill rate when only OTD was asked for. The
> ambiguity class went from 7 to 9 correct once the tie-break moved into code.

Source: `GOVERNANCE.AGENT_EVAL_RUN`, `AGENT_EVAL_RESULT`.

**"You also built a Cortex Agent. Why does /ask not just call it?"**

> An agent resolves permissions from the user's default role, and we need every answer to run
> under the *persona's* role with secondary roles off. So `/ask` executes registry SQL under that
> role directly. The agent is the production entry point for Snowflake Intelligence, with 11
> tools, and we check it against the same definitions: 4 of 4 reconciled with the app and the
> canonical SQL.

**"It's slow."**

> The governed number shows before the prose. It's two calls, so the chart doesn't wait for the
> narration. Mean latency is 18.0 s, and most of that is the model mapping the question. A
> repeated question reuses the *mapping* and comes back in about 1.7 s. The *value* is always
> re-queried live under the persona's role, and the answer shows a "mapping reused · value live"
> chip so nobody is misled. A cached number could disagree with the view, and that is the one
> thing this project exists to prevent.

Code: `lib/resolver-cache.ts`. Measured: `node scripts/probe-latency.mjs`.

**"Is the voice input sending audio to a cloud service?"**

> No. Whisper runs in the browser, in a Web Worker, on WebGPU where available and WebAssembly
> otherwise. Audio never leaves the device. Only the transcript goes into the text box, and the
> user presses Enter, so a mis-heard word is caught before it becomes a question.

Code: `lib/whisper.worker.ts`, `components/voice-input.tsx`.

---

## Security and access

**"Show me row-level security actually working."**

> The EU logistics persona is filtered by a row access policy on ship region. Its OTD is 0.8959,
> global logistics gets 0.8855, from the same definition and the same view. The consistency page
> only judges agreement across unscoped personas. A row policy changing *which rows* count is
> correct behaviour, not drift.

**"Can a user escalate to another persona?"**

> No. The signed-in session decides the role, and a request body naming a different persona gets
> a 403, not a silent downgrade. That is tested, and the smoke test checks it against the running
> server.

**"The MCP server: couldn't an agent use it to run arbitrary SQL?"**

> It exposes exactly three tools: governed metric, the Cortex Agent and contract search. There is
> deliberately no SQL tool. The metric procedure runs as the caller, so the row access policy
> still applies: EU logistics gets 0.8959 over MCP, the same as in the app.

Source: `sql/20_mcp_server.sql`, `GOVERNANCE.SC_ONTOLOGY_MCP`.

---

## Data and trust

**"Is this real data?"**

> No, it's synthetic, generated at realistic scale: 6.1M rows across ERP, WMS, TMS, IoT and 300
> contracts. The targets are marked ILLUSTRATIVE. What is real is the arithmetic. Every impact
> figure is computed from the same atomic facts the governed metrics use, and the one assumption
> (four hours of manual reconciliation) is labelled as an assumption.

**"What does the green 'trusted' badge actually mean?"**

> Three independent checks. The view carries Snowflake's `CERTIFICATION_STATUS = CERTIFIED` tag,
> every data-quality monitor on its source tables passes, and every metric bound to it passes the
> drift test. Seven of eleven views meet all three today. Three are certified, but their source
> tables have no DQ monitor yet, and the badge says exactly that instead of claiming trust. The
> defect view is uncertified on purpose.

Source: `GOVERNANCE.V_TRUST_SIGNALS`, `sql/19_trust_signals.sql`.

**"How reliable is the contract extraction?"**

> We scored AI_EXTRACT against the generator's ground truth: 2,700 of 2,700 fields. Extraction
> retries once on failure, and the CI gate fails if accuracy drops below 98%. Per-field confidence
> scores aren't available for text input on this account, so the review route today is the
> ground-truth sample, not a confidence threshold.

---

## Beyond the demo

**"How does this scale to a new metric, team or domain?"**

> A new metric is one registry row plus its bindings. The drift test, registry page, consistency
> runner and `/ask` pick it up with no code change. A new team is a role and a row in
> `PERSONA_VIEW_ACCESS`. A new domain is a canonical fact and a semantic view. Nothing about the
> pattern is specific to supply chain.

**"How do you decide what to add to the ontology next?"**

> The users tell us. Every refused question is classified by AI_CLASSIFY as access denied,
> guardrail, unregistered metric or out of scope. Unregistered-metric demand is ranked by how often
> it's asked. Right now forecast totals, schedule adherence and scrap rate lead. Refusals for
> access and guardrails are the governance working; unregistered demand is the backlog.

Show: `/impact`, *What teams asked for*. Source: `GOVERNANCE.V_ONTOLOGY_DEMAND`, `V_REFUSAL_MIX`.

**"Who actually acts on the hidden breaches?"**

> A weekly digest lists each supplier breaching on the governed number while passing on the
> legacy one, with the exposure and the clause, built by a Monday task. The email path works, but
> the task ships suspended, so nothing is sent until the owner turns it on. The demo shows the
> preview.

Source: `sql/23_contract_digest.sql`, `CALL GOVERNANCE.CONTRACT_BREACH_DIGEST(FALSE)`.

**"What does it cost to run?"**

> We haven't measured credit cost, so we won't quote one. The load is one warehouse plus four
> scheduled tasks: drift test and DQ checks daily, refusal classification and the digest weekly.
> The honest way to answer is `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` after a week of use.
