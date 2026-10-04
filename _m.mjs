import { connectNamed, query } from "./scripts/sf.mjs"
const s = await connectNamed("PJRTYEL-AZ37563"), t = await connectNamed("QIXTRLM-IZ68023")
for (const c of [s,t]) await query(c,"USE ROLE ACCOUNTADMIN")
const TABLES = ["AGENT_EVAL_RUN","AGENT_EVAL_RESULT","AGENT_PARITY_RESULT","AGENT_QUESTION_LOG","METRIC_DRIFT_RESULT","DQ_CHECK_RESULT","CERTIFICATION_SNAPSHOT","CI_GATE_RUN","ONTOLOGY_HIERARCHY_VALIDATION","PREDICTION_BACKTEST","VOLUME_BACKTEST_FORECAST","METRIC_PREDICTION","QUESTION_DEMAND","METRIC_DRIFT_BASELINE"]
for (const T of TABLES) {
  try {
    const cols = await query(t,`SELECT column_name, data_type, numeric_precision p, numeric_scale sc FROM SUPPLY_CHAIN.INFORMATION_SCHEMA.COLUMNS WHERE table_schema='GOVERNANCE' AND table_name='${T}' ORDER BY ordinal_position`)
    const ty = c => c.DATA_TYPE==="NUMBER"?`NUMBER(${c.P},${c.SC})`:c.DATA_TYPE==="TEXT"?"VARCHAR":c.DATA_TYPE.startsWith("TIMESTAMP_LTZ")?"TIMESTAMP_LTZ":c.DATA_TYPE==="FIXED"?"NUMBER":c.DATA_TYPE
    const rows = await query(s,`SELECT TO_JSON(OBJECT_CONSTRUCT(*)) j FROM SUPPLY_CHAIN.GOVERNANCE.${T}`)
    await query(t,`TRUNCATE TABLE SUPPLY_CHAIN.GOVERNANCE.${T}`)
    const sel = cols.map(c=>`PARSE_JSON(?):"${c.COLUMN_NAME}"::${ty(c)}`).join(", ")
    for (let i=0;i<rows.length;i++){ await query(t,`INSERT INTO SUPPLY_CHAIN.GOVERNANCE.${T} SELECT ${cols.map(c=>`v:"${c.COLUMN_NAME}"::${ty(c)}`).join(", ")} FROM (SELECT PARSE_JSON(?) v)`,[rows[i].J]) }
    const h = async c => JSON.stringify((await query(c,`SELECT COUNT(*) n FROM SUPPLY_CHAIN.GOVERNANCE.${T}`))[0])
    console.log(T, "src", await h(s), "tgt", await h(t))
  } catch(e){ console.log(T,"ERR",String(e.message).slice(0,120)) }
}
s.destroy(()=>{}); t.destroy(()=>{})
