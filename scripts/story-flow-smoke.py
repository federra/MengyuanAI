"""True browser/API/PG story smoke; fresh DB, empty vault, no worker/provider.

Run: PYTHONPATH="$PWD/services/backend/src" services/backend/.venv/bin/python scripts/story-flow-smoke.py
Requires a built apps/web/dist, local PostgreSQL, Node and installed Chrome.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen
from uuid import uuid4

from psycopg import connect, sql
from shortfilm.config import settings
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
OUTPUT = ROOT / "evidence/story-flow"
OUTPUT.mkdir(parents=True, exist_ok=True)
url = make_url(settings.database_url)
if url.query:
    raise SystemExit("Refusing database URL overrides")
name = "shortfilm_test_storyflow_" + uuid4().hex[:12]
admin = url.set(drivername="postgresql", database="postgres").render_as_string(hide_password=False)
report = {"database": name, "workerStarted": False, "providerCalls": 0, "cleanedUp": False}
server = None
created = False
try:
    with connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    created = True
    with tempfile.TemporaryDirectory(prefix="shortfilm-storyflow-") as temporary:
        vault = Path(temporary) / "empty-credentials"
        vault.mkdir()
        # Explicit environment does not inherit any provider keys or private vault setting.
        env = {
            key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ
        }
        env.update(
            {
                "PYTHONPATH": str(ROOT / "services/backend/src"),
                "SHORTFILM_DATABASE_URL": url.set(database=name).render_as_string(
                    hide_password=False
                ),
                "SHORTFILM_STORAGE_ROOT": str(Path(temporary) / "media"),
                "SHORTFILM_CREDENTIAL_ROOT": str(vault),
            }
        )
        with (OUTPUT / "server.log").open("w") as log:
            subprocess.run(
                [
                    "services/backend/.venv/bin/alembic",
                    "-c",
                    "services/backend/alembic.ini",
                    "upgrade",
                    "head",
                ],
                env=env,
                check=True,
                stdout=log,
                stderr=log,
            )
            subprocess.run(
                [sys.executable, "-m", "shortfilm.seed"],
                env=env,
                check=True,
                stdout=log,
                stderr=log,
            )
            # Reserve the listener before starting uvicorn; never stop another service.
            listener = socket.socket()
            try:
                listener.bind(("127.0.0.1", 8012))
            except OSError:
                listener.bind(("127.0.0.1", 0))
            listener.listen(128)
            port = listener.getsockname()[1]
            origin = f"http://127.0.0.1:{port}"
            report["origin"] = origin
            env["SHORTFILM_PUBLIC_ORIGIN"] = origin
            code = (
                "from shortfilm.main import app; "
                "from fastapi.staticfiles import StaticFiles; import uvicorn; "
                "app.mount('/', StaticFiles(directory='apps/web/dist', html=True), name='web'); "
                f"uvicorn.run(app, fd={listener.fileno()}, log_level='warning')"
            )
            server = subprocess.Popen(
                [sys.executable, "-c", code],
                env=env,
                pass_fds=(listener.fileno(),),
                stdout=log,
                stderr=log,
            )
            listener.close()
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError("Temporary API exited; see server.log")
                try:
                    with urlopen(origin + "/health/ready", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Temporary API did not become ready")
            subprocess.run(["node", "scripts/story-flow-smoke.mjs", origin], env=env, check=True)
            test_url = url.set(drivername="postgresql", database=name).render_as_string(
                hide_password=False
            )
            with connect(test_url) as conn:
                report["databaseJobs"] = conn.execute("SELECT count(*) FROM generation_jobs").fetchone()[0]
                report["databaseProjects"] = conn.execute(
                    "SELECT count(*) FROM projects"
                ).fetchone()[0]
                report["databaseVersions"] = conn.execute(
                    "SELECT count(*) FROM content_versions"
                ).fetchone()[0]
            assert report["databaseJobs"] == 0
            assert report["databaseProjects"] == 2
            report["passed"] = True
finally:
    if server:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
    if created:
        with connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        report["cleanedUp"] = True
    (OUTPUT / "isolation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))
