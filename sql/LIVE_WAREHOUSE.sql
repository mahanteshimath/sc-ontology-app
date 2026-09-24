-- ============================================================================
-- LIVE_WAREHOUSE.sql — live warehouse DDL, pulled 2026-09-24T07:44:28.711Z
-- ============================================================================

USE ROLE ACCOUNTADMIN;

create or replace warehouse COMPUTE_WH
with
	warehouse_type='STANDARD'
	generation='2'
	warehouse_size='X-Small'
	max_cluster_count=1
	min_cluster_count=1
	scaling_policy=STANDARD
	auto_suspend=60
	auto_resume=TRUE
	initially_suspended=TRUE
	enable_query_acceleration=TRUE
	query_acceleration_max_scale_factor=2
	max_concurrency_level=8
	statement_queued_timeout_in_seconds=0
	statement_timeout_in_seconds=172800
;
