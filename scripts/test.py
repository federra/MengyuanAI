"""Run tests only in a fresh disposable PostgreSQL database/media directory."""

import os
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

from psycopg import connect, sql
from shortfilm.config import settings
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
url = make_url(settings.database_url)
name = "shortfilm_test_" + uuid4().hex[:12]
admin = url.set(drivername="postgresql", database="postgres").render_as_string(hide_password=False)
with connect(admin, autocommit=True) as conn:
    conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
try:
    with tempfile.TemporaryDirectory(prefix="shortfilm-test-") as media:
        env = {
            **os.environ,
            "SHORTFILM_DATABASE_URL": url.set(database=name).render_as_string(hide_password=False),
            "SHORTFILM_STORAGE_ROOT": media,
            "SHORTFILM_CREDENTIAL_ROOT": str(Path(media) / "credential-vault"),
        }
        for cmd in [
            [
                "services/backend/.venv/bin/alembic",
                "-c",
                "services/backend/alembic.ini",
                "upgrade",
                "head",
            ],
            [
                "services/backend/.venv/bin/alembic",
                "-c",
                "services/backend/alembic.ini",
                "upgrade",
                "head",
            ],
            [
                "services/backend/.venv/bin/alembic",
                "-c",
                "services/backend/alembic.ini",
                "downgrade",
                "base",
            ],
            [
                "services/backend/.venv/bin/alembic",
                "-c",
                "services/backend/alembic.ini",
                "upgrade",
                "head",
            ],
            ["services/backend/.venv/bin/python", "-m", "shortfilm.seed"],
            ["services/backend/.venv/bin/python", "-m", "pytest", "tests", "-q"],
        ]:
            subprocess.run(cmd, env=env, check=True)
finally:
    with connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
