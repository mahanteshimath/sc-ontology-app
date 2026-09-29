-- ---------------------------------------------------------------------------
-- 18 - Industry alignment: every governed metric mapped to the SCOR model.
--
-- SCOR (Supply Chain Operations Reference, ASCM) is the vocabulary supply chain
-- practitioners already use. A governed metric that says "this is SCOR RL.2.2,
-- Delivery Performance to Customer Commit Date" is understood by a planner in any
-- company without a meeting; "otd_pct" is not.
--
-- THE ALIGNMENT GRADE IS THE POINT, NOT THE CODE.
--   EXACT        our definition computes the SCOR metric as SCOR defines it
--   VARIANT      same intent, measured differently - the note says how
--   COMPONENT    an input to a SCOR metric, not the metric itself
--   NOT_IN_SCOR  no SCOR equivalent; mapped to the attribute it serves
-- A mapping that claimed EXACT for every row would be the average-of-averages
-- mistake again, one level up: two things called the same name that are not the
-- same number.
--
-- Codes are SCOR 12.0 level-1/level-2 metric identifiers. Where we are not
-- certain of an identifier the code is left NULL and the SCOR metric is named
-- instead - an honest gap is better than a plausible-looking code. Verify against
-- your organisation's licensed SCOR reference before relying on a code externally.
--
-- Kept in its own table rather than as columns on METRIC_DEFINITION: the registry
-- is the drift contract, and industry mapping is documentation about it, not part
-- of it. Nothing here can change a metric's value.
-- ---------------------------------------------------------------------------

USE ROLE ACCOUNTADMIN;
USE DATABASE SUPPLY_CHAIN;
USE SCHEMA GOVERNANCE;

CREATE OR REPLACE TABLE METRIC_SCOR_ALIGNMENT (
  metric_id        STRING NOT NULL,
  scor_attribute   STRING NOT NULL COMMENT 'Reliability, Responsiveness, Agility, Cost or Asset Management Efficiency.',
  scor_process     STRING NOT NULL COMMENT 'Plan, Source, Make, Deliver, Return or Enable.',
  scor_code        STRING          COMMENT 'SCOR 12.0 metric id. NULL when not certain - see scor_metric.',
  scor_metric      STRING NOT NULL COMMENT 'The SCOR metric name this maps to.',
  alignment        STRING NOT NULL COMMENT 'EXACT, VARIANT, COMPONENT or NOT_IN_SCOR.',
  note             STRING NOT NULL COMMENT 'How our definition differs, or why it is exact.',
  CONSTRAINT pk_metric_scor PRIMARY KEY (metric_id)
) COMMENT = 'Governed metrics mapped to the SCOR model, each with an honest alignment grade. Documentation of the registry, never an input to it.';

INSERT INTO METRIC_SCOR_ALIGNMENT
SELECT * FROM VALUES
 ('perfect_order_pct', 'Reliability', 'Deliver', 'RL.1.1', 'Perfect Order Fulfillment', 'EXACT',
  'An order line counts only when on time, in full, and free of a recorded defect - the SCOR conjunction of its level-2 components.'),
 ('otd_pct', 'Reliability', 'Deliver', 'RL.2.2', 'Delivery Performance to Customer Commit Date', 'EXACT',
  'Delivered on or before the date committed to the customer, per order line, future-dated commitments excluded.'),
 ('fill_rate_pct', 'Reliability', 'Deliver', 'RL.2.1', '% of Orders Delivered in Full', 'VARIANT',
  'SCOR counts orders delivered complete; ours is a unit fill rate (units shipped / units ordered), which credits partial lines.'),
 ('otif_pct', 'Reliability', 'Deliver', NULL, 'Composite of RL.2.1 (in full) and RL.2.2 (on time)', 'VARIANT',
  'OTIF is an industry convention rather than a SCOR metric: RL.1.1 without the documentation and condition tests.'),
 ('temp_excursion_rate', 'Reliability', 'Deliver', 'RL.2.4', 'Perfect Condition', 'VARIANT',
  'The inverse, for cold chain only: share of shipments whose telemetry breached the temperature threshold.'),
 ('supplier_otd_pct', 'Reliability', 'Source', NULL, '% Orders Received On-Time to Demand Requirement', 'VARIANT',
  'Measured against the date the supplier promised, not the date demand required - the supplier-accountable view.'),
 ('supplier_fill_rate', 'Reliability', 'Source', NULL, '% Orders Received Complete', 'VARIANT',
  'Unit-weighted received over ordered, rather than a count of complete receipts.'),
 ('days_of_inventory', 'Asset Management Efficiency', 'Plan', 'AM.2.2', 'Inventory Days of Supply', 'EXACT',
  'On-hand over average daily demand at one month-end snapshot; never aggregated across snapshots.'),
 ('inventory_value_usd', 'Asset Management Efficiency', 'Plan', NULL, 'Inventory value (input to Return on Working Capital)', 'COMPONENT',
  'On-hand at standard cost at one snapshot. SCOR uses it inside working-capital metrics, not as a metric of its own.'),
 ('landed_cost_per_unit', 'Cost', 'Deliver', NULL, 'Cost to Serve (component of Total Supply Chain Management Cost)', 'COMPONENT',
  'Product plus freight plus duty per unit shipped. A cost-to-serve input, not the SCOR total.'),
 ('landed_cost_usd', 'Cost', 'Deliver', 'CO.1.001', 'Total Supply Chain Management Cost', 'COMPONENT',
  'Covers product, freight and duty only; SCOR also includes planning, sourcing and returns overheads.'),
 ('freight_cost_usd', 'Cost', 'Deliver', NULL, 'Transportation cost (component of CO.1.001)', 'COMPONENT',
  'Accrued freight. The deliver-transportation slice of total supply chain cost.'),
 ('freight_invoiced_usd', 'Cost', 'Deliver', NULL, 'Transportation cost (component of CO.1.001)', 'COMPONENT',
  'Invoiced freight - what carriers billed, as opposed to what was accrued.'),
 ('freight_bill_variance_usd', 'Cost', 'Enable', NULL, 'No SCOR equivalent (freight audit control)', 'NOT_IN_SCOR',
  'A billing-control measure: invoiced minus accrued freight. Serves the Cost attribute.'),
 ('ppv', 'Cost', 'Source', NULL, 'No SCOR equivalent (procurement finance)', 'NOT_IN_SCOR',
  'Purchase price variance is a standard-costing measure used by procurement finance. Serves the Cost attribute.');

-- Every registered metric must be mapped, and nothing may be mapped that is not registered.
SELECT 'every registered metric has a SCOR alignment' AS check_name,
       (SELECT COUNT(*) FROM METRIC_DEFINITION d WHERE NOT EXISTS
          (SELECT 1 FROM METRIC_SCOR_ALIGNMENT a WHERE a.metric_id = d.metric_id)) AS unmapped,
       (SELECT COUNT(*) FROM METRIC_SCOR_ALIGNMENT a WHERE NOT EXISTS
          (SELECT 1 FROM METRIC_DEFINITION d WHERE d.metric_id = a.metric_id)) AS orphaned,
       IFF(unmapped = 0 AND orphaned = 0, 'PASS', 'FAIL') AS status;

GRANT SELECT ON TABLE METRIC_SCOR_ALIGNMENT TO ROLE SC_PLANNER;
GRANT SELECT ON TABLE METRIC_SCOR_ALIGNMENT TO ROLE SC_PROCUREMENT;
GRANT SELECT ON TABLE METRIC_SCOR_ALIGNMENT TO ROLE SC_LOGISTICS;
GRANT SELECT ON TABLE METRIC_SCOR_ALIGNMENT TO ROLE SC_LOGISTICS_EU;
GRANT SELECT ON TABLE METRIC_SCOR_ALIGNMENT TO ROLE SC_ONTOLOGY_STEWARD;

SELECT alignment, COUNT(*) FROM METRIC_SCOR_ALIGNMENT GROUP BY 1 ORDER BY 1;
