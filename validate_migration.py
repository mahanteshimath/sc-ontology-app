import snowflake.connector as sc, json, sys, warnings
warnings.filterwarnings("ignore")
SRC, TGT = "PJRTYEL-AZ37563", "QIXTRLM-IZ68023"
DBS = ["SUPPLY_CHAIN", "SNOWFLAKE_INTELLIGENCE"]

def conn(n): return sc.connect(connection_name=n)
def q(c, sql):
    cur = c.cursor()
    try:
        cur.execute(sql)
        cols = [d[0].lower() for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception as e:
        return [{"error": str(e)[:150]}]

def collect(name):
    c = conn(name); out = {}
    for db in DBS:
        out[f"schemas:{db}"] = sorted(r.get("name", str(r)) for r in q(c, f"SHOW SCHEMAS IN DATABASE {db}"))
        for kind in ["TABLES", "VIEWS", "MATERIALIZED VIEWS", "DYNAMIC TABLES", "SEMANTIC VIEWS", "USER FUNCTIONS",
                     "PROCEDURES", "STREAMS", "TASKS", "STAGES", "FILE FORMATS", "SEQUENCES", "PIPES",
                     "AGENTS", "CORTEX SEARCH SERVICES", "ALERTS", "EXTERNAL TABLES", "MASKING POLICIES",
                     "ROW ACCESS POLICIES", "TAGS", "NOTEBOOKS", "STREAMLITS", "DATA METRIC FUNCTIONS"]:
            rows = q(c, f"SHOW {kind} IN DATABASE {db}")
            if rows and "error" in rows[0]:
                out[f"{kind}:{db}"] = rows[0]["error"][:80]; continue
            out[f"{kind}:{db}"] = sorted(f"{r.get('schema_name', r.get('schema',''))}.{r.get('name','')}" for r in rows)
        # row counts + checksums
        tabs = q(c, f"SELECT table_schema s, table_name t FROM {db}.INFORMATION_SCHEMA.TABLES WHERE table_type='BASE TABLE' AND table_schema<>'INFORMATION_SCHEMA' ORDER BY 1,2")
        for t in tabs:
            fq = f'{db}."{t["s"]}"."{t["t"]}"'
            r = q(c, f"SELECT COUNT(*) n FROM {fq}")
            h = q(c, f"SELECT HASH_AGG(*) h FROM {fq}")
            out[f"DATA:{fq}"] = f'{r[0].get("n", r[0])} | {h[0].get("h", h[0])}'
        cols = q(c, f"SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type k FROM {db}.INFORMATION_SCHEMA.COLUMNS WHERE table_schema<>'INFORMATION_SCHEMA' ORDER BY 1")
        out[f"COLUMNS:{db}"] = sorted(x["k"] for x in cols if "k" in x)
        # view/function/semantic DDL
        for r in q(c, f"SELECT table_schema||'.'||table_name k, view_definition d FROM {db}.INFORMATION_SCHEMA.VIEWS WHERE table_schema<>'INFORMATION_SCHEMA'"):
            if "k" in r: out[f"VIEWDEF:{db}.{r['k']}"] = hash(r["d"].replace("\n", "").replace(" ", "").upper()) if r["d"] else None
        # policies / tags references
        out[f"POLICYREFS:{db}"] = sorted(f'{r.get("policy_name")}->{r.get("ref_entity_name")}.{r.get("ref_column_name")}'
            for r in q(c, f"SELECT * FROM TABLE({db}.INFORMATION_SCHEMA.POLICY_REFERENCES(REF_ENTITY_DOMAIN=>'TABLE', REF_ENTITY_NAME=>'{db}.' || 'X'))") if "error" not in r)
        out[f"GRANTS:{db}"] = sorted(f'{r.get("privilege")}|{r.get("granted_on")}|{r.get("name")}|{r.get("grantee_name")}'
            for r in q(c, f"SHOW GRANTS ON DATABASE {db}") if "error" not in r)
    out["ROLES"] = sorted(r.get("name", "") for r in q(c, "SHOW ROLES"))
    out["USERS"] = sorted(r.get("name", "") for r in q(c, "SHOW USERS"))
    out["WAREHOUSES"] = sorted(f'{r.get("name")}|{r.get("size")}|{r.get("auto_suspend")}' for r in q(c, "SHOW WAREHOUSES"))
    out["INTEGRATIONS"] = sorted(f'{r.get("name")}|{r.get("type")}' for r in q(c, "SHOW INTEGRATIONS"))
    out["NETWORK POLICIES"] = sorted(r.get("name", "") for r in q(c, "SHOW NETWORK POLICIES"))
    out["RESOURCE MONITORS"] = sorted(r.get("name", "") for r in q(c, "SHOW RESOURCE MONITORS"))
    out["SHARES"] = sorted(r.get("name", "") for r in q(c, "SHOW SHARES"))
    out["APP SERVICES"] = sorted(r.get("name", "") for r in q(c, "SHOW APPLICATION SERVICES"))
    out["COMPUTE POOLS"] = sorted(r.get("name", "") for r in q(c, "SHOW COMPUTE POOLS"))
    out["ROLE GRANTS (ACCOUNT)"] = sorted(f'{r.get("role")}->{r.get("granted_to")}:{r.get("grantee_name")}' for r in q(c, "SHOW GRANTS OF ROLE ACCOUNTADMIN") if "error" not in r)
    return out

s, t = collect(SRC), collect(TGT)
json.dump({"src": s, "tgt": t}, open("validation_raw.json", "w"), default=str, indent=1)
ok = bad = 0
for k in sorted(set(s) | set(t)):
    if s.get(k) == t.get(k): ok += 1; continue
    bad += 1; print(f"\nDIFF {k}")
    sv, tv = s.get(k), t.get(k)
    if isinstance(sv, list) and isinstance(tv, list):
        print("  only in SOURCE:", sorted(set(sv) - set(tv))[:25]); print("  only in TARGET:", sorted(set(tv) - set(sv))[:25])
    else: print("  SRC:", sv, "\n  TGT:", tv)
print(f"\nMATCH={ok} DIFF={bad}")
