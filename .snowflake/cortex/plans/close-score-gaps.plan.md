# Plan: close every gap from the evaluation

**Starting score: 84/100**
- Relevance: 26/30, lost 4
- Technical execution: 32/40, lost 8
- Completeness: 26/30, lost 4

Each workstream below fixes one deduction.

## A. Technical execution (+8)

1. **Cortex Analyst path** (+2)
   - Add a new route, `app/api/ask/analyst/route.ts`. It calls the Cortex Analyst REST API (`/api/v2/cortex/analyst/message`) with `semantic_view: SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360`.
   - Run the generated SQL through `runAsRole` (`lib/persona.ts`) so the persona's row access policy still applies.
   - In `/ask`, add a toggle between "Registry engine" and "Cortex Analyst", and an "Agreement" badge that compares the two answers.
   - Extend `scripts/parity.mjs` to compare Analyst, the registry route and the Agent across all 39 verified queries. Store the results in `GOVERNANCE.PARITY_RESULT`.
   - Keep the existing explanation of why the registry route is the default, which is the 10-second limit and default-role resolution.

2. **Harden drill-down SQL** (+2)
   - In `app/api/drilldown/route.ts`, check `rule.orderBy` against `^[A-Za-z_]\w*( (ASC|DESC))?(, ...)*$`, and require each column to be in `columns`.
   - Check `rule.exceptionWhere` against a deny-list: `;`, `--`, `/*` and DDL/DML keywords. Or replace it with a structured rule of the form `{column, op, value}` with values bound.
   - Add vitest cases that confirm a rule containing injection text is rejected.

3. **Least privilege** (+2)
   - Create the role `SC_APP_SERVICE` in `sql/00a_foundation.sql`. It gets USAGE on the warehouse, database and schemas, plus the persona roles granted to it so `USE ROLE` works.
   - Change the default `SNOWFLAKE_ROLE` in `.env.example`, `app.yml` and the Vercel env script from ACCOUNTADMIN to SC_APP_SERVICE.
   - Change the SQL scripts so ACCOUNTADMIN is used only for account-level objects. Create everything else as SYSADMIN or the steward role.

4. **Make the build re-runnable** (+1)
   - Fold the CALENDAR and TELEMETRY entities directly into `00e_semantic.sql`, and remove the string-replace step in `sql/01`.
   - Confirm `scripts/rebuild.mjs` gives the same result when run twice.

5. **Masking policy** (+1)
   - Create `MP_UNIT_COST` on `UNIT_PRICE` and `LANDED_COST_USD`. Logistics roles see the column masked; procurement and steward see it in full.
   - Add a tag-based classification, `SC_SENSITIVITY` set to CONFIDENTIAL.
   - On `/consistency`, show one masked cell next to an unmasked one as proof.

## B. Real-world relevance (+4)

6. **Make the literal ontology chain explicit**
   - Add Plant as a role of the NODE entity, plus first-class `SHIPMENT` and `CUSTOMER_ORDER` logical tables in `SC_ONTOLOGY_360`.
   - The relationships should read Supplier→Part→Plant→Shipment→Order→Customer.
   - Render this chain as a graph at the top of `/ontology`.

7. **Simulated source-system ingestion**
   - Seed RAW tables tagged with their source, `ERP_SAP` and `TMS` and `IOT`, each with different column names and units.
   - Show the mapping into CANONICAL on `/ontology` with a "3 sources → 1 definition" panel. This makes the pain the brief describes visible.

8. **Measured impact**
   - Time a scripted benchmark. Compare manual answering, using a stopwatch on SQL written by hand, with the app, for 10 questions.
   - Record the accuracy of the raw-column LLM against the semantic view: Analyst on raw tables versus on the semantic view, using the same 39 questions.
   - Publish the real numbers in `/impact` and the deck, replacing the self-reported claims.

## C. Solution completeness (+4)

9. **Submission polish**
   - In the README, fix the line "Finally this is just not MVP its real world solution…".
   - Confirm and finalise the table mapping CoCo skills to architecture layers: semantic-view, cortex-agent, data-governance, data-quality, snowflake-apps, sql-author.
   - Rebuild the architecture diagram as a single PNG for the deck. It must show data flow, skills, sources and modules.

10. **Hygiene**
    - Delete `.playwright-mcp/` and add it to `.gitignore`.
    - Remove the `LIVE_*` and `ALL_COMBINED` dumps, or move them to `sql/snapshots/`.

11. **Judge experience**
    - On `/login`, add one-click persona buttons for the demo, or print the credentials on the deck's first slide.
    - Add a 3-minute guided tour at `/tour`: persona switch → same metric → drill-down → Analyst agreement → masking.

12. **Verify everything**
    - Run `npm test`, `npm run persona-proof`, `parity.mjs` and `sql/93_verify_verified_queries.sql`.
    - Paste the live outputs into the deck as screenshots, so the figures come from real runs rather than the README.

## Order of work
Do A2 and A3 first, since they are quick security fixes. Then A1, then B6 and B7, then A4 and A5, then B8, then C9 through C12.
