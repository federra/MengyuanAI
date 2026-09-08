import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_m0 import client as client_fixture
from test_m0 import project


@pytest.fixture
def client():
    yield from client_fixture.__wrapped__()


def test_unknown_backup_preserved_and_not_replayed(client, tmp_path, monkeypatch):
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.jobs.service import recover_jobs
    from shortfilm.models import Job, Outbox

    spec = importlib.util.spec_from_file_location(
        "backup_script", Path("scripts/backup.py").resolve()
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    p = project(client)
    with Session.begin() as db:
        # Other tests can leave queued jobs; isolate this backup's owned fixture states.
        existing = db.scalars(
            select(Job).where(Job.state.in_(["queued", "running", "waiting_provider"]))
        ).all()
        for job in existing:
            job.state = "cancelled"
        row = Job(
            project_id=p["id"],
            owner_id=settings.local_owner_id,
            kind="story.generate",
            state="unknown",
            idempotency_key=str(uuid4()),
            source_fingerprint="a" * 64,
            snapshot={"unresolved": True},
        )
        db.add(row)
        db.flush()
        jid = row.id
    destination = module.backup()
    manifest = json.loads((destination / "manifest.json").read_text())
    assert {"jobId": str(jid), "state": "unknown"} in manifest["unresolvedJobs"]
    module.restore_check()
    recover_jobs()
    with Session() as db:
        assert db.get(Job, jid).state == "unknown"
        assert db.get(Outbox, jid) is None
    with Session.begin() as db:
        db.get(Job, jid).state = "running"
    with pytest.raises(SystemExit, match="在途任务"):
        module.backup()
    with Session.begin() as db:
        db.get(Job, jid).state = "unknown"
