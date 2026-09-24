-- ============================================================================
-- LIVE_DDL_EXTRACT.sql — actual deployed DDL, pulled live from SUPPLY_CHAIN
-- via GET_DDL('DATABASE', 'SUPPLY_CHAIN', true) on 2026-09-24T07:34:41.825Z.
-- This is the account's ground truth, not the sql/*.sql source files.
-- ============================================================================

create or replace database SUPPLY_CHAIN COMMENT='Supply Chain Ontology. Governed conversational analytics: every number in the app and in the conversational layer resolves to a metric defined in SEMANTIC, registered in GOVERNANCE, and reconcilable to an atomic fact in CANONICAL.';

create or replace schema SUPPLY_CHAIN.APPS COMMENT='Holds the deployed APPLICATION SERVICE (see app.yml).';

create or replace schema SUPPLY_CHAIN.CANONICAL COMMENT='Atomic-grain conformed facts. One row per business event. These are the reconciliation target: every governed metric carries the SQL that computes it from exactly one of these tables, and the drift test asserts the semantic views agree with that SQL.';

create or replace TABLE SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT (
	SNAPSHOT_DATE DATE NOT NULL COMMENT 'Month-end the balance was observed. Exactly 24 distinct values. Not additive across periods.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family.',
	BUSINESS_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Reporting segment.',
	ABC_CLASS VARCHAR(16777216) NOT NULL COMMENT 'Inventory value class.',
	NODE_ID VARCHAR(16777216) NOT NULL COMMENT 'Stocking location code.',
	NODE_NAME VARCHAR(16777216) NOT NULL COMMENT 'Stocking location name.',
	NODE_REGION VARCHAR(16777216) NOT NULL COMMENT 'Region the node serves.',
	ON_HAND_QTY NUMBER(38,0) NOT NULL COMMENT 'Units on hand.',
	AVG_DAILY_DEMAND NUMBER(12,3) NOT NULL COMMENT 'Trailing average daily demand. Denominator of days of inventory.',
	SAFETY_STOCK NUMBER(38,0) NOT NULL COMMENT 'Target safety stock.',
	ATP_QTY NUMBER(38,0) NOT NULL COMMENT 'Available to promise.',
	IS_STOCKED_OUT NUMBER(1,0) NOT NULL COMMENT '1 when nothing is available to promise.',
	INVENTORY_VALUE NUMBER(16,2) NOT NULL COMMENT 'On-hand quantity at standard cost. Standard rather than moving-average cost, so that value moves only when quantity does.',
	constraint PK_FCT_INVENTORY_SNAPSHOT primary key (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
)COMMENT='Atomic month-end inventory positions. Canonical source for days of inventory and inventory value. A snapshot: never sum across snapshot dates.'
;
create or replace TABLE SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT (
	SHIPMENT_ID VARCHAR(16777216) NOT NULL COMMENT 'Shipment number.',
	ORDER_ID VARCHAR(16777216) NOT NULL COMMENT 'Sales order.',
	ORDER_LINE NUMBER(38,0) NOT NULL COMMENT 'Sales order line.',
	CARRIER VARCHAR(16777216) NOT NULL COMMENT 'Carrier name.',
	LANE_ID VARCHAR(16777216) NOT NULL COMMENT 'Lane used.',
	SERVICE_LEVEL VARCHAR(16777216) NOT NULL COMMENT 'Committed service level.',
	SHIP_REGION VARCHAR(16777216) NOT NULL COMMENT 'Destination region. Scoped by the EU row access policy.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material shipped.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family.',
	BUSINESS_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Reporting segment.',
	SHIPPED_QTY NUMBER(38,0) NOT NULL COMMENT 'Units shipped. Denominator of landed cost per unit.',
	DELIVERY_DATE DATE NOT NULL COMMENT 'Delivery date. The event date for landed-cost reporting.',
	MATERIAL_COST NUMBER(14,2) NOT NULL COMMENT 'Standard cost times quantity.',
	FREIGHT_COST NUMBER(14,2) NOT NULL COMMENT 'Accrued freight.',
	INVOICED_FREIGHT_AMT NUMBER(14,2) NOT NULL COMMENT 'Freight the carrier invoiced.',
	FREIGHT_BILL_VAR_AMT NUMBER(14,2) NOT NULL COMMENT 'Invoiced less accrued. Positive is carrier overbilling.',
	ACCESSORIAL_USD NUMBER(14,2) NOT NULL COMMENT 'Accessorial charges. Deliberately excluded from TOTAL_LANDED_COST: they are billed separately from the landed cost of goods.',
	DUTY_COST NUMBER(14,2) NOT NULL COMMENT 'Duty on cross-region movements.',
	HANDLING_COST NUMBER(14,2) NOT NULL COMMENT 'Warehouse handling.',
	TOTAL_LANDED_COST NUMBER(14,2) NOT NULL COMMENT 'Material + freight + duty + handling. Stored rather than derived so the drill-down can order on it.',
	IS_PREMIUM_FREIGHT NUMBER(1,0) NOT NULL COMMENT '1 where an expedited service level was used.',
	constraint PK_FCT_LANDED_COST_SHIPMENT primary key (SHIPMENT_ID)
) WITH ROW ACCESS POLICY SUPPLY_CHAIN.GOVERNANCE.RAP_SHIP_REGION ON (SHIP_REGION)
COMMENT='Atomic landed cost per shipment. Canonical source for landed cost per unit, freight cost, freight invoiced and freight bill variance.'
;
create or replace TABLE SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT (
	ORDER_ID VARCHAR(16777216) NOT NULL COMMENT 'Sales order number.',
	ORDER_LINE NUMBER(38,0) NOT NULL COMMENT 'Line number within the sales order.',
	CUSTOMER_ID VARCHAR(16777216) NOT NULL COMMENT 'Ship-to customer.',
	CUSTOMER_NAME VARCHAR(16777216) NOT NULL COMMENT 'Customer name.',
	CUSTOMER_REGION VARCHAR(16777216) NOT NULL COMMENT 'Region the account is managed in.',
	CUSTOMER_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Go-to-market segment.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material ordered.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family.',
	BUSINESS_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Reporting segment.',
	CARRIER VARCHAR(16777216) NOT NULL COMMENT 'Carrier name. The name rather than the code, because this column is both grouped on and displayed.',
	LANE_ID VARCHAR(16777216) NOT NULL COMMENT 'Transport lane.',
	SHIP_REGION VARCHAR(16777216) NOT NULL COMMENT 'Destination region. The row access policy for SC_LOGISTICS_EU scopes on this column.',
	PROMISE_DATE DATE NOT NULL COMMENT 'Date promised to the customer.',
	DELIVERY_DATE DATE NOT NULL COMMENT 'Date delivered. The event date: reporting periods are applied to this column.',
	TRANSIT_DAYS NUMBER(38,0) NOT NULL COMMENT 'Actual days in transit.',
	DEFECT_REASON VARCHAR(16777216) COMMENT 'Recorded cause on lines that failed a condition. NULL on clean lines.',
	ORDERED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity ordered.',
	SHIPPED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity shipped.',
	IS_ON_TIME NUMBER(1,0) NOT NULL COMMENT '1 when delivered on or before the promise date.',
	IS_IN_FULL NUMBER(1,0) NOT NULL COMMENT '1 when the full ordered quantity shipped.',
	IS_OTIF NUMBER(1,0) NOT NULL COMMENT '1 when on time AND in full. Stored, not recomputed, so one table can serve a different exception predicate per metric.',
	IS_CDDA_MET NUMBER(1,0) NOT NULL COMMENT '1 when the customer accepted the delivery date. Independent of the other conditions.',
	IS_PERFECT_ORDER NUMBER(1,0) NOT NULL COMMENT '1 when OTIF and CDDA both hold. Strictly harder than OTIF, which is what makes it a distinct metric.',
	constraint PK_FCT_ORDER_LINE_FULFILLMENT primary key (ORDER_ID, ORDER_LINE)
) WITH ROW ACCESS POLICY SUPPLY_CHAIN.GOVERNANCE.RAP_SHIP_REGION ON (SHIP_REGION)
COMMENT='Atomic outbound order lines. Canonical source for customer OTD, OTIF, fill rate and perfect order rate.'
;
create or replace TABLE SUPPLY_CHAIN.CANONICAL.FCT_REQUISITION_LINE (
	REQUISITION_ID VARCHAR(16777216) NOT NULL COMMENT 'Requisition number.',
	REQUISITION_LINE NUMBER(38,0) NOT NULL COMMENT 'Line within the requisition.',
	PO_ID VARCHAR(16777216) NOT NULL COMMENT 'Purchase order the requisition converted into.',
	LINE NUMBER(38,0) NOT NULL COMMENT 'Purchase order line.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material requested.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family.',
	SUPPLIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Vendor the requisition was sourced to.',
	SUPPLIER_REGION VARCHAR(16777216) NOT NULL COMMENT 'Sourcing region.',
	REQUESTED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity requested.',
	REQUISITION_DATE DATE NOT NULL COMMENT 'Date the requisition was raised. The event date.',
	PROMISED_DATE DATE NOT NULL COMMENT 'Date subsequently committed by the supplier.',
	LEAD_TIME_DAYS NUMBER(38,0) NOT NULL COMMENT 'Days from requisition to promised delivery.',
	constraint PK_FCT_REQUISITION_LINE primary key (REQUISITION_ID, REQUISITION_LINE)
)COMMENT='Atomic requisition lines: the demand signal upstream of a purchase order. Adds requisition lead time over the receipt grain.'
;
create or replace TABLE SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE (
	PO_ID VARCHAR(16777216) NOT NULL COMMENT 'Purchase order number.',
	LINE NUMBER(38,0) NOT NULL COMMENT 'Line number within the purchase order.',
	SUPPLIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Vendor number.',
	SUPPLIER_NAME VARCHAR(16777216) NOT NULL COMMENT 'Vendor name.',
	SUPPLIER_REGION VARCHAR(16777216) NOT NULL COMMENT 'Sourcing region.',
	SUPPLIER_GROUP VARCHAR(16777216) NOT NULL COMMENT 'Commodity group.',
	SUPPLIER_TIER VARCHAR(16777216) NOT NULL COMMENT 'Strategic tier.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material received.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family of the material.',
	BUSINESS_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Reporting segment.',
	ABC_CLASS VARCHAR(16777216) NOT NULL COMMENT 'Inventory value class of the material.',
	PROMISED_DATE DATE NOT NULL COMMENT 'Date the supplier committed to.',
	RECEIPT_DATE DATE NOT NULL COMMENT 'Date goods were received. The event date: reporting periods are applied to this column.',
	RECEIPT_VARIANCE_DAYS NUMBER(38,0) NOT NULL COMMENT 'Receipt date minus promised date. Positive is late, negative is early.',
	ORDERED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity ordered.',
	RECEIVED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity received.',
	IS_ON_TIME NUMBER(1,0) NOT NULL COMMENT '1 when received on or before the promised date. Numeric, not boolean: the exception rules compare it to 0 and the metrics average it.',
	IS_IN_FULL NUMBER(1,0) NOT NULL COMMENT '1 when the received quantity met the ordered quantity.',
	STANDARD_PRICE NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost.',
	ACTUAL_PRICE NUMBER(12,4) NOT NULL COMMENT 'Unit price invoiced.',
	UNIT_PRICE_VARIANCE NUMBER(12,4) NOT NULL COMMENT 'Actual less standard, per unit. Positive is unfavourable.',
	EXTENDED_PRICE_VARIANCE NUMBER(16,4) NOT NULL COMMENT 'Unit variance times received quantity: the realised dollar impact. Deliberately on received, not ordered, quantity.',
	constraint PK_FCT_SUPPLIER_DELIVERY_LINE primary key (PO_ID, LINE)
)COMMENT='Atomic inbound receipt lines. Canonical source for supplier OTD, supplier fill rate and purchase price variance.'
;
create or replace view SUPPLY_CHAIN.CANONICAL.V_SUPPLIER_OTD_BY_MONTH(
	SUPPLIER_ID,
	SUPPLIER_NAME,
	SUPPLIER_REGION,
	MONTH_START,
	OTD_RATE,
	LINE_COUNT
) COMMENT='Supplier on-time rate pre-aggregated per supplier per month. Exists ONLY to back SEMANTIC.SC_SUPPLIER_LEGACY_DEFECT, the deliberately-defective negative control. Do not build a governed metric on this: averaging a rate that is already a rate discards line weighting.'
 as
SELECT
  supplier_id,
  supplier_name,
  supplier_region,
  DATE_TRUNC('MONTH', receipt_date)          AS month_start,
  AVG(is_on_time)                            AS otd_rate,
  COUNT(*)                                   AS line_count
FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
GROUP BY supplier_id, supplier_name, supplier_region, DATE_TRUNC('MONTH', receipt_date);
create or replace schema SUPPLY_CHAIN.GOVERNANCE COMMENT='Metric registry, ontology catalogue, drift control, persona scoping. Admin-owned: EXCEPTION_WHERE and ORDER_BY from METRIC_EXCEPTION_RULE are interpolated into SQL by the drill-down route, which is safe only because no application role can write here.';

create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.AGENT_EVAL_QUESTION (
	QUESTION_ID VARCHAR(16777216) NOT NULL,
	CATEGORY VARCHAR(16777216) NOT NULL,
	PERSONA_ROLE VARCHAR(16777216),
	QUESTION VARCHAR(16777216) NOT NULL,
	SHOULD_ANSWER BOOLEAN NOT NULL,
	EXPECTED_METRIC_IDS VARCHAR(16777216),
	EXPECTED_TOOL VARCHAR(16777216),
	EXPECTED_BEHAVIOUR VARCHAR(16777216),
	ADDED_ON DATE DEFAULT CURRENT_DATE(),
	constraint PK_AGENT_EVAL_QUESTION primary key (QUESTION_ID)
)COMMENT='Golden question set for measuring conversational accuracy. A question with should_answer = FALSE must be refused, not answered.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.AGENT_QUESTION_LOG (
	ASKED_AT TIMESTAMP_LTZ(9) DEFAULT CURRENT_TIMESTAMP(),
	SOURCE VARCHAR(16777216) COMMENT 'Which surface asked: app, agent, evaluation harness.',
	PERSONA_ROLE VARCHAR(16777216) COMMENT 'Role in effect.',
	QUESTION VARCHAR(16777216) COMMENT 'Question as asked.',
	RESOLVED_METRIC_IDS VARCHAR(16777216) COMMENT 'Pipe-delimited metric ids resolved to.',
	SEMANTIC_VIEW VARCHAR(16777216) COMMENT 'View chosen.',
	REFUSED BOOLEAN COMMENT 'TRUE when the question was declined.',
	REFUSAL_REASON VARCHAR(16777216) COMMENT 'Why it was declined.',
	LATENCY_MS NUMBER(38,0) COMMENT 'End-to-end latency.',
	USER_CORRECTED BOOLEAN COMMENT 'TRUE when the user corrected the answer.',
	CORRECTION_NOTE VARCHAR(16777216) COMMENT 'What the user said was wrong.'
)COMMENT='Every question asked of the conversational layer. Real questions are a better source of the next synonym or verified query than imagined ones.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING (
	METRIC_ID VARCHAR(16777216) NOT NULL COMMENT 'Metric being exposed.',
	SEMANTIC_VIEW VARCHAR(16777216) NOT NULL COMMENT 'Unqualified semantic view name.',
	METRIC_REFERENCE VARCHAR(16777216) NOT NULL COMMENT 'Entity-qualified metric reference as written inside SEMANTIC_VIEW(...), e.g. purchase_order.supplier_otd_pct. The drift test derives the output column name from the segment after the dot.',
	PERSONA_ROLE VARCHAR(16777216) COMMENT 'Persona this binding serves, where the binding exists for one. NEGATIVE_CONTROL marks a binding that is expected to disagree.',
	constraint PK_METRIC_BINDING primary key (METRIC_ID, SEMANTIC_VIEW, METRIC_REFERENCE)
)COMMENT='Maps each governed metric to every semantic view that exposes it. A metric with two or more bindings is testable for drift; a metric with one is not.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION (
	METRIC_ID VARCHAR(16777216) NOT NULL COMMENT 'Stable identifier. Referenced by METRIC_BINDING, METRIC_EXCEPTION_RULE, the evaluation set and the prediction layer.',
	BUSINESS_NAME VARCHAR(16777216) NOT NULL COMMENT 'Name a business reader would use.',
	DOMAIN VARCHAR(16777216) NOT NULL COMMENT 'Supply chain domain the metric belongs to.',
	DEFINITION VARCHAR(16777216) NOT NULL COMMENT 'Plain-language definition. The authoritative wording: the semantic view comments restate this, they do not extend it.',
	NUMERATOR VARCHAR(16777216) COMMENT 'Numerator in words, for rates and ratios. NULL for sums.',
	DENOMINATOR VARCHAR(16777216) COMMENT 'Denominator in words. NULL for sums. Naming it explicitly is what distinguishes a line-weighted rate from an average of rates.',
	GRAIN VARCHAR(16777216) NOT NULL COMMENT 'Atomic grain the metric is computed over. 02_as_of_rule.sql switches on this value: material_node_snapshot becomes SNAPSHOT, everything else REALIZED.',
	CANONICAL_FACT VARCHAR(16777216) NOT NULL COMMENT 'Schema-qualified atomic fact. Must match METRIC_EXCEPTION_RULE.canonical_fact or the drill-down refuses to run.',
	CANONICAL_SQL VARCHAR(16777216) NOT NULL COMMENT 'Independent SQL computing the metric from the canonical fact. Must return one row, one column, named VAL. This is what the drift test compares every semantic view against.',
	UNIT VARCHAR(16777216) COMMENT 'Unit of the value: ratio, usd, days, count.',
	DIRECTION VARCHAR(16777216) COMMENT 'higher, lower, or to_zero. Determines how targets and thresholds are interpreted.',
	OWNER_ROLE VARCHAR(16777216) COMMENT 'Role accountable for the definition and its target.',
	VERSION NUMBER(38,0) COMMENT 'Definition version. Increment when the meaning changes, not when the wording does.',
	EFFECTIVE_FROM DATE COMMENT 'Date this version took effect.',
	AS_OF_SCOPE VARCHAR(16777216) COMMENT 'REALIZED = event already occurred, must exclude future-dated rows. SNAPSHOT = point-in-time balance, non-additive across periods.',
	AS_OF_RULE VARCHAR(16777216) COMMENT 'The filter or selection rule the application must apply for this metric to be a measure of realized performance.',
	TARGET_VALUE FLOAT COMMENT 'Governed target for this metric, in the same unit as the metric itself.',
	WARN_THRESHOLD FLOAT COMMENT 'Amber boundary. Interpreted using DIRECTION: for higher-is-better a value at or above this is amber, below FAIL_THRESHOLD is red.',
	FAIL_THRESHOLD FLOAT COMMENT 'Red boundary, interpreted using DIRECTION.',
	TARGET_SOURCE VARCHAR(16777216) COMMENT 'Provenance of the target: who set it and on what basis. ILLUSTRATIVE means it was seeded for demonstration and is not a committed business target.',
	constraint PK_METRIC_DEFINITION primary key (METRIC_ID)
)COMMENT='The governed metric catalogue. One row per metric, carrying both the business definition and the canonical SQL that defines it independently of any semantic view.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG (
	DETECTED_AT TIMESTAMP_LTZ(9) NOT NULL,
	RUN_ID VARCHAR(16777216) NOT NULL,
	FAILED_METRICS NUMBER(38,0) NOT NULL,
	MAX_SPREAD FLOAT,
	DETAIL VARCHAR(16777216)
)COMMENT='Append-only log of drift-test runs that contained at least one FAIL. Separate from METRIC_DRIFT_RESULT so the alerting history is not lost if result rows are ever pruned.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_BASELINE (
	METRIC_ID VARCHAR(16777216) COMMENT 'Metric that was diverging.',
	SEMANTIC_VIEW VARCHAR(16777216) COMMENT 'View the value came from.',
	METRIC_REFERENCE VARCHAR(16777216) COMMENT 'Metric reference inside that view.',
	OBSERVED_VALUE FLOAT COMMENT 'Value observed at the time.',
	DEFINITION_SQL VARCHAR(16777216) COMMENT 'Expression that produced it.',
	ROOT_CAUSE VARCHAR(16777216) COMMENT 'Why the two definitions disagreed.',
	CAPTURED_AT TIMESTAMP_LTZ(9) COMMENT 'When the divergence was recorded.',
	NOTE VARCHAR(16777216) COMMENT 'What was done about it.'
)COMMENT='The recorded before-state: two views reporting different numbers for supplier OTD. Kept so the /consistency page can show the problem this project fixed, not merely assert that it is fixed.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_NEGATIVE_CONTROL (
	RUN_AT TIMESTAMP_LTZ(9) COMMENT 'When the control was exercised.',
	METRIC_ID VARCHAR(16777216) COMMENT 'Metric used.',
	BUSINESS_NAME VARCHAR(16777216) COMMENT 'Business name.',
	CANONICAL_VALUE FLOAT COMMENT 'Correct, line-weighted value.',
	MIN_VALUE FLOAT COMMENT 'Lowest value across bindings.',
	MAX_VALUE FLOAT COMMENT 'Highest value across bindings.',
	VALUE_SPREAD FLOAT COMMENT 'Observed disagreement.',
	STATUS VARCHAR(16777216) COMMENT 'Expected to be FAIL. A PASS here would mean the control is not working.',
	DETAIL VARCHAR(16777216) COMMENT 'The competing values.',
	PURPOSE VARCHAR(16777216) COMMENT 'Why this row exists.'
)COMMENT='Evidence that METRIC_DRIFT_TEST is capable of failing. A control that has only ever passed is indistinguishable from one that is not running.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT (
	RUN_ID VARCHAR(16777216) NOT NULL COMMENT 'One UUID per invocation of METRIC_DRIFT_TEST. Select a run by this, never by a time window.',
	RUN_AT TIMESTAMP_LTZ(9) NOT NULL COMMENT 'When the run started.',
	METRIC_ID VARCHAR(16777216) NOT NULL COMMENT 'Metric checked.',
	BUSINESS_NAME VARCHAR(16777216) NOT NULL COMMENT 'Business name, copied so a result is readable without joining.',
	BINDING_COUNT NUMBER(38,0) NOT NULL COMMENT 'Number of semantic-view bindings compared. A count of 1 means the metric is not actually testable.',
	CANONICAL_VALUE FLOAT COMMENT 'Value from CANONICAL_SQL: the independent second opinion.',
	MIN_VALUE FLOAT COMMENT 'Lowest value across the canonical value and all bindings.',
	MAX_VALUE FLOAT COMMENT 'Highest value across the canonical value and all bindings.',
	VALUE_SPREAD FLOAT COMMENT 'max_value - min_value, in the metric unit.',
	RELATIVE_SPREAD FLOAT COMMENT 'value_spread / ABS(canonical_value). What the status is judged on, so that one tolerance works across ratios and dollar totals.',
	STATUS VARCHAR(16777216) NOT NULL COMMENT 'PASS, FAIL, or ERROR when a binding could not be evaluated.',
	DETAIL VARCHAR(16777216) COMMENT 'Per-binding values, or the error, in readable form.'
)COMMENT='One row per metric per drift-test run. The track record of the control, not just its current state.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_EXCEPTION_RULE (
	METRIC_ID VARCHAR(16777216) NOT NULL,
	CANONICAL_FACT VARCHAR(16777216) NOT NULL COMMENT 'Schema-qualified fact the exception rows come from. Must match METRIC_DEFINITION.canonical_fact.',
	DATE_COLUMN VARCHAR(16777216) NOT NULL COMMENT 'Event-date column on the fact, used to apply the reporting period.',
	EXCEPTION_WHERE VARCHAR(16777216) NOT NULL COMMENT 'Predicate identifying the rows that caused the metric to miss. Trusted governance metadata: this schema is admin-owned and is not writable by application roles.',
	DISPLAY_COLUMNS VARCHAR(16777216) NOT NULL COMMENT 'Comma-separated columns to show, in display order. Each is validated against INFORMATION_SCHEMA before use.',
	ORDER_BY VARCHAR(16777216) NOT NULL COMMENT 'Column and direction that puts the worst offenders first.',
	DESCRIPTION VARCHAR(16777216) NOT NULL COMMENT 'What an exception row means, shown above the table.',
	constraint PK_METRIC_EXCEPTION_RULE primary key (METRIC_ID)
)COMMENT='Defines, per governed metric, what an exception row is: the atomic records behind a missed number. Keeping this in the registry rather than in application code means the drill-down and the metric cannot disagree about what counts as a failure.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION (
	PREDICTION_ID VARCHAR(16777216) DEFAULT UUID_STRING(),
	PRODUCED_AT TIMESTAMP_LTZ(9) DEFAULT CURRENT_TIMESTAMP(),
	RUN_ID VARCHAR(16777216),
	METRIC_ID VARCHAR(16777216) NOT NULL,
	METHOD VARCHAR(16777216) NOT NULL,
	MODEL_VERSION VARCHAR(16777216),
	GRAIN_DIMENSION VARCHAR(16777216),
	GRAIN_VALUE VARCHAR(16777216),
	AS_OF DATE NOT NULL,
	HORIZON_PERIOD VARCHAR(16777216),
	PREDICTED_VALUE FLOAT,
	LOWER_BOUND FLOAT,
	UPPER_BOUND FLOAT,
	BREACH_PROBABILITY FLOAT,
	TARGET_VALUE FLOAT,
	BASIS VARCHAR(16777216)
);
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.PERSONA_DEFINITION (
	ROLE_NAME VARCHAR(16777216) NOT NULL COMMENT 'Snowflake role the application assumes for this persona.',
	PERSONA_LABEL VARCHAR(16777216) NOT NULL COMMENT 'Display name.',
	FOCUS VARCHAR(16777216) NOT NULL COMMENT 'What this persona is accountable for.',
	SORT_ORDER NUMBER(38,0) NOT NULL COMMENT 'Display order.',
	ROW_SCOPE VARCHAR(16777216) NOT NULL COMMENT 'Row scope in words. MUST be the exact literal \"ALL REGIONS\" for an unrestricted persona: app/api/consistency/route.ts compares against that string to decide which personas are comparable. Anything else, and the metric reads as UNPROVEN.',
	constraint PK_PERSONA_DEFINITION primary key (ROLE_NAME)
)COMMENT='The personas the application can assume. One row per Snowflake role.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE (
	ROLE_NAME VARCHAR(16777216) NOT NULL COMMENT 'Role to restrict.',
	REGION_VALUE VARCHAR(16777216) NOT NULL COMMENT 'Region value the role may see. A role absent from this table sees all regions.',
	constraint PK_PERSONA_REGION_SCOPE primary key (ROLE_NAME, REGION_VALUE)
)COMMENT='Row-scope mapping consumed by RAP_SHIP_REGION. Adding a regional persona is an INSERT here, not a policy edit.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS (
	ROLE_NAME VARCHAR(16777216) NOT NULL COMMENT 'Persona role.',
	SEMANTIC_VIEW VARCHAR(16777216) NOT NULL COMMENT 'Semantic view the role may query. Must correspond to an actual GRANT in 00e.',
	constraint PK_PERSONA_VIEW_ACCESS primary key (ROLE_NAME, SEMANTIC_VIEW)
)COMMENT='Which semantic views each persona may query. Mirrors the grants issued in 00e: a row here with no matching grant makes the conversational layer offer a tool that fails.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST (
	SCORED_AT TIMESTAMP_LTZ(9) DEFAULT CURRENT_TIMESTAMP(),
	METHOD VARCHAR(16777216) NOT NULL,
	METRIC_ID VARCHAR(16777216) NOT NULL,
	GRAIN_DIMENSION VARCHAR(16777216),
	HOLDOUT_PERIODS NUMBER(38,0),
	OBSERVATIONS NUMBER(38,0),
	FORECAST_ACCURACY FLOAT,
	MAPE FLOAT,
	FORECAST_BIAS FLOAT,
	BENCHMARK_NAME VARCHAR(16777216),
	BENCHMARK_ACCURACY FLOAT,
	BEATS_BENCHMARK BOOLEAN,
	VERDICT VARCHAR(16777216)
);
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.VERIFIED_QUERY_CHECK (
	CHECKED_AT TIMESTAMP_LTZ(9),
	SEMANTIC_VIEW VARCHAR(16777216),
	QUERY_INDEX NUMBER(38,0),
	STATUS VARCHAR(16777216) COMMENT 'PASS or FAIL.',
	ROWS_RETURNED NUMBER(38,0),
	ERROR VARCHAR(16777216),
	QUERY_SQL VARCHAR(16777216)
)COMMENT='Execution result for every verified query declared on every semantic view. A verified query is stored metadata and is not validated at create time, so it has to be run to be trusted.'
;
create or replace TABLE SUPPLY_CHAIN.GOVERNANCE.VOLUME_BACKTEST_FORECAST (
	TS TIMESTAMP_NTZ(9),
	FORECAST FLOAT,
	LOWER_BOUND FLOAT,
	UPPER_BOUND FLOAT
)COMMENT='Raw output of VOLUME_FORECAST_BACKTEST over the six withheld months. Intermediate evidence for the PREDICTION_BACKTEST row; kept so the scoring can be re-checked by hand.'
;
create or replace view SUPPLY_CHAIN.GOVERNANCE.AGENT_IMPROVEMENT_CANDIDATE(
	QUESTION,
	TIMES_ASKED,
	DISTINCT_RESOLUTIONS,
	REFUSALS,
	CORRECTIONS,
	LAST_ASKED,
	CANDIDATE_REASON,
	PRIORITY
) COMMENT='Questions ranked by how much they need attention. An unstable resolution ranks above a refusal: being answered two different ways is worse than not being answered.'
 as
WITH agg AS (
  SELECT
    question,
    COUNT(*)                                           AS times_asked,
    COUNT(DISTINCT COALESCE(resolved_metric_ids, ''))   AS distinct_resolutions,
    COUNT_IF(refused)                                   AS refusals,
    COUNT_IF(user_corrected)                            AS corrections,
    MAX(asked_at)                                       AS last_asked
  FROM SUPPLY_CHAIN.GOVERNANCE.AGENT_QUESTION_LOG
  GROUP BY question
)
SELECT
  question, times_asked, distinct_resolutions, refusals, corrections, last_asked,
  CASE
    WHEN distinct_resolutions > 1 THEN 'UNSTABLE_RESOLUTION'
    WHEN refusals > 0            THEN 'REFUSED'
    WHEN corrections > 0         THEN 'USER_CORRECTED'
    ELSE 'OK'
  END AS candidate_reason,
  CASE
    WHEN distinct_resolutions > 1 THEN 1
    WHEN refusals > 0            THEN 2
    WHEN corrections > 0         THEN 3
    ELSE 4
  END AS priority
FROM agg;
create or replace view SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_ENTITY(
	SEMANTIC_VIEW,
	ENTITY,
	ONTOLOGY_CLASS,
	ENTITY_ROLE,
	BASE_OBJECT,
	PRIMARY_KEYS,
	SYNONYMS,
	DESCRIPTION,
	DIMENSION_COUNT,
	METRIC_COUNT
) COMMENT='Entities of each semantic view, derived from INFORMATION_SCHEMA so the catalogue cannot drift from the deployed definition. ONTOLOGY_CLASS and ENTITY_ROLE are parsed from the entity comment.'
 as
SELECT
  t.semantic_view_name                                             AS semantic_view,
  t.name                                                           AS entity,
  NULLIF(REGEXP_SUBSTR(t.comment, 'sco:([A-Za-z]+)', 1, 1, 'e', 1), '') AS ontology_class,
  -- 'DIMENSION', NOT 'CONFORMED_DIMENSION'. app/ontology/page.tsx:25 filters
  --   entities.filter((e) => e.entityRole === "DIMENSION")
  -- to count the conformed dimensions for its stat tile. Emitting
  -- 'CONFORMED_DIMENSION' here -- which reads better and is what the comment
  -- phrase literally says -- made that filter match nothing, so /ontology
  -- displayed "Conformed dimensions 0" while the catalogue table directly below
  -- it tagged five entities as conformed. Nothing failed; the page just quietly
  -- contradicted itself, and only a visual check caught it.
  --
  -- 01_calendar_dimension.sql assumes the same two values: its header warns that
  -- wording a comment as "conformed time dimension" classifies CALENDAR "as a
  -- bare ENTITY instead", i.e. not as the DIMENSION this expression produces.
  IFF(t.comment ILIKE '%Conformed dimension.%', 'DIMENSION', 'FACT')  AS entity_role,
  t.base_table_catalog || '.' || t.base_table_schema || '.' || t.base_table_name AS base_object,
  t.primary_keys,
  t.synonyms,
  t.comment                                                        AS description,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_DIMENSIONS d
    WHERE d.semantic_view_name = t.semantic_view_name AND d.table_name = t.name) AS dimension_count,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_METRICS mt
    WHERE mt.semantic_view_name = t.semantic_view_name AND mt.table_name = t.name) AS metric_count
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_TABLES t;
create or replace view SUPPLY_CHAIN.GOVERNANCE.ONTOLOGY_RELATIONSHIP(
	SEMANTIC_VIEW,
	RELATIONSHIP_NAME,
	FROM_ENTITY,
	TO_ENTITY,
	FROM_COLUMNS,
	TO_COLUMNS
) COMMENT='Relationships of each semantic view, derived from INFORMATION_SCHEMA. The join graph as deployed, not as documented.'
 as
SELECT
  r.semantic_view_name AS semantic_view,
  r.name               AS relationship_name,
  r.table_name         AS from_entity,
  r.ref_table_name     AS to_entity,
  r.foreign_keys       AS from_columns,
  r.ref_keys           AS to_columns
FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.SEMANTIC_RELATIONSHIPS r;
create or replace view SUPPLY_CHAIN.GOVERNANCE.PERSONA_CATALOG(
	ROLE_NAME,
	PERSONA_LABEL,
	FOCUS,
	SORT_ORDER,
	ROW_SCOPE,
	ACCESSIBLE_SEMANTIC_VIEWS,
	VIEW_COUNT
) COMMENT='The persona catalogue with its accessible-view list and count derived from PERSONA_VIEW_ACCESS, so the count shown can never disagree with the list shown beside it.'
 as
SELECT
  p.role_name,
  p.persona_label,
  p.focus,
  p.sort_order,
  p.row_scope,
  (SELECT LISTAGG(a.semantic_view, ', ') WITHIN GROUP (ORDER BY a.semantic_view)
     FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS a WHERE a.role_name = p.role_name) AS accessible_semantic_views,
  (SELECT COUNT(*) FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_VIEW_ACCESS a WHERE a.role_name = p.role_name) AS view_count
FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_DEFINITION p;
create or replace view SUPPLY_CHAIN.GOVERNANCE.V_METRIC_MONTHLY_SERIES(
	METRIC_ID,
	MONTH_START,
	PRODUCT_FAMILY,
	METRIC_VALUE
) COMMENT='Monthly value of each targeted metric by product family, full months only (2024-11..2026-08). The observation set for the target-reachability method and its backtest.'
 as
WITH ff AS (
  SELECT DATE_TRUNC('MONTH', delivery_date) AS month_start, product_family,
         AVG(is_on_time) AS otd_pct, AVG(is_otif) AS otif_pct,
         AVG(is_in_full) AS fill_rate_pct, AVG(is_perfect_order) AS perfect_order_pct
  FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
  WHERE delivery_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
sd AS (
  SELECT DATE_TRUNC('MONTH', receipt_date) AS month_start, product_family,
         AVG(is_on_time) AS supplier_otd_pct, AVG(is_in_full) AS supplier_fill_rate
  FROM SUPPLY_CHAIN.CANONICAL.FCT_SUPPLIER_DELIVERY_LINE
  WHERE receipt_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
lc AS (
  SELECT DATE_TRUNC('MONTH', delivery_date) AS month_start, product_family,
         SUM(total_landed_cost) / NULLIF(SUM(shipped_qty), 0) AS landed_cost_per_unit
  FROM SUPPLY_CHAIN.CANONICAL.FCT_LANDED_COST_SHIPMENT
  WHERE delivery_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
),
inv AS (
  SELECT DATE_TRUNC('MONTH', snapshot_date) AS month_start, product_family,
         SUM(on_hand_qty) / NULLIF(SUM(avg_daily_demand), 0) AS days_of_inventory
  FROM SUPPLY_CHAIN.CANONICAL.FCT_INVENTORY_SNAPSHOT
  WHERE snapshot_date BETWEEN DATE '2024-11-01' AND DATE '2026-08-31'
  GROUP BY 1, 2
)
SELECT 'otd_pct'              AS metric_id, month_start, product_family, otd_pct              AS metric_value FROM ff
UNION ALL SELECT 'otif_pct',            month_start, product_family, otif_pct            FROM ff
UNION ALL SELECT 'fill_rate_pct',       month_start, product_family, fill_rate_pct       FROM ff
UNION ALL SELECT 'perfect_order_pct',   month_start, product_family, perfect_order_pct   FROM ff
UNION ALL SELECT 'supplier_otd_pct',    month_start, product_family, supplier_otd_pct    FROM sd
UNION ALL SELECT 'supplier_fill_rate',  month_start, product_family, supplier_fill_rate  FROM sd
UNION ALL SELECT 'landed_cost_per_unit',month_start, product_family, landed_cost_per_unit FROM lc
UNION ALL SELECT 'days_of_inventory',   month_start, product_family, days_of_inventory   FROM inv;
create or replace view SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK(
	METRIC_ID,
	BUSINESS_NAME,
	UNIT,
	METHOD,
	MODEL_VERSION,
	GRAIN_DIMENSION,
	GRAIN_VALUE,
	HORIZON_PERIOD,
	PREDICTED_VALUE,
	LOWER_BOUND,
	UPPER_BOUND,
	TARGET_VALUE,
	BREACH_PROBABILITY,
	VERDICT,
	METHOD_BACKTEST_ACCURACY,
	METHOD_BACKTEST_MAPE,
	BASIS,
	AS_OF,
	PRODUCED_AT
) COMMENT='Governed predictions joined to the backtested accuracy of the method that produced them. A prediction is never exposed without its track record.'
 as
SELECT
  p.metric_id,
  -- LEFT JOIN, NOT INNER, AND THAT IS A DESIGN POSITION.
  --
  -- Not every prediction is about a governed metric. The volume forecast predicts
  -- order-line volume, which is a capacity and budget input, not one of the 14
  -- registered metrics. An inner join here would silently discard it, and the fix
  -- that first suggests itself -- registering volume as a governed metric so the
  -- join succeeds -- would contradict the central claim of this layer: a
  -- prediction is not a measurement. Registering a forecast in
  -- METRIC_DEFINITION would put it inside the realized-metric contract and hand
  -- it to the drift test, which would then fail it by design.
  --
  -- So predictions about unregistered series are kept, and labelled from the
  -- prediction itself when the registry has nothing to say about them.
  COALESCE(d.business_name, INITCAP(REPLACE(p.metric_id, '_', ' '))) AS business_name,
  COALESCE(d.unit, 'count')                                          AS unit,
  p.method,
  p.model_version,
  p.grain_dimension,
  p.grain_value,
  p.horizon_period,
  p.predicted_value,
  p.lower_bound,
  p.upper_bound,
  p.target_value,
  p.breach_probability,
  -- Bands, not a bare probability. The underlying z-score is trustworthy while
  -- the probability is approximate, so the label is what a reader should act on.
  CASE
    WHEN p.breach_probability >= 0.99 THEN 'UNREACHABLE'
    WHEN p.breach_probability >= 0.85 THEN 'AT_RISK'
    WHEN p.breach_probability >= 0.50 THEN 'BORDERLINE'
    WHEN p.breach_probability >= 0.15 THEN 'LIKELY_MET'
    ELSE 'ON_TRACK'
  END                                     AS verdict,
  b.forecast_accuracy                     AS method_backtest_accuracy,
  b.mape                                  AS method_backtest_mape,
  p.basis,
  p.as_of,
  p.produced_at
FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION p
LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d ON d.metric_id = p.metric_id
LEFT JOIN SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST b
       ON b.method = p.method AND b.metric_id = p.metric_id;
create or replace view SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK_SV(
	METRIC_ID,
	BUSINESS_NAME,
	UNIT,
	METHOD,
	MODEL_VERSION,
	GRAIN_DIMENSION,
	GRAIN_VALUE,
	HORIZON_PERIOD,
	VERDICT,
	BASIS,
	AS_OF,
	PRED_LEVEL,
	TGT_LEVEL,
	BREACH_P,
	METHOD_ACC
) COMMENT='Renaming wrapper over V_METRIC_OUTLOOK, used only as the base table of SEMANTIC.SC_OUTLOOK. Its measure columns are deliberately named so they cannot collide with the semantic view metric names, which would otherwise be rejected as a cyclic expression reference.'
 as
SELECT
  metric_id,
  business_name,
  unit,
  method,
  model_version,
  grain_dimension,
  grain_value,
  horizon_period,
  verdict,
  basis,
  as_of,
  predicted_value          AS pred_level,
  target_value             AS tgt_level,
  breach_probability       AS breach_p,
  method_backtest_accuracy AS method_acc
FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_OUTLOOK;
create or replace view SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES(
	MONTH_TS,
	ORDER_LINES,
	DAYS_IN_MONTH
) as
SELECT DATE_TRUNC('month', delivery_date)::TIMESTAMP_NTZ AS month_ts,
       COUNT(*)::FLOAT                                   AS order_lines,
       DAY(LAST_DAY(MAX(delivery_date)))::FLOAT          AS days_in_month
FROM SUPPLY_CHAIN.CANONICAL.FCT_ORDER_LINE_FULFILLMENT
WHERE delivery_date BETWEEN '2024-11-01' AND '2026-08-31'   -- full months only
GROUP BY 1;
create or replace view SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_TRAIN(
	MONTH_TS,
	ORDER_LINES
) COMMENT='Training slice of V_MONTHLY_VOLUME_SERIES, 2024-11..2026-02. Exists only so the six months withheld from it can be used to measure the volume forecast rather than assert its accuracy.'
 as
SELECT month_ts, order_lines
FROM SUPPLY_CHAIN.GOVERNANCE.V_MONTHLY_VOLUME_SERIES
WHERE month_ts <= '2026-02-01'::TIMESTAMP_NTZ;
CREATE OR REPLACE PROCEDURE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST()
RETURNS TABLE ()
LANGUAGE SQL
COMMENT='Runs METRIC_DRIFT_TEST with a relative tolerance of 1e-6.'
EXECUTE AS OWNER
AS '
DECLARE
  res RESULTSET;
BEGIN
  CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST(0.000001);
  res := (
    SELECT metric_id, business_name, binding_count, canonical_value,
           value_spread, relative_spread, status, detail, run_at, run_id
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     WHERE run_id = (SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
                      ORDER BY run_at DESC LIMIT 1)
     ORDER BY status DESC, metric_id
  );
  RETURN TABLE(res);
END;
';
CREATE OR REPLACE PROCEDURE SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST("TOLERANCE" FLOAT)
RETURNS TABLE ()
LANGUAGE SQL
COMMENT='Compares every semantic-view binding of every governed metric against the metric CANONICAL_SQL. Writes one row per metric to METRIC_DRIFT_RESULT under a single RUN_ID and returns that run. TOLERANCE is a relative spread.'
EXECUTE AS OWNER
AS '
DECLARE
  v_run_id    STRING;
  v_run_at    TIMESTAMP_LTZ;
  v_canon     FLOAT;
  v_min       FLOAT;
  v_max       FLOAT;
  v_n         NUMBER;
  v_detail    STRING;
  v_status    STRING;
  v_spread    FLOAT;
  v_rel       FLOAT;
  v_sql       STRING;
  v_val       FLOAT;
  -- Loop fields must be copied into locals before use as binds: Snowflake
  -- Scripting does not accept a qualified loop variable (:m.metric_id) as a bind
  -- inside a SQL statement, only a plain local (:v_mid).
  v_mid       STRING;
  v_bname     STRING;
  v_csql      STRING;
  v_view      STRING;
  v_ref       STRING;
  res         RESULTSET;
  metrics CURSOR FOR
    SELECT metric_id, business_name, canonical_sql
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION
     ORDER BY metric_id;
BEGIN
  v_run_id := UUID_STRING();
  v_run_at := CURRENT_TIMESTAMP();

  FOR m IN metrics DO
    v_mid    := m.metric_id;
    v_bname  := m.business_name;
    v_csql   := m.canonical_sql;
    v_canon  := NULL;
    v_min    := NULL;
    v_max    := NULL;
    v_n      := 0;
    v_detail := '''';
    v_status := ''PASS'';

    -- The canonical value. If this fails the metric is unusable, so record ERROR
    -- and move on rather than letting one bad registry row end the run.
    BEGIN
      v_sql := v_csql;
      LET cres RESULTSET := (EXECUTE IMMEDIATE :v_sql);
      LET ccur CURSOR FOR cres;
      OPEN ccur;
      FETCH ccur INTO v_val;
      CLOSE ccur;
      v_canon  := v_val;
      v_min    := v_val;
      v_max    := v_val;
      v_detail := ''canonical='' || COALESCE(TO_VARCHAR(v_canon), ''NULL'');
    EXCEPTION
      WHEN OTHER THEN
        v_status := ''ERROR'';
        v_detail := ''canonical_sql failed: '' || SQLERRM;
    END;

    IF (v_status <> ''ERROR'') THEN
      LET bres RESULTSET := (
        SELECT semantic_view, metric_reference
          FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_BINDING
         WHERE metric_id = :v_mid
         ORDER BY semantic_view, metric_reference
      );
      LET bcur CURSOR FOR bres;
      FOR b IN bcur DO
        v_view := b.semantic_view;
        v_ref  := b.metric_reference;
        BEGIN
          -- Alias the metric column to VAL so both sides fetch identically.
          v_sql := ''SELECT '' || UPPER(SPLIT_PART(v_ref, ''.'', 2))
                   || '' AS VAL FROM SEMANTIC_VIEW(SUPPLY_CHAIN.SEMANTIC.''
                   || v_view || '' METRICS '' || v_ref || '')'';
          LET vres RESULTSET := (EXECUTE IMMEDIATE :v_sql);
          LET vcur CURSOR FOR vres;
          OPEN vcur;
          FETCH vcur INTO v_val;
          CLOSE vcur;
          v_n      := v_n + 1;
          v_min    := LEAST(COALESCE(v_min, v_val), COALESCE(v_val, v_min));
          v_max    := GREATEST(COALESCE(v_max, v_val), COALESCE(v_val, v_max));
          v_detail := v_detail || '' | '' || v_view || ''.''
                      || SPLIT_PART(v_ref, ''.'', 2) || ''=''
                      || COALESCE(TO_VARCHAR(v_val), ''NULL'');
        EXCEPTION
          WHEN OTHER THEN
            v_status := ''ERROR'';
            v_detail := v_detail || '' | '' || v_view || '' FAILED: '' || SQLERRM;
        END;
      END FOR;
    END IF;

    v_spread := CASE WHEN v_min IS NULL OR v_max IS NULL THEN NULL ELSE v_max - v_min END;
    v_rel    := CASE WHEN v_spread IS NULL OR v_canon IS NULL OR ABS(v_canon) = 0
                     THEN v_spread ELSE v_spread / ABS(v_canon) END;

    IF (v_status <> ''ERROR'') THEN
      -- A metric bound only once has nothing to disagree with. Saying PASS would
      -- overstate what was verified, so it is called out explicitly.
      IF (v_n < 2) THEN
        v_status := ''UNTESTED'';
        v_detail := v_detail || '' | only '' || v_n || '' binding: nothing to compare against'';
      ELSEIF (COALESCE(v_rel, 0) > :TOLERANCE) THEN
        v_status := ''FAIL'';
      ELSE
        v_status := ''PASS'';
      END IF;
    END IF;

    INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
      (run_id, run_at, metric_id, business_name, binding_count,
       canonical_value, min_value, max_value, value_spread, relative_spread, status, detail)
    SELECT :v_run_id, :v_run_at, :v_mid, :v_bname, :v_n,
           :v_canon, :v_min, :v_max, :v_spread, :v_rel, :v_status, :v_detail;
  END FOR;

  res := (
    SELECT metric_id, business_name, binding_count, canonical_value,
           value_spread, relative_spread, status, detail, run_at, run_id
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     WHERE run_id = :v_run_id
     ORDER BY status DESC, metric_id
  );
  RETURN TABLE(res);
END;
';
CREATE OR REPLACE PROCEDURE SUPPLY_CHAIN.GOVERNANCE.PREDICT_TARGET_BREACH()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT='Scores whether each governed target is reachable from current process capability, per metric per product family, as a z-score against month-to-month variation. Replaces prior TARGET_BREACH predictions and rewrites their backtest.'
EXECUTE AS OWNER
AS '
DECLARE
  v_run_id STRING;
  v_as_of  DATE;
  v_rows   NUMBER;
BEGIN
  v_run_id := UUID_STRING();
  -- As of the last full month in the series, not today: today sits mid-month and
  -- the current partial month is deliberately excluded from the observations.
  v_as_of  := DATE ''2026-08-31'';

  DELETE FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION  WHERE method = ''TARGET_BREACH'';
  DELETE FROM SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST WHERE method = ''TARGET_BREACH'';

  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_PREDICTION
    (run_id, metric_id, method, model_version, grain_dimension, grain_value,
     as_of, horizon_period, predicted_value, lower_bound, upper_bound,
     breach_probability, target_value, basis)
  WITH stats AS (
    SELECT
      s.metric_id,
      s.product_family,
      COUNT(*)              AS n,
      AVG(s.metric_value)   AS mean_v,
      STDDEV(s.metric_value) AS sd_v
    FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_MONTHLY_SERIES s
    WHERE s.metric_value IS NOT NULL
    GROUP BY s.metric_id, s.product_family
    HAVING COUNT(*) >= 12 AND STDDEV(s.metric_value) > 0
  ),
  scored AS (
    SELECT
      st.*,
      d.target_value,
      d.direction,
      d.unit,
      -- Positive z = the target sits beyond what the process currently delivers.
      -- The sign convention flips with direction, so one verdict scale serves
      -- both higher-is-better and lower-is-better metrics.
      CASE WHEN d.direction = ''higher'' THEN (d.target_value - st.mean_v) / st.sd_v
           ELSE (st.mean_v - d.target_value) / st.sd_v END AS z
    FROM stats st
    JOIN SUPPLY_CHAIN.GOVERNANCE.METRIC_DEFINITION d ON d.metric_id = st.metric_id
    WHERE d.target_value IS NOT NULL
  )
  SELECT
    :v_run_id,
    metric_id,
    ''TARGET_BREACH'',
    ''target-reachability v1 (z-score, logistic CDF approximation)'',
    ''PRODUCT_FAMILY'',
    product_family,
    :v_as_of,
    ''NEXT_MONTH'',
    mean_v,
    -- A +/-2 sd band on the mean, i.e. the range ordinary variation produces.
    mean_v - 2 * sd_v,
    mean_v + 2 * sd_v,
    -- Probability of MISSING the target. 1/(1+exp(-1.702z)) approximates the
    -- normal CDF to about 0.01; see the file header on why that error is not the
    -- binding limitation.
    1 / (1 + EXP(-1.702 * z)),
    target_value,
    ''Target is '' || TO_VARCHAR(ROUND(z, 2)) || '' standard deviations of ordinary month-to-month variation ''
      || IFF(z > 0, ''BEYOND'', ''WITHIN'') || '' current capability for '' || product_family
      || '' (mean '' || TO_VARCHAR(ROUND(mean_v, 4)) || '', sd '' || TO_VARCHAR(ROUND(sd_v, 4))
      || '' over '' || TO_VARCHAR(n) || '' full months). ''
      || ''The z-score and verdict are the reliable outputs; the probability is a logistic approximation to the normal CDF and ''
      || TO_VARCHAR(n) || '' monthly observations cannot support precise tail probabilities.''
  FROM scored;

  v_rows := SQLROWCOUNT;

  -- ---------------------------------------------------------------------------
  -- Backtest, scored with the EXISTING canonical accuracy definitions rather than
  -- a second set invented here.
  --
  -- The benchmark is deliberately "predict the trailing mean", because on a
  -- stationary series that is the honest thing to beat. The expected verdict is
  -- that this method does NOT beat it on level accuracy -- which is the finding,
  -- not a failure: it is why the layer reports target reachability instead of a
  -- forecast of the level. Recording a method that loses to its own benchmark is
  -- what keeps a weak predictor visible instead of quietly shipped.
  -- ---------------------------------------------------------------------------
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.PREDICTION_BACKTEST
    (method, metric_id, grain_dimension, holdout_periods, observations,
     forecast_accuracy, mape, forecast_bias, benchmark_name, benchmark_accuracy,
     beats_benchmark, verdict)
  WITH split AS (
    SELECT
      s.metric_id, s.product_family, s.month_start, s.metric_value,
      -- Last 6 full months held out; the mean of the earlier months is the
      -- prediction evaluated against them.
      IFF(s.month_start > DATE ''2026-02-28'', ''HOLDOUT'', ''TRAIN'') AS part
    FROM SUPPLY_CHAIN.GOVERNANCE.V_METRIC_MONTHLY_SERIES s
    WHERE s.metric_value IS NOT NULL
  ),
  trained AS (
    SELECT metric_id, product_family, AVG(metric_value) AS train_mean
    FROM split WHERE part = ''TRAIN''
    GROUP BY metric_id, product_family
  ),
  errs AS (
    SELECT
      h.metric_id,
      COUNT(*)                                                           AS observations,
      COUNT(DISTINCT h.month_start)                                      AS holdout_periods,
      AVG(ABS(h.metric_value - t.train_mean) / NULLIF(ABS(h.metric_value), 0)) AS mape,
      AVG((t.train_mean - h.metric_value) / NULLIF(ABS(h.metric_value), 0))    AS bias
    FROM split h
    JOIN trained t ON t.metric_id = h.metric_id AND t.product_family = h.product_family
    WHERE h.part = ''HOLDOUT''
    GROUP BY h.metric_id
  )
  SELECT
    ''TARGET_BREACH'',
    metric_id,
    ''PRODUCT_FAMILY'',
    holdout_periods,
    observations,
    1 - mape,
    mape,
    bias,
    ''trailing mean of the training months'',
    1 - mape,
    -- Identical by construction: this method predicts the mean. Recorded as FALSE
    -- rather than TRUE so no reader can mistake a tie for an edge.
    FALSE,
    CASE
      WHEN mape <= 0.01 THEN ''Level accuracy is high only because the series is stationary. Equals the trailing-mean benchmark and does not beat it; the useful output of this method is the target-reachability z-score, not the level.''
      ELSE ''Level accuracy is moderate. Use the z-score and verdict, not the predicted level.''
    END
  FROM errs;

  RETURN ''TARGET_BREACH: '' || TO_VARCHAR(v_rows) || '' predictions written, run_id '' || v_run_id;
END;
';
create or replace task SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST_DAILY
	schedule='USING CRON 0 6 * * * UTC'
	USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE='XSMALL'
	COMMENT='Runs METRIC_DRIFT_TEST every day at 06:00 UTC so a definition that drifts is detected without anyone opening the app.'
	as CALL SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_TEST();
create or replace row access policy SUPPLY_CHAIN.GOVERNANCE.RAP_SHIP_REGION as (SHIP_REGION VARCHAR) 
returns BOOLEAN ->
CASE
      WHEN EXISTS (
        SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE s
         WHERE s.role_name = CURRENT_ROLE() AND s.region_value = ship_region
      ) THEN TRUE
      WHEN EXISTS (
        SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.PERSONA_REGION_SCOPE s
         WHERE s.role_name = CURRENT_ROLE()
      ) THEN FALSE
      ELSE TRUE
    END
COMMENT='Restricts outbound rows by destination region for roles listed in PERSONA_REGION_SCOPE. Roles not listed are unrestricted.'
;
create or replace alert SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_FAILED
	schedule='60 MINUTE'
	if (exists(
		WITH latest_run AS (
      SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
       QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
    )
    SELECT 1
      FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
      JOIN latest_run l ON l.run_id = r.run_id
     WHERE r.status <> 'PASS'
       -- Only alert on a run not already logged, so one unfixed failure does not
       -- produce an identical email every hour until someone attends to it.
       AND NOT EXISTS (SELECT 1 FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG a WHERE a.run_id = r.run_id)
	))
	then
	BEGIN
  LET v_run_id STRING;
  LET v_failed INTEGER;
  LET v_spread FLOAT;
  LET v_detail STRING;

  WITH latest_run AS (
    SELECT run_id FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT
     QUALIFY ROW_NUMBER() OVER (ORDER BY run_at DESC) = 1
  )
  SELECT r.run_id, COUNT(*), MAX(r.relative_spread),
         LISTAGG(r.metric_id || ' spread=' || TO_VARCHAR(ROUND(r.value_spread, 10)), '; ')
    INTO :v_run_id, :v_failed, :v_spread, :v_detail
    FROM SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_RESULT r
    JOIN latest_run l ON l.run_id = r.run_id
   WHERE r.status <> 'PASS'
   GROUP BY r.run_id;

  -- Log first, then notify. If the email fails (unverified address, integration disabled) the
  -- failure is still recorded and visible on /metrics, rather than being lost with the email.
  INSERT INTO SUPPLY_CHAIN.GOVERNANCE.METRIC_DRIFT_ALERT_LOG
    (detected_at, run_id, failed_metrics, max_spread, detail)
  SELECT CURRENT_TIMESTAMP(), :v_run_id, :v_failed, :v_spread, :v_detail;

  CALL SYSTEM$SEND_EMAIL(
    'SC_GOVERNANCE_EMAIL',
    'mhiremath@mmm.com',
    '[Supply Chain Ontology] Metric drift detected: ' || :v_failed || ' metric(s) FAILED',
    'The governed drift test found metrics whose semantic views no longer agree with the canonical fact.'
      || '\n\nRun id: ' || :v_run_id
      || '\nFailing metrics: ' || :v_failed
      || '\nMax relative spread: ' || TO_VARCHAR(:v_spread)
      || '\n\nDetail: ' || :v_detail
      || '\n\nThis means the same question can now return different answers depending on which view'
      || ' answers it. Investigate before trusting any affected figure.'
      || '\n\nFull history: GOVERNANCE.METRIC_DRIFT_RESULT (run_id above) and the Metric Registry page.'
  );
END;
create or replace schema SUPPLY_CHAIN.PUBLIC;

create or replace schema SUPPLY_CHAIN.RAW COMMENT='Landing zone. Synthetic source systems, generated by 00b/00c. Nothing outside CANONICAL reads these tables and no application role is granted on them.';

create or replace TABLE SUPPLY_CHAIN.RAW.CARRIER (
	CARRIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Carrier code.',
	CARRIER_NAME VARCHAR(16777216) NOT NULL COMMENT 'Carrier name.',
	MODE VARCHAR(16777216) NOT NULL COMMENT 'Transport mode.',
	ON_TIME_BIAS NUMBER(4,1) NOT NULL COMMENT 'Deviation from baseline on-time probability, in percentage points. Makes carrier a genuine driver of OTD rather than noise.',
	COST_INDEX NUMBER(5,3) NOT NULL COMMENT 'Multiplier on baseline freight cost per shipment.',
	constraint PK_CARRIER primary key (CARRIER_ID)
)COMMENT='Carrier master. ON_TIME_BIAS and COST_INDEX make carrier an explanatory dimension for both service and cost.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.CUSTOMER (
	CUSTOMER_ID VARCHAR(16777216) NOT NULL COMMENT 'Ship-to customer number.',
	CUSTOMER_NAME VARCHAR(16777216) NOT NULL COMMENT 'Customer name.',
	CUSTOMER_REGION VARCHAR(16777216) NOT NULL COMMENT 'Region the account is managed in.',
	CUSTOMER_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Go-to-market segment.',
	CHANNEL VARCHAR(16777216) NOT NULL COMMENT 'Route to market.',
	constraint PK_CUSTOMER primary key (CUSTOMER_ID)
)COMMENT='Customer master. 1,200 ship-to accounts.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.DATE_DIM (
	DATE_KEY DATE NOT NULL COMMENT 'Calendar day. Join key for every day-grain fact.',
	MONTH_START DATE NOT NULL COMMENT 'First day of the calendar month.',
	MONTH_END DATE NOT NULL COMMENT 'Last day of the calendar month.',
	PERIOD VARCHAR(16777216) NOT NULL COMMENT 'Month as a YYYY-MM label. The period key the application and the forecast both use.',
	FISCAL_QUARTER VARCHAR(16777216) NOT NULL COMMENT 'Fiscal quarter, calendar-aligned, as YYYY-Qn.',
	YEAR_NUM NUMBER(38,0) NOT NULL COMMENT 'Calendar year.',
	MONTH_NUM NUMBER(38,0) NOT NULL COMMENT 'Month number 1-12.',
	DAY_OF_WEEK NUMBER(38,0) NOT NULL COMMENT 'ISO day of week, 1 = Monday.',
	IS_WEEKDAY BOOLEAN NOT NULL COMMENT 'TRUE for Monday-Friday.',
	IS_MONTH_END BOOLEAN NOT NULL COMMENT 'TRUE on the last day of the month. Inventory snapshots land only on these dates.',
	constraint PK_DATE_DIM primary key (DATE_KEY)
)COMMENT='Conformed calendar, 2024-01-01..2026-12-31. Deliberately wider than the fact data so that empty periods are expressible and IS_FUTURE is meaningful.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.DEMAND_FORECAST (
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material forecast.',
	PERIOD VARCHAR(16777216) NOT NULL COMMENT 'Forecast month as a YYYY-MM label. Deliberately not a DATE: see the header note and 01_calendar_dimension.sql.',
	FORECAST_QTY NUMBER(38,0) NOT NULL COMMENT 'Forecast quantity for the period.',
	ACTUAL_QTY NUMBER(38,0) NOT NULL COMMENT 'Realised quantity. Zero for periods that have not closed.',
	constraint PK_DEMAND_FORECAST primary key (MATERIAL_ID, PERIOD)
)COMMENT='Monthly demand forecast versus actual, by material. 26 periods, 2024-10..2026-11.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.INVENTORY_POSITION (
	SNAPSHOT_DATE DATE NOT NULL COMMENT 'Month-end date the balance was observed. One per month, never a partial period.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material.',
	NODE_ID VARCHAR(16777216) NOT NULL COMMENT 'Stocking location.',
	ON_HAND_QTY NUMBER(38,0) NOT NULL COMMENT 'Units on hand at the snapshot.',
	AVG_DAILY_DEMAND NUMBER(12,3) NOT NULL COMMENT 'Trailing average daily demand. Denominator of days of inventory.',
	SAFETY_STOCK NUMBER(38,0) NOT NULL COMMENT 'Target safety stock. Below this is an availability risk.',
	ATP_QTY NUMBER(38,0) NOT NULL COMMENT 'Available to promise: on hand less allocated, floored at zero. Zero is a genuine stockout and is what IS_STOCKED_OUT is derived from in CANONICAL.',
	constraint PK_INVENTORY_POSITION primary key (SNAPSHOT_DATE, MATERIAL_ID, NODE_ID)
)COMMENT='Month-end inventory balances by material and node. Exactly 24 snapshot dates, 2024-10-31..2026-09-30. A snapshot is non-additive across periods.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.LANE (
	LANE_ID VARCHAR(16777216) NOT NULL COMMENT 'Lane code.',
	ORIGIN_NODE VARCHAR(16777216) NOT NULL COMMENT 'Shipping node.',
	DEST_REGION VARCHAR(16777216) NOT NULL COMMENT 'Destination region. The shipment SHIP_REGION comes from here.',
	SERVICE_LEVEL VARCHAR(16777216) NOT NULL COMMENT 'Committed service level.',
	TRANSIT_TARGET_DAYS NUMBER(38,0) NOT NULL COMMENT 'Committed transit time. The promise date in 00c is derived from this, so lateness is measured against a real commitment.',
	constraint PK_LANE primary key (LANE_ID)
)COMMENT='Transport lanes. 96 origin/destination/service combinations.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.NODE (
	NODE_ID VARCHAR(16777216) NOT NULL COMMENT 'Plant or distribution centre code.',
	NODE_NAME VARCHAR(16777216) NOT NULL COMMENT 'Location name, shown in inventory drill-down rows.',
	NODE_REGION VARCHAR(16777216) NOT NULL COMMENT 'Region the node serves.',
	NODE_TYPE VARCHAR(16777216) NOT NULL COMMENT 'PLANT for manufacturing, DC for distribution.',
	constraint PK_NODE primary key (NODE_ID)
)COMMENT='Network master. 24 nodes across 4 regions.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.PART (
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material number. Conformed key across purchasing, fulfilment, inventory and manufacturing.',
	MATERIAL_DESC VARCHAR(16777216) NOT NULL COMMENT 'Human-readable description.',
	PRODUCT_FAMILY VARCHAR(16777216) NOT NULL COMMENT 'Product family. The most-used analytical grouping in the application.',
	BUSINESS_SEGMENT VARCHAR(16777216) NOT NULL COMMENT 'Reporting segment the family rolls into.',
	ABC_CLASS VARCHAR(16777216) NOT NULL COMMENT 'Inventory value classification: A is high-value low-volume, C the reverse.',
	STANDARD_COST NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost. Fixed for the life of the material so that purchase price variance is measured against an unchanging basis.',
	UOM VARCHAR(16777216) NOT NULL COMMENT 'Unit of measure.',
	constraint PK_PART primary key (MATERIAL_ID)
)COMMENT='Material master. 2,000 materials across 8 product families.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.PO_RECEIPT_LINE (
	PO_ID VARCHAR(16777216) NOT NULL COMMENT 'Purchase order number.',
	LINE NUMBER(38,0) NOT NULL COMMENT 'Line number within the purchase order.',
	SUPPLIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Vendor the line was placed with.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material ordered.',
	ORDERED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity ordered.',
	RECEIVED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity actually received. Below ORDERED_QTY is a short receipt.',
	PROMISED_DATE DATE NOT NULL COMMENT 'Date the supplier committed to. The basis for on-time measurement.',
	RECEIPT_DATE DATE NOT NULL COMMENT 'Date goods were received. The event date: the reporting period comes from here.',
	STANDARD_PRICE NUMBER(12,4) NOT NULL COMMENT 'Standard unit cost from the material master.',
	ACTUAL_PRICE NUMBER(12,4) NOT NULL COMMENT 'Unit price actually invoiced.',
	constraint PK_PO_RECEIPT_LINE primary key (PO_ID, LINE)
)COMMENT='Inbound purchase-order receipt lines. Source for CANONICAL.FCT_SUPPLIER_DELIVERY_LINE.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.PRODUCTION_ORDER (
	PRODUCTION_ORDER_ID VARCHAR(16777216) NOT NULL COMMENT 'Production order number.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material produced.',
	NODE_ID VARCHAR(16777216) NOT NULL COMMENT 'Producing plant. Always a PLANT, never a DC.',
	PLANNED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity planned.',
	COMPLETED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity completed good.',
	SCRAP_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity scrapped.',
	SCHEDULED_DATE DATE NOT NULL COMMENT 'Scheduled completion date.',
	COMPLETED_DATE DATE NOT NULL COMMENT 'Actual completion date. The event date for manufacturing reporting.',
	constraint PK_PRODUCTION_ORDER primary key (PRODUCTION_ORDER_ID)
)COMMENT='Manufacturing completions. Source for the MANUFACTURING domain.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.SALES_ORDER_LINE (
	ORDER_ID VARCHAR(16777216) NOT NULL COMMENT 'Sales order number.',
	ORDER_LINE NUMBER(38,0) NOT NULL COMMENT 'Line number within the sales order.',
	CUSTOMER_ID VARCHAR(16777216) NOT NULL COMMENT 'Ship-to customer.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material ordered.',
	CARRIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Carrier that moved the line.',
	LANE_ID VARCHAR(16777216) NOT NULL COMMENT 'Transport lane used. Supplies the destination region and the committed transit time.',
	ORDERED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity ordered by the customer.',
	SHIPPED_QTY NUMBER(38,0) NOT NULL COMMENT 'Quantity shipped. Below ORDERED_QTY is a short ship.',
	PROMISE_DATE DATE NOT NULL COMMENT 'Date promised to the customer.',
	DELIVERY_DATE DATE NOT NULL COMMENT 'Date delivered. The event date: the reporting period comes from here.',
	TRANSIT_DAYS NUMBER(38,0) NOT NULL COMMENT 'Actual days in transit.',
	DEFECT_REASON VARCHAR(16777216) COMMENT 'Recorded cause, populated only on lines that failed a condition. NULL on clean lines.',
	CDDA_MET BOOLEAN NOT NULL COMMENT 'Customer delivery date accepted. An independent third condition, so that perfect order is strictly harder than OTIF.',
	WAS_SHIPPED BOOLEAN NOT NULL COMMENT 'FALSE where the customer collected and no carrier-billed shipment exists. These lines are still delivered and still count in fulfilment; they simply have no landed-cost row, which is why SHIPMENT_COST is smaller than this table.',
	constraint PK_SALES_ORDER_LINE primary key (ORDER_ID, ORDER_LINE)
)COMMENT='Outbound customer order lines. Source for CANONICAL.FCT_ORDER_LINE_FULFILLMENT.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.SHIPMENT_COST (
	SHIPMENT_ID VARCHAR(16777216) NOT NULL COMMENT 'Shipment number.',
	ORDER_ID VARCHAR(16777216) NOT NULL COMMENT 'Sales order the shipment belongs to.',
	ORDER_LINE NUMBER(38,0) NOT NULL COMMENT 'Order line the shipment covers.',
	CARRIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Carrier that moved the shipment.',
	LANE_ID VARCHAR(16777216) NOT NULL COMMENT 'Lane used.',
	SERVICE_LEVEL VARCHAR(16777216) NOT NULL COMMENT 'Committed service level from the lane.',
	SHIP_REGION VARCHAR(16777216) NOT NULL COMMENT 'Destination region. The EU row access policy scopes on this column.',
	MATERIAL_ID VARCHAR(16777216) NOT NULL COMMENT 'Material shipped.',
	SHIPPED_QTY NUMBER(38,0) NOT NULL COMMENT 'Units shipped. Denominator of landed cost per unit.',
	DELIVERY_DATE DATE NOT NULL COMMENT 'Delivery date. The event date for landed-cost reporting.',
	MATERIAL_COST NUMBER(14,2) NOT NULL COMMENT 'Standard cost times quantity.',
	FREIGHT_COST NUMBER(14,2) NOT NULL COMMENT 'Accrued freight.',
	INVOICED_FREIGHT_AMT NUMBER(14,2) NOT NULL COMMENT 'Freight the carrier actually invoiced.',
	ACCESSORIAL_USD NUMBER(14,2) NOT NULL COMMENT 'Accessorial charges: detention, liftgate, redelivery.',
	DUTY_COST NUMBER(14,2) NOT NULL COMMENT 'Duty. Cross-region movements only.',
	HANDLING_COST NUMBER(14,2) NOT NULL COMMENT 'Warehouse handling.',
	IS_PREMIUM_FREIGHT BOOLEAN NOT NULL COMMENT 'TRUE where an expedited service level was used.',
	constraint PK_SHIPMENT_COST primary key (SHIPMENT_ID)
)COMMENT='Landed cost per shipped order line. Source for CANONICAL.FCT_LANDED_COST_SHIPMENT.'
;
create or replace TABLE SUPPLY_CHAIN.RAW.SUPPLIER (
	SUPPLIER_ID VARCHAR(16777216) NOT NULL COMMENT 'Vendor number.',
	SUPPLIER_NAME VARCHAR(16777216) NOT NULL COMMENT 'Vendor name, shown in drill-down rows.',
	SUPPLIER_REGION VARCHAR(16777216) NOT NULL COMMENT 'Sourcing region: NA, EU, APAC or LATAM.',
	SUPPLIER_GROUP VARCHAR(16777216) NOT NULL COMMENT 'Commodity group the vendor is managed under.',
	SUPPLIER_TIER VARCHAR(16777216) NOT NULL COMMENT 'Strategic tier. TIER_1 vendors carry the majority of spend.',
	COUNTRY VARCHAR(16777216) NOT NULL COMMENT 'Country of the shipping origin.',
	constraint PK_SUPPLIER primary key (SUPPLIER_ID)
)COMMENT='Supplier master. 300 vendors, regionally weighted so that row-scoped personas see populations of different size.'
;
create or replace schema SUPPLY_CHAIN.SEMANTIC COMMENT='Semantic views. The only surface the application and Cortex Analyst query. A metric exists here once and is referenced everywhere, so the UI and the conversational layer cannot disagree about what a number means.';

create or replace schema SUPPLY_CHAIN.UTIL COMMENT='Reserved for synthetic-data generation helpers. Deliberately empty: the generators in 00c are self-contained and seeded inline, so that no business number depends on a value stored here.';

