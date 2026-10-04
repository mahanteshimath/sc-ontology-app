# Adopting the ontology on real source data

The demo runs on synthetic ERP, TMS, CRM and IoT feeds, but none of the governed layers know that.
They read `CANONICAL` facts and `SEMANTIC` views. Moving to real data means replacing what feeds
`CANONICAL`, and nothing above it. The registry, semantic views, drift test, persona roles, row
access, masking and the conversational layer all stay unchanged.

## Where real data plugs in

```
SAP EKBE / LIKP, TMS, CRM, IoT  ──►  SOURCE_SYSTEMS.*  ──►  CANONICAL.FCT_*  ──►  SEMANTIC.SC_*  ──►  app / Agent / MCP
  (Openflow, Snowpipe,              source-shaped         one row per          governed          unchanged
   data share, Iceberg)             views                 business event       metrics
                       GOVERNANCE.SOURCE_ATTRIBUTE_MAP documents every hop
```

`GOVERNANCE.SOURCE_ATTRIBUTE_MAP` already records, for each source attribute, the ontology reference
it lands on and the transformation applied. Live rows from the demo account:

| SOURCE_SYSTEM | SOURCE_OBJECT | SOURCE_ATTRIBUTE | ONTOLOGY_REF | TRANSFORMATION |
|---|---|---|---|---|
| ERP | ERP_EKBE_GOODS_RECEIPT | LIFNR | supplier.supplier_id | identity |
| ERP | ERP_EKBE_GOODS_RECEIPT | MATNR | part.material_id | identity |
| ERP | ERP_EKBE_GOODS_RECEIPT | EINDT | purchase_order.promised_date | `TO_DATE(EINDT, 'YYYYMMDD')` |
| ERP | ERP_EKBE_GOODS_RECEIPT | BUDAT | purchase_order.receipt_date | `TO_DATE(BUDAT, 'YYYYMMDD')` |
| ERP | ERP_EKBE_GOODS_RECEIPT | MENGE | purchase_order.received_qty | identity |
| TMS | TMS_DELIVERY_EVENT | SHPMT_REF | order_fulfillment.(order_id, order_line) | `SPLIT_PART(SHPMT_REF, '-', n)` |

## Steps (worked example: SAP goods receipts → supplier OTD)

1. **Land the source.** Replicate SAP `EKBE` (and `EKET` for the promised date) with an Openflow SAP
   connector or a partner data share into a landing schema. Keep the native column names (`LIFNR`,
   `MATNR`, `EINDT`, `BUDAT`, `MENGE`) so the attribute map stays a literal description.
2. **Repoint the source view.** Replace the synthetic body of `SOURCE_SYSTEMS.ERP_EKBE_GOODS_RECEIPT`
   with a `SELECT` over the landed table. Its columns must not change.
3. **Rebuild the canonical fact.** `CANONICAL.FCT_SUPPLIER_DELIVERY_LINE` derives `IS_ON_TIME`,
   `IS_IN_FULL` and the variance columns from the mapped attributes. Make it a dynamic table with a
   target lag (for example 1 hour) so it refreshes incrementally as receipts land.
4. **Prove nothing moved.** Run `CALL GOVERNANCE.METRIC_DRIFT_TEST()` and `CALL
   GOVERNANCE.CI_GOVERNANCE_GATE()`. Both bindings of `supplier_otd_pct` must still match the
   registry's independent `canonical_sql` with zero spread. `V_SOURCE_DEFINITION_SPREAD` now shows
   how far the real ERP grace-window definition sits from the governed one.
5. **Map real users.** Add each business user to `GOVERNANCE.PERSONA_USER_MAP`
   (`sql/28_persona_user_map.sql`). Unmapped users are refused, so no one sees data before a steward
   assigns a persona.

## What stays the same

- Metric definitions: `GOVERNANCE.METRIC_DEFINITION` (15 metrics) and the 12 semantic views.
- Persona scope: `RAP_SHIP_REGION` and the `MATERIAL_COST` masking policy, which apply in `/api/ask`,
  `/api/drilldown` and `/api/consistency`.
- Evaluation: the 60-question golden set (`npm run eval`) re-scores the conversational layer on the
  real data.

## Scaling notes

- Facts are append-mostly and keyed by business event, so moving from millions to billions of rows
  is a warehouse-size and clustering decision (cluster on the date column). The semantic layer is
  unaffected.
- A new domain (for example returns or quality notifications) adds one `CANONICAL.FCT_*`, one domain
  semantic view, its metric rows and two bindings. The drift test covers it automatically.
