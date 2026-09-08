"""Exercise the actual upgrade against previous-schema sample data, in a separate database."""

import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

from psycopg import connect, sql
from sqlalchemy.engine import make_url


def test_upgrade_preserves_existing_specifications():
    from shortfilm.config import settings

    url = make_url(settings.database_url)
    database = "shortfilm_migration_" + uuid4().hex[:12]
    admin = url.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False
    )
    with connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    env = {
        **os.environ,
        "SHORTFILM_DATABASE_URL": url.set(database=database).render_as_string(hide_password=False),
    }
    command = [
        str(Path("services/backend/.venv/bin/alembic").resolve()),
        "-c",
        "services/backend/alembic.ini",
        "upgrade",
    ]
    try:
        subprocess.run([*command, "20260908_m1_story"], env=env, check=True)
        connection = url.set(drivername="postgresql", database=database).render_as_string(
            hide_password=False
        )
        with connect(connection) as conn:
            conn.execute(
                "INSERT INTO principals(id,name) VALUES (%s,%s)", (settings.local_owner_id, "测试")
            )
            for name, value in [
                ("missing", None),
                ("partial", {"aspect_ratio": "16:9", "custom": "preserved"}),
                ("complete", {"aspect_ratio": "1:1", "resolution": "4K", "revision": 8}),
            ]:
                conn.execute(
                    "INSERT INTO projects(id,owner_id,name,market,stage,status,revision,generation_settings) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        uuid4(),
                        settings.local_owner_id,
                        name,
                        "zh",
                        "idea",
                        "in_progress",
                        1,
                        json.dumps(value) if value else None,
                    ),
                )
        subprocess.run([*command, "head"], env=env, check=True)
        with connect(connection) as conn:
            rows = dict(conn.execute("SELECT name,generation_settings FROM projects").fetchall())
            assert rows["partial"]["aspect_ratio"] == "16:9"
            assert rows["partial"]["custom"] == "preserved"
            assert rows["partial"]["migration_source"]
            assert rows["missing"]["resolution"] == "1080P"
            assert rows["complete"] == {"aspect_ratio": "1:1", "resolution": "4K", "revision": 8}
    finally:
        with connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))
