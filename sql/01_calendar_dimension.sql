-- ---------------------------------------------------------------------------
-- Phase 1a — Add a conformed CALENDAR dimension to SC_ONTOLOGY_360.
--
-- Why: before this change every fact carried its own month dimension
-- (RECEIPT_MONTH, DELIVERY_MONTH, SNAPSHOT_MONTH, COMPLETION_MONTH, ...) and
-- there was no shared time entity. That made cross-fact time comparison
-- inexpressible — you could not ask for inbound supplier OTD and outbound
-- customer OTD for the same month in one query — which contradicted the
-- "conformed dimension" claim the ontology makes for every other shared entity.
--
-- Design notes:
--   * CALENDAR is backed by SUPPLY_CHAIN.RAW.DATE_DIM (2024-01-01..2026-12-31),
--     which already carries month/quarter/year roll-ups and a calendar-aligned
--     fiscal quarter.
--   * LANDED_COST deliberately has NO direct relationship to CALENDAR. It
--     already reaches ORDER_FULFILLMENT via COST_TO_FULFILLMENT, so a direct
--     edge would create two paths to CALENDAR and every landed-cost metric
--     would fail with a multi-path error. This mirrors how LANDED_COST already
--     reaches PART only through ORDER_FULFILLMENT.
--   * FORECAST is not joined to CALENDAR: FORECAST.PERIOD is a 'YYYY-MM' string,
--     not a date, so it has no day-grain key to join on. It keeps its own
--     FORECAST_PERIOD dimension.
--   * IS_FUTURE exists so the application can exclude future-dated rows from
--     realized-service metrics. ~2.8% of shipment rows are dated after today.
--   * The table comment must contain the exact phrase "Conformed dimension":
--     GOVERNANCE.ONTOLOGY_ENTITY derives ENTITY_ROLE from the comment text (so
--     that the catalogue can never drift from the deployed view), and wording it
--     as "conformed time dimension" classifies CALENDAR as a bare ENTITY instead,
--     which makes the dimension and fact counts on /ontology fail to add up.
--
-- The statement is built by string-extending the deployed DDL rather than being
-- hand-transcribed, so the 18 KB of existing definition cannot be corrupted by a
-- typo. CREATE OR ALTER is used so existing grants survive.
-- ---------------------------------------------------------------------------

USE DATABASE SUPPLY_CHAIN;
USE SCHEMA SEMANTIC;

DECLARE
  ddl STRING;

  -- New logical table, inserted before the first existing table entry.
  cal_table STRING := $$CALENDAR as SUPPLY_CHAIN.RAW.DATE_DIM primary key (DATE_KEY) with synonyms=('calendar','date','time','period','month','when') comment='sco:CalendarDay - the shared time entity. Conformed dimension. Shared by every fact that has a day-grain event date, so inbound, outbound, inventory and manufacturing metrics can be compared over the same period.', $$;

  -- One path from each day-grain fact to CALENDAR. See the header note on why
  -- LANDED_COST and FORECAST are absent.
  cal_rels STRING := $$PO_TO_CALENDAR as PURCHASE_ORDER(RECEIPT_DATE) references CALENDAR(DATE_KEY), FULFILLMENT_TO_CALENDAR as ORDER_FULFILLMENT(DELIVERY_DATE) references CALENDAR(DATE_KEY), INVENTORY_TO_CALENDAR as INVENTORY(SNAPSHOT_DATE) references CALENDAR(DATE_KEY), PRODUCTION_TO_CALENDAR as PRODUCTION_ORDER(COMPLETED_DATE) references CALENDAR(DATE_KEY), $$;

  cal_dims STRING := $$CALENDAR.CAL_DATE as calendar.date_key with synonyms=('date','day','event date') comment='Calendar day - lowest level of the time hierarchy. The event date of the fact: goods receipt for inbound, delivery for outbound, snapshot for inventory, completion for production.', CALENDAR.CAL_MONTH as calendar.month_start with synonyms=('month','period','monthly') comment='First day of the calendar month - level 2 of the time hierarchy.', CALENDAR.CAL_PERIOD as calendar.period with synonyms=('period label','yyyy-mm') comment='Calendar month as a YYYY-MM label.', CALENDAR.CAL_QUARTER as calendar.fiscal_quarter with synonyms=('quarter','fiscal quarter','q1','q2','q3','q4') comment='Fiscal quarter, calendar-aligned - level 3 of the time hierarchy.', CALENDAR.CAL_YEAR as calendar.year_num with synonyms=('year','annual') comment='Calendar year - top level of the time hierarchy.', CALENDAR.IS_FUTURE as IFF(calendar.date_key > CURRENT_DATE(), 1, 0) with synonyms=('future dated','not yet happened','open backlog') comment='1 when the event date is after today. Realized-service metrics must exclude these rows; they represent promised future activity, not measured performance.', CALENDAR.IS_WEEKDAY as IFF(calendar.is_weekday, 1, 0) comment='1 for Monday-Friday.', $$;
BEGIN
  ddl := GET_DDL('SEMANTIC_VIEW', 'SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360');

  -- CREATE OR REPLACE drops grants; CREATE OR ALTER preserves them.
  ddl := REPLACE(ddl, 'create or replace semantic view SC_ONTOLOGY_360',
                      'create or alter semantic view SUPPLY_CHAIN.SEMANTIC.SC_ONTOLOGY_360');

  -- Anchor each insertion on a string that occurs exactly once in the DDL.
  ddl := REPLACE(ddl, 'SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)',
                      cal_table || 'SUPPLY_CHAIN.RAW.PART primary key (MATERIAL_ID)');
  ddl := REPLACE(ddl, 'PO_TO_PART as PURCHASE_ORDER(MATERIAL_ID)',
                      cal_rels || 'PO_TO_PART as PURCHASE_ORDER(MATERIAL_ID)');
  ddl := REPLACE(ddl, 'PART.MATERIAL as part.material_id',
                      cal_dims || 'PART.MATERIAL as part.material_id');

  EXECUTE IMMEDIATE ddl;
  RETURN 'SC_ONTOLOGY_360 extended with the CALENDAR conformed dimension';
END;
