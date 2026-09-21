## Context

Two separate jobs. I explored [app/api/ask/route.ts](app/api/ask/route.ts),
[components/ask-console.tsx](components/ask-console.tsx), [lib/env.ts](lib/env.ts),
[components/operations-charts.tsx](components/operations-charts.tsx), `sql/07_verified_queries.sql`
and the Cortex Agent DDL reference before deciding anything.

### What `/ask` is today

Single-shot. `AskConsole` holds one `useMutation`; each question **replaces** the previous answer.
The route resolves a question to registry metric ids + at most one dimension via `AI_COMPLETE`,
assembles the SQL itself, and returns metric cards (scalar) or a table (dimensional). No conversation
memory, no prose, no charts.

### Why I am not routing chat through `DATA_AGENT_RUN` — the deciding constraint

`CREATE AGENT … FROM SPECIFICATION` is available in this account, with a built-in `data_to_chart`
tool and multi-turn threads. It looks like the obvious answer and it is the wrong one here:

1. **[lib/env.ts](lib/env.ts) documents a 10-second Vercel Hobby function limit** — it is why
   `canRunDriftTest()` returns false on Vercel for a 25s procedure. An agent run (orchestration →
   Analyst → chart) routinely exceeds 10s. Routing `/ask` through it would break the live deployment
   that currently answers in 4–6s.
2. **Agents resolve permissions from the user's *default* role, not the session role.** The persona
   guarantee in this project is `USE ROLE` + `USE SECONDARY ROLES NONE` per request. An agent call
   cannot honour that, so `SC_LOGISTICS_EU` would silently get all-region numbers — the exact class of
   defect this codebase exists to prevent.
3. The project's headline claim is that the LLM never writes SQL. Analyst writing it is defensible,
   but it is a claim change, not a feature.

**So:** the chat is built on the existing constrained resolver, and the agent is restored as
committed SQL and exposed as an *optional richer path* gated like `canRunDriftTest()` — available in
SPCS and local dev, unavailable on Vercel Hobby, with the UI saying why.

### Latency budget, which shapes the API

One `AI_COMPLETE` today ≈ 4–6s. Adding a narration call in the same request risks 8–12s and breaches
the 10s cap. So narration is a **second endpoint the client calls after the answer renders**: two
short requests instead of one long one, and the chat reads better anyway — numbers land first, prose
follows.

Charts are computed **client-side from the returned rows with deterministic rules**. No LLM, no
latency, reproducible.

## Implementation steps

### Part 1 — Restore the agent assets (full restore)

**Verified queries move into `00e`, not a `GET_DDL` splice.** `sql/07`'s Pattern A is a silent no-op
against a view with no existing `ai_verified_queries` block — which is exactly why only 1 of 38
survived. In a from-scratch build we own `00e`, so the queries are declared inline in the
`CREATE SEMANTIC VIEW` statements. That removes the failure mode rather than asserting around it.
`07` keeps its splice patterns, retitled as the procedure for amending an *already-deployed* view,
with a note that the canonical location is now `00e`.

1. `sql/00e_semantic.sql` — add `ai_verified_queries` blocks to all 8 views, ~38 queries total,
   including the onboarding set and the teaching examples (every inventory query written per
   snapshot to demonstrate the non-additive pattern; `REALIZED_PERFORMANCE_EXCLUDES_FUTURE` encoding
   the as-of rule).
2. `sql/09_agent_eval.sql` — the 60 `AGENT_EVAL_QUESTION` rows: 15 categories, all 14 metrics
   covered, 8 that **must be refused**, 3 ambiguous that must trigger clarification, 4 traps
   (summing a snapshot across months, averaging monthly rates, conflating inbound with outbound).
   Plus the existing integrity check that no `expected_metric_ids` value is absent from the registry.
3. `sql/10_agent.sql` — `SNOWFLAKE_INTELLIGENCE.AGENTS` schema and
   `CREATE OR REPLACE AGENT … COPY GRANTS FROM SPECIFICATION`: `cortex_analyst_text_to_sql` tools
   over the 7 reporting views, a `Metric_Outlook` tool over `SC_OUTLOOK`, `data_to_chart`, and the
   response rules that forbid inventing a forecast, require a prediction to be labelled as one and
   quoted with its backtested accuracy, and warn against calling a prediction good because a
   stationary series flatters the score.
4. `sql/90_verify_base.sql` — add assertions: verified-query count per view (the check that would
   have caught the silent no-op), 60 eval questions, every `expected_metric_ids` resolvable, and the
   agent object exists.
5. `scripts/rebuild.mjs` — register `09` and `10` in `FILES`.

### Part 2 — `/api/ask` becomes conversational

6. **Multi-turn context.** Accept `history: {question, metricIds, dimension}[]` (capped at the last
   6 turns, server-side). The resolver prompt gains a *Conversation so far* block so "now break that
   down by carrier" or "what about EU" resolves against the previous turn. History is
   **re-validated against the registry every turn** — a stale or tampered id is dropped, never
   trusted because it appeared earlier.
7. **Deterministic chart spec.** The route returns a `chart` object chosen from the result shape, not
   by the LLM:

   | Shape | Chart |
   |---|---|
   | no dimension, 1 row | metric cards (current behaviour) |
   | dimension is `calendar.cal_period` / `cal_month` / `cal_date` | line, ordered by period |
   | 1 dimension, 1 metric | horizontal bar |
   | 1 dimension, 2–4 metrics | **small multiples — one bar chart per metric** |
   | > 12 dimension values | top-10 bar + full table |

   **Metrics with different units never share an axis.** A percentage and a dollar total on one scale
   is a misleading chart, so multi-metric answers render as small multiples rather than a grouped bar.
8. **`POST /api/ask/narrate`** — takes the metric metadata and the already-computed rows, returns 2–4
   sentences. It receives *only* the computed values, so it has nothing to invent from.
9. **Numeric guardrail on the narration.** Every numeric token in the returned prose is checked
   against the values actually present in the payload (unit-aware, formatting-tolerant). If any
   number is unaccounted for, the prose is **discarded** and a deterministic template summary is
   rendered instead, with a note. A plausible fabricated figure in a governed product is worse than no
   prose.
10. **Log every turn** to `GOVERNANCE.AGENT_QUESTION_LOG` — question, resolved ids, view, persona,
    refusal, latency. That table and `AGENT_IMPROVEMENT_CANDIDATE` are already deployed and have
    never received traffic; this closes roadmap item 6 as a side effect.

### Part 3 — Chat UI (replaces the single-shot panel)

11. `components/ask-chat.tsx` — transcript of turns, sticky composer, `Enter` to send. Each assistant
    turn renders: prose (streamed in when `/narrate` returns) → chart → collapsible table →
    collapsible provenance (generated SQL, grain, owner, drill-down). Refusals render as a turn, not
    as an error banner, and keep the suggestion chips.
12. `components/ask-charts.tsx` — the three chart shapes. Reuses `OperationsCharts` for bars and
    Recharts + `chart-utils.tsx` (`getYAxisWidth`, `ChartTooltip`) for the line, so axis clipping and
    dark-mode tooltips are already handled.
13. Persona and period stay pinned above the transcript, and **each turn records the persona and
    period it ran under** — scrolling back must not misattribute an older answer to the current
    persona.
14. `components/ask-console.tsx` is deleted; `app/ask/page.tsx` renders the chat.
15. When the agent path is unavailable (`isVercel()`), the UI states that the governed resolver is in
    use and why — the same honesty pattern as the drift-test button.

## Verification

- `npm test` — extend `__tests__/api/ask.test.ts` for: history re-validation drops an unregistered
  id; chart selection per shape; mixed units never produce a shared axis; **narration containing an
  invented number is rejected**; refusal still refuses. Add `__tests__/api/narrate.test.ts`.
- `node scripts/rebuild.mjs --verify` — 86 → ~92 checks, all PASS, including the verified-query
  counts that would have caught the original silent no-op.
- `CALL GOVERNANCE.METRIC_DRIFT_TEST()` — **must stay 14/14 with zero spread.** Adding
  `ai_verified_queries` to `00e` rewrites every view, so this is the proof no metric expression was
  disturbed.
- `npm run smoke` — 21/21 must still pass; update the two `/api/ask` checks for the new payload.
  Add a multi-turn check: ask, then "break that down by product family", and assert the second turn
  resolves to the same metric with a dimension.
- `node scripts/smoke-outlook.mjs`, `scripts/probe-asof.mjs` unchanged.
- Measure `/api/ask` and `/api/ask/narrate` **against the Vercel deployment** and confirm each stays
  under 10s. If narration cannot, it degrades to the template summary rather than failing the turn.
- Browser check of `/ask`: multi-turn, chart renders, provenance opens, refusal renders as a turn.
- Update `README.md` — replace the "Honest status" call-out with the restored counts, and document
  the chat architecture and the 10s constraint that drove it.

## Risks

- **Rewriting all 8 semantic views** to add verified queries is the largest risk in this plan. The
  drift gate is the control, and `00e` → `01` ordering is already enforced by the runner.
- **Narration latency on Hobby.** Mitigated by the separate endpoint and the template fallback.
- **The agent cannot be exercised from the Vercel demo.** It will be created, verified via SQL
  (`DESCRIBE AGENT`, plus a `DATA_AGENT_RUN` smoke from the CLI), and surfaced in the UI as
  available only off Hobby.

## Critical files

- [app/api/ask/route.ts](app/api/ask/route.ts) - resolver, history handling, chart spec
- [components/ask-console.tsx](components/ask-console.tsx) - replaced by the chat transcript
- [sql/00e_semantic.sql](sql/00e_semantic.sql) - verified queries move here; riskiest edit
- [lib/env.ts](lib/env.ts) - the 10s gate that decides what runs where
- [sql/90_verify_base.sql](sql/90_verify_base.sql) - assertions that make the restore self-checking
