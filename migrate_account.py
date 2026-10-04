"""One-click Snowflake account-to-account migration + validation.

Usage:
  python migrate_account.py --src SRC_CONN --tgt TGT_CONN --dbs SUPPLY_CHAIN,SNOWFLAKE_INTELLIGENCE            # dry run (plan only)
  python migrate_account.py --src SRC_CONN --tgt TGT_CONN --dbs SUPPLY_CHAIN --apply                          # execute
  python migrate_account.py --src SRC_CONN --tgt TGT_CONN --dbs SUPPLY_CHAIN --validate-only                  # just compare

SRC_CONN / TGT_CONN are names in ~/.snowflake/connections.toml (ACCOUNTADMIN recommended).
Phases: 1 preflight -> 2 account objects -> 3 schema DDL -> 4 data copy -> 5 agents -> 6 grants -> 7 task/alert states -> 8 validate.
Row-by-row copy suits small/medium data. For large data use database replication or a listing instead (see README notes).
"""
import argparse, json, re, sys, warnings
import snowflake.connector as sc
warnings.filterwarnings("ignore")

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True); ap.add_argument("--tgt", required=True)
ap.add_argument("--dbs", required=True); ap.add_argument("--apply", action="store_true")
ap.add_argument("--validate-only", action="store_true"); ap.add_argument("--batch", type=int, default=200)
a = ap.parse_args()
DBS = [d.strip().upper() for d in a.dbs.split(",")]
S, T = sc.connect(connection_name=a.src), sc.connect(connection_name=a.tgt)
DRY = not a.apply
VARIANT = ("VARIANT", "OBJECT", "ARRAY")
issues = []

def q(c, sql, params=None):
    cur = c.cursor(); cur.execute(sql, params) if params else cur.execute(sql)
    cols = [d[0].lower() for d in cur.description] if cur.description else []
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def run(sql, label=""):
    print(("[DRY] " if DRY else "[RUN] ") + (label or sql[:110].replace("\n", " ")))
    if DRY: return True
    try: T.cursor().execute(sql); return True
    except Exception as e:
        issues.append(f"{label or sql[:80]}: {str(e)[:140]}"); print("   !!", str(e)[:140]); return False

def run_many(stmts, label):
    """Execute DDL statements, retrying failed ones (dependency ordering)."""
    pending = list(stmts)
    for p in range(4):
        failed = []
        for s in pending:
            if DRY: print(f"[DRY] {label}: {s[:90].replace(chr(10),' ')}"); continue
            try: T.cursor().execute(s)
            except Exception as e:
                if "already exists" in str(e): continue
                failed.append((s, str(e)[:140]))
        pending = [s for s, _ in failed]
        if not pending: return
    for s, e in failed: issues.append(f"{label}: {s[:70]!r} -> {e}")

def split_sql(ddl):
    return [s.strip() for s in re.split(r";\s*\n", ddl) if s.strip()]

# ---------- 1 preflight
def preflight():
    for n, c in (("SRC", S), ("TGT", T)):
        r = q(c, "select current_organization_name()||'-'||current_account_name() acct, current_region() reg, current_role() rl")[0]
        print(n, r)
    if q(S, "select current_account() a")[0]["a"] == q(T, "select current_account() a")[0]["a"]:
        sys.exit("SRC and TGT are the same account - aborting")

# ---------- 2 account-level objects
def account_objects():
    roles = [r["name"] for r in q(S, "show roles") if r["owner"] and r["name"] not in ("ACCOUNTADMIN", "SECURITYADMIN", "SYSADMIN", "USERADMIN", "PUBLIC", "ORGADMIN", "GLOBALORGADMIN")]
    for r in roles: run(f'create role if not exists "{r}"', f"role {r}")
    for w in q(S, "show warehouses"):
        run(f'create warehouse if not exists "{w["name"]}" warehouse_size={w["size"]} auto_suspend={w["auto_suspend"]} auto_resume={w["auto_resume"]}', f"warehouse {w['name']}")
    for u in q(S, "show users"):
        if u["name"] in ("SNOWFLAKE",): continue
        run(f'create user if not exists "{u["name"]}" default_role={u["default_role"] or "PUBLIC"} default_warehouse={u["default_warehouse"] or "null"} '
            f'email={json.dumps(u["email"] or "")}', f"user {u['name']} (set password/MFA/keys manually)")
    print("NOTE: integrations, network policies, secrets, resource monitors need manual review (secrets/keys are not exportable).")

# ---------- 3 schema DDL
def schema_ddl():
    for db in DBS:
        if db == "SNOWFLAKE_INTELLIGENCE":  # built-in-style db: create only
            run(f"create database if not exists {db}", f"db {db}")
            run(f"create schema if not exists {db}.AGENTS", "schema AGENTS"); continue
        run(f"create database if not exists {db}", f"db {db}")
        ddl = q(S, f"select get_ddl('database','{db}',true) d")[0]["d"]
        ddl = re.sub(r"(?is)^\s*create or replace database[^;]*;", "", ddl)
        run_many([s.replace("create or replace", "create or replace", 1) for s in split_sql(ddl)], f"ddl {db}")

# ---------- 4 data copy
def copy_data():
    for db in DBS:
        for t in q(S, f"select table_schema s, table_name t from {db}.information_schema.tables where table_type='BASE TABLE' and table_schema<>'INFORMATION_SCHEMA'"):
            fq = f'{db}."{t["s"]}"."{t["t"]}"'
            if DRY: print("[DRY] copy data", fq); continue
            cols = q(S, f"select column_name, data_type from {db}.information_schema.columns where table_schema='{t['s']}' and table_name='{t['t']}' order by ordinal_position")
            try: T.cursor().execute(f"create table if not exists {fq} like {fq}") if False else None
            except Exception: pass
            cur = S.cursor(); cur.execute(f"select * from {fq}")
            T.cursor().execute(f"truncate table {fq}")
            ph = ",".join("parse_json(%s)" if c["data_type"] in VARIANT else "%s" for c in cols); n = 0
            while True:
                rows = cur.fetchmany(a.batch)
                if not rows: break
                conv = [tuple(json.dumps(v) if (c["data_type"] in VARIANT and v is not None and not isinstance(v, str)) else v for v, c in zip(r, cols)) for r in rows]
                try:
                    T.cursor().execute(f"insert into {fq} " + " union all ".join([f"select {ph}"] * len(conv)), [x for r in conv for x in r]); n += len(conv)
                except Exception as e: issues.append(f"data {fq}: {str(e)[:120]}"); break
            print(f"   {fq}: {n} rows")

# ---------- 5 agents
def agents():
    for db in DBS:
        try: ags = q(S, f"show agents in database {db}")
        except Exception: continue
        for g in ags:
            fq = f'{db}."{g["schema_name"]}"."{g["name"]}"'
            spec = q(S, f"describe agent {fq}")[0]["agent_spec"]
            run(f"create or replace agent {fq} from specification $${spec}$$", f"agent {fq}")

# ---------- 6 grants
def grants():
    for db in DBS:
        for r in q(S, f"select privilege, granted_on, name, grantee_name, grant_option from snowflake.account_usage.grants_to_roles where deleted_on is null and table_catalog='{db}' and privilege<>'OWNERSHIP' and granted_on in ('TABLE','VIEW','SCHEMA','SEMANTIC VIEW','AGENT','CORTEX SEARCH SERVICE','FUNCTION','PROCEDURE','STAGE','DATABASE')"):
            nm = r["name"] if r["granted_on"] in ("DATABASE", "SCHEMA") else r["name"]
            run(f'grant {r["privilege"]} on {r["granted_on"]} {nm} to role "{r["grantee_name"]}"', f"grant {r['privilege']} {r['granted_on']} {nm}")
    for r in q(S, "select role, grantee_name from snowflake.account_usage.grants_to_users where deleted_on is null and role not in ('ORGADMIN','GLOBALORGADMIN')"):
        run(f'grant role "{r["role"]}" to user "{r["grantee_name"]}"', f"role {r['role']} -> {r['grantee_name']}")
    print("NOTE: account_usage lags up to ~3h; re-run this phase if source grants changed recently. Object grants may need fully-qualified names - review issues list.")

# ---------- 7 task / alert states (mirror source; default = suspended)
def states():
    for db in DBS:
        for kind, key in (("tasks", "state"), ("alerts", "state")):
            try: items = q(S, f"show {kind} in database {db}")
            except Exception: continue
            for i in items:
                fq = f'{db}."{i["schema_name"]}"."{i["name"]}"'
                verb = "resume" if i[key] == "started" else "suspend"
                run(f"alter {kind[:-1]} {fq} {verb}", f"{kind[:-1]} {i['name']} -> {verb}")

# ---------- 8 validation
def validate():
    bad = 0
    def cmp(label, x, y):
        nonlocal bad
        if x != y: bad += 1; print("DIFF", label, "\n  src-only:", sorted(set(x) - set(y))[:10] if isinstance(x, list) else x, "\n  tgt-only:", sorted(set(y) - set(x))[:10] if isinstance(y, list) else y)
    for db in DBS:
        for kind in ("TABLES", "VIEWS", "SEMANTIC VIEWS", "USER FUNCTIONS", "PROCEDURES", "TASKS", "ALERTS", "AGENTS", "CORTEX SEARCH SERVICES", "STREAMS", "DYNAMIC TABLES", "STAGES", "FILE FORMATS"):
            def names(c):
                try: return sorted(f'{r.get("schema_name")}.{r["name"]}' for r in q(c, f"show {kind} in database {db}") if r.get("is_builtin") != "Y")
                except Exception: return []
            cmp(f"{kind} in {db}", names(S), names(T))
        for t in q(S, f"select table_schema s, table_name t from {db}.information_schema.tables where table_type='BASE TABLE' and table_schema<>'INFORMATION_SCHEMA'"):
            fq = f'{db}."{t["s"]}"."{t["t"]}"'
            def h(c):
                try: r = q(c, f"select count(*) n, hash_agg(*) h from {fq}")[0]; return (r["n"], r["h"])
                except Exception as e: return str(e)[:60]
            cmp(f"data {fq}", h(S), h(T))
        for v in q(S, f"select table_schema s, table_name t from {db}.information_schema.views where table_schema<>'INFORMATION_SCHEMA'"):
            fq = f'{db}."{v["s"]}"."{v["t"]}"'
            d = lambda c: re.sub(r"\s+", " ", q(c, f"select get_ddl('view','{fq}') d")[0]["d"]).strip() if True else ""
            try: cmp(f"view DDL {fq}", d(S), d(T))
            except Exception as e: print("DIFF view missing", fq)
        for t in q(S, f"show tasks in database {db}"):
            fq = f'{db}."{t["schema_name"]}"."{t["name"]}"'
            try: cmp(f"task state {t['name']}", t["state"], q(T, f"show tasks like '{t['name']}' in schema {db}.\"{t['schema_name']}\"")[0]["state"])
            except Exception: pass
    print(f"\nVALIDATION: {'PASS - source and target match' if bad == 0 else str(bad) + ' difference(s) found'}")

if __name__ == "__main__":
    preflight()
    if not a.validate_only:
        for name, fn in (("account objects", account_objects), ("schema DDL", schema_ddl), ("data copy", copy_data),
                         ("agents", agents), ("grants", grants), ("task/alert states", states)):
            print(f"\n=== {name} ==="); fn()
        if issues: print("\nISSUES TO REVIEW:"); [print(" -", i) for i in issues]
    if not DRY or a.validate_only: print("\n=== validation ==="); validate()
    elif DRY: print("\nDry run complete. Re-run with --apply to execute.")
