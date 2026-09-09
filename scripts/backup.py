"""Local backup/isolated restore rehearsal. Stop writers before backup."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from psycopg import connect, sql
from shortfilm.config import settings
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
url = make_url(settings.database_url)
connection_url = url.set(drivername="postgresql").render_as_string(hide_password=False)
admin_url = url.set(drivername="postgresql", database="postgres").render_as_string(
    hide_password=False
)


def binary(name):
    found = shutil.which(name)
    fallback = Path("/opt/homebrew/opt/postgresql@18/bin") / name
    if found:
        return found
    if fallback.exists():
        return str(fallback)
    raise SystemExit(f"Missing PostgreSQL client: {name}")


def pg_env(database):
    # Secrets are passed via process environment, never command line/logs.
    return {
        **os.environ,
        "PGHOST": url.host or "127.0.0.1",
        "PGPORT": str(url.port or 5432),
        "PGUSER": url.username or "",
        "PGPASSWORD": url.password or "",
        "PGDATABASE": database,
    }


def backup():
    destination = ROOT / ".local/backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination.mkdir(parents=True)
    with connect(connection_url) as conn:
        active = conn.execute(
            "SELECT count(*) FROM generation_jobs WHERE state IN ('queued','running','waiting_provider','waiting_dependency','cancel_requested')"
        ).fetchone()[0]
        if active:
            raise SystemExit("仍有在途任务，请完成或对账后停写备份。")
        unresolved = conn.execute(
            "SELECT id, state FROM generation_jobs WHERE state = 'unknown' ORDER BY id"
        ).fetchall()
        rows = conn.execute(
            "SELECT object_key, sha256 FROM media_files ORDER BY object_key"
        ).fetchall()
    subprocess.run(
        [binary("pg_dump"), "--format=custom", "--file", str(destination / "database.dump")],
        env=pg_env(url.database),
        check=True,
    )
    manifest = []
    for key, expected in rows:
        source = settings.storage_root / key
        target = destination / "media" / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit("备份文件校验失败；该备份不可用。")
        manifest.append({"objectKey": key, "sha256": actual})
    (destination / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "files": manifest,
                "unresolvedJobs": [
                    {"jobId": str(jid), "state": state} for jid, state in unresolved
                ],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Backup verified: {destination.relative_to(ROOT)} ({len(rows)} files)")
    return destination


def restore_check():
    candidates = sorted((ROOT / ".local/backups").glob("*/manifest.json"))
    if not candidates:
        raise SystemExit("请先运行 make backup。")
    source = candidates[-1].parent
    manifest = json.loads((source / "manifest.json").read_text())
    name = "shortfilm_restore_" + uuid4().hex[:12]
    destination = ROOT / ".local/restore-check" / name
    with connect(admin_url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        subprocess.run(
            [
                binary("pg_restore"),
                "--exit-on-error",
                "--no-owner",
                "--dbname",
                name,
                str(source / "database.dump"),
            ],
            env=pg_env(name),
            check=True,
        )
        shutil.copytree(source / "media", destination) if (
            source / "media"
        ).exists() else destination.mkdir(parents=True)
        restored_url = url.set(drivername="postgresql", database=name).render_as_string(
            hide_password=False
        )
        with connect(restored_url) as conn:
            rows = conn.execute(
                "SELECT object_key, sha256 FROM media_files ORDER BY object_key"
            ).fetchall()
            assert len(rows) == len(manifest["files"])
            for key, digest in rows:
                assert hashlib.sha256((destination / key).read_bytes()).hexdigest() == digest
            unresolved = conn.execute(
                "SELECT id, state FROM generation_jobs WHERE state = 'unknown' ORDER BY id"
            ).fetchall()
            assert [
                {"jobId": str(jid), "state": state} for jid, state in unresolved
            ] == manifest.get("unresolvedJobs", [])
            count = conn.execute("SELECT count(*) FROM projects").fetchone()[0]
        env = {
            **os.environ,
            "SHORTFILM_DATABASE_URL": url.set(database=name).render_as_string(hide_password=False),
            "SHORTFILM_STORAGE_ROOT": str(destination),
        }
        code = "from fastapi.testclient import TestClient; from shortfilm.main import app; c=TestClient(app); assert c.get('/health/ready').status_code==200; assert c.get('/api/v1/projects').status_code==200; from shortfilm.jobs.service import recover_jobs; recover_jobs(); from shortfilm.db import Session; from shortfilm.models import Job, Outbox; from sqlalchemy import select; db=Session(); unknown=db.scalars(select(Job).where(Job.state=='unknown')).all(); assert all(db.get(Outbox,j.id) is None or db.get(Outbox,j.id).sent_at is not None for j in unknown); db.close()"
        subprocess.run([sys.executable, "-c", code], env=env, check=True)
        print(
            f"Restore check passed: {count} projects, {len(rows)} files; isolated database and relocated media."
        )
    finally:
        with connect(admin_url, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        shutil.rmtree(destination, ignore_errors=True)


if __name__ == "__main__":
    {"backup": backup, "restore-check": restore_check}[sys.argv[1]]()
