"""Restore an existing backup into a disposable database and verify V13 upgrade.

Never writes the source database, media or credentials. No worker is started.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from psycopg import connect, sql
from shortfilm.config import settings
from sqlalchemy.engine import make_url

root = Path(__file__).resolve().parents[1]
backup = Path(sys.argv[1]).resolve()
assert (backup / "database.dump").is_file() and (backup / "manifest.json").is_file()
url = make_url(settings.database_url)
name = "shortfilm_restore_v13_" + uuid4().hex[:12]
admin = url.set(drivername="postgresql", database="postgres").render_as_string(hide_password=False)
isolated = url.set(drivername="postgresql", database=name).render_as_string(hide_password=False)
env = {**os.environ, "PGHOST": url.host or "127.0.0.1", "PGPORT": str(url.port or 5432), "PGUSER": url.username or "", "PGPASSWORD": url.password or "", "PGDATABASE": name,
       "SHORTFILM_DATABASE_URL": url.set(database=name).render_as_string(hide_password=False),
       "SHORTFILM_STORAGE_ROOT": str(backup / "media"), "PYTHONPATH": str(root / "services/backend/src")}

def inventory(conn):
    tables = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename != 'alembic_version' ORDER BY tablename").fetchall()
    result = {}
    for (table,) in tables:
        rows = conn.execute(sql.SQL("SELECT row_to_json(t)::text FROM {} t ORDER BY row_to_json(t)::text").format(sql.Identifier(table))).fetchall()
        result[table] = {"rows": len(rows), "sha256": hashlib.sha256("\n".join(row[0] for row in rows).encode()).hexdigest()}
    return result

with connect(admin, autocommit=True) as conn:
    conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
try:
    subprocess.run(["/opt/homebrew/opt/postgresql@18/bin/pg_restore", "--exit-on-error", "--no-owner", "--dbname", name, str(backup / "database.dump")], env=env, check=True)
    with connect(isolated) as conn:
        before = inventory(conn)
    subprocess.run([sys.executable, "-m", "alembic", "-c", "services/backend/alembic.ini", "upgrade", "head"], cwd=root, env=env, check=True)
    with connect(isolated) as conn:
        after = inventory(conn)
        assert all(after[table] == value for table, value in before.items()), "Existing rows changed"
        revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
        rows = conn.execute("SELECT object_key,sha256 FROM media_files ORDER BY object_key").fetchall()
        for key, digest in rows:
            assert hashlib.sha256((backup / "media" / key).read_bytes()).hexdigest() == digest
    with tempfile.TemporaryDirectory(prefix="shortfilm-restore-credentials-") as credentials:
        env["SHORTFILM_CREDENTIAL_ROOT"] = credentials
        code = '''from fastapi.testclient import TestClient
from shortfilm.main import app
c=TestClient(app)
r=c.get('/api/v1/projects'); assert r.status_code==200,r.text
for p in r.json()['items']:
 base='/api/v1/projects/'+p['id']
 for suffix in ['/stages/board','/finishing','/storyboard/import/assets']:
  response=c.get(base+suffix); assert response.status_code==200,(suffix,response.text)
print('Restored API: projects, boards, finishing and import descriptors readable; no worker/model calls')
'''
        subprocess.run([sys.executable, "-c", code], cwd=root, env=env, check=True)
    report = {"backup": str(backup), "migration": revision, "existingTables": before, "fileCount": len(rows), "existingRowsUnchanged": True, "mediaHashesUnchanged": True, "credentials": "not copied or read", "modelCalls": 0}
    destination = root / "evidence/v12-v13-restore.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    print(f"Isolated restore/upgrade passed: {len(before)} existing tables, {len(rows)} media files; report {destination}")
finally:
    with connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
