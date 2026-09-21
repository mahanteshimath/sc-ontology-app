# Plan: Make Governed Prediction Features First-Class Across the UI/UX

## Motivation & Architecture
Predictions currently live on the dedicated `/outlook` page and in the `V_METRIC_OUTLOOK` view. To make predictive capabilities a natural part of daily decision-making across the entire application, predictions must be surfaced in context alongside realized performance while maintaining the core governance rule: **A prediction is NOT a measurement (`as_of_scope: PREDICTED`), and must always be distinguished from realized metrics and displayed with its backtested accuracy**.

---

## Planned Enhancements Across the UI/UX

### 1. Executive Overview (`app/page.tsx`)
- **Forward Outlook & Risk Section**: Add an executive forward-risk banner/section directly on the main dashboard.
- **Metric-Level Outlook Badges**: For headline metrics (`otd_pct` and `fill_rate_pct`), surface their next-month breach status and risk breakdown by product family right alongside their realized historical values.
- **Volume Forecast Snapshot**: Display the 3-month order-line forecast card on the Overview with a direct link to the full `/outlook` page.

### 2. Metric Registry (`app/metrics/page.tsx`)
- **Outlook Indicators in Metric Rows**: Add a "Governed Outlook" badge to metrics with active predictions in `V_METRIC_OUTLOOK` (`otd_pct`, `fill_rate_pct`, `order_line_count`).
- **Deep-Dive Prediction Drawer**: Inside the expanded `<details>` disclosure for predicted metrics, add a dedicated "Forward Outlook & Target Reachability" panel showing:
  - Expected value vs. Target value
  - Target breach probability & z-score
  - Method used (`TARGET_BREACH`, `ML_FORECAST`, `ANOMALY`) & backtested accuracy (e.g. 99.8%)
  - Plain-language governance basis and limitations

### 3. Ask Conversational Console (`app/ask/page.tsx` & `components/ask-console.tsx`)
- **Prediction Sample Queries**: Add one-click sample question chips for forward-looking analysis:
  - *"Which product families will miss their on-time delivery target next month?"*
  - *"Is fill rate at risk of missing target next month?"*
  - *"What order-line volume should we plan for over the next few months?"*
  - *"How accurate are our predictions on held-out data?"*
- **Prediction Resolution & Provenance**: Ensure forward-looking questions map cleanly to `SC_OUTLOOK` and return with confidence and backtest provenance.

### 4. Interactive Target Reachability Explorer (`components/target-simulator.tsx` on `/outlook`)
- **Interactive Simulation Tool**: Add an interactive client widget on the Outlook page where planners can adjust target levels (e.g. test 88%, 90%, 92%, 95% OTD) to see real-time z-scores and breach probabilities computed via the governed model.
- **Volume Forecast Visual Bars**: Render the upcoming 3-month forecast with visual range bars showing the 95% confidence intervals.

---

## Verification Plan
1. **Typecheck & Build**: Run `npx tsc --noEmit` and `npm run build` to ensure all components and pages compile cleanly.
2. **Automated Smoke Tests**: Run `node scripts/smoke.mjs` and `node scripts/smoke-outlook.mjs` to verify all routes render 200 with data.
3. **Browser Verification**: Inspect the Overview, Metric Registry, Ask Console, and Outlook pages to confirm contrast, responsiveness, and dark-mode compliance.
4. **Deploy & Production Smoke**: Deploy via `vercel deploy --prod --yes --scope hackermontys-projects` and verify the live production app.
