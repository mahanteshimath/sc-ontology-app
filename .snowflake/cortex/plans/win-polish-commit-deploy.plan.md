## Context
- Repo on `main`, remote `git@github.com:mahanteshimath/sc-ontology-app.git` (SSH), already linked to Vercel (`.vercel` exists). Git identity is already `mahanteshimath` / `mahanteshimath@gmail.com`; the request says user name "Mahantesh", so I will set the name/email on the commit only (`git -c user.name=... -c user.email=...`), not change global config.
- Uncommitted: `app/api/ask/route.ts` and `components/ask-chat.tsx` (ontology-boundary fix, verified locally, 203 tests + tsc pass), plus unrelated edits (README, deck html, sql/10_agent.sql, next-env.d.ts, tsbuildinfo) and untracked `.cortex/`, `.playwright-mcp/`, `videos/`, `docs/SUBMISSION_DECK.pdf`.
- Live-app review found: raw SQL crash on supplier x landed cost (fixed), narration says "16 categories" for 300 rows, persona picker locked on /ask, README/UI count mismatches (10.76M vs 6.1M rows, VQ/tool/relationship counts), no masking policy despite README claim.

## Implementation steps
1. Narration: make `/api/ask/narrate` describe the full row count (or say "top N shown"); unlock the persona select in `components/ask-chat.tsx` so judges can re-ask as Planner / Procurement / Logistics / EU.
2. Governance: add a masking policy (e.g. supplier/standard cost hidden from `SC_LOGISTICS`) in a new numbered SQL file, apply it, and surface it on /consistency. Requires running DDL on your Snowflake account (needs your approval at execution time). Reconcile README counts against live queries.
3. "Why this number" panel: show definition, owner, certification, view, SQL and freshness per answer, from data already returned by `/api/ask`.
4. Run 15-20 judge-style cross-domain questions on localhost:3005 across personas; fix any failing path the same way as the boundary check.
5. Hygiene: do not commit `.cortex/`, `.playwright-mcp/`, `videos/`, `tsbuildinfo`, `next-env.d.ts` (add to `.gitignore` where appropriate). Commit in logical commits with identity Mahantesh / mahanteshimath@gmail.com.
6. `git push origin main` over SSH, then deploy with `vercel --prod` (or auto-deploy from the push); verify the live `/ask` question and sign-in.

## Verification
- `npx tsc --noEmit`, `npx vitest run` (203 pass), local browser run of the failing question and persona switch, then the same on the Vercel URL.

## Decisions I need from you at execution
- Confirm I may run the masking-policy DDL on PJRTYEL-AZ37563.
- Confirm untracked videos/PDF/.cortex should be excluded from the commit.

## Critical Files
- app/api/ask/route.ts - boundary check, trust payload
- components/ask-chat.tsx - persona picker, boundary note, trust panel
- app/api/ask/narrate/route.ts - row-count wording
- sql/00f_governance.sql - masking policy home
- README.md - count reconciliation