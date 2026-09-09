# ruff: noqa: F811
"""Actual Redis + killed/restarted media Worker; FFmpeg encodes real test files."""

import os
import signal
import subprocess
import sys
from datetime import timedelta
from uuid import UUID, uuid4

from redis import Redis
from sqlalchemy import func, select
from test_content_chain import chain_model  # noqa: F401
from test_finishing import ready_media
from test_media_chain import media_provider  # noqa: F401
from test_processes import wait_for
from test_story import client, model, post  # noqa: F401


def test_export_worker_kill_restart_duplicate_delivery(
    tmp_path, client, chain_model, media_provider
):
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.jobs.service import now, recover_jobs
    from shortfilm.jobs.worker import celery
    from shortfilm.models import Job, JobAttempt, JobResult

    base, _ = ready_media(client, chain_model)
    draft = client.get(base + "/finishing").json()["draft"]
    client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    jid = post(client, base + "/exports", {"revision": 1}).json()["id"]
    queue = "m3-test-" + uuid4().hex
    marker, gate = tmp_path / "encoding-started", tmp_path / "gate"
    os.mkfifo(gate)
    wrapper = tmp_path / "ffmpeg"
    import shutil

    real = shutil.which("ffmpeg")
    wrapper.write_text(
        f'#!{sys.executable}\nimport os,sys\nfrom pathlib import Path\nif sys.argv[-1].endswith("clip-0.mp4"):\n Path({str(marker)!r}).touch()\n os.open({str(gate)!r}, os.O_RDONLY)\nos.execv({real!r}, [{real!r}] + sys.argv[1:])\n'
    )
    wrapper.chmod(0o700)
    args = [
        sys.executable,
        "-m",
        "celery",
        "-A",
        "shortfilm.jobs.worker:celery",
        "worker",
        "--pool=solo",
        "-Q",
        queue,
        "-n",
        queue + "@%h",
        "--loglevel=WARNING",
        "--without-gossip",
        "--without-mingle",
    ]
    process = None
    try:
        with (tmp_path / "worker.log").open("w") as log:
            process = subprocess.Popen(
                args,
                stdout=log,
                stderr=log,
                start_new_session=True,
                env={**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]},
            )
            celery.send_task("shortfilm.execute", args=[jid], queue=queue)
            wait_for(marker.exists)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            with Session.begin() as db:
                db.get(Job, UUID(jid)).lease_until = now() - timedelta(seconds=1)
            recover_jobs()
            with Session() as db:
                assert db.get(Job, UUID(jid)).state == "queued"
            process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
            for _ in range(4):
                celery.send_task("shortfilm.execute", args=[jid], queue=queue)

            def succeeded():
                with Session() as db:
                    job = db.get(Job, UUID(jid))
                    assert job.state != "failed", job.error
                    return job.state == "succeeded"

            wait_for(succeeded, timeout=45)
            with Session() as db:
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(JobResult)
                        .where(JobResult.job_id == UUID(jid))
                    )
                    == 1
                )
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(JobAttempt)
                        .where(JobAttempt.job_id == UUID(jid))
                    )
                    == 2
                )
            assert client.get(base + f"/exports/{jid}/download").status_code == 200
            assert client.get(base).json()["status"] == "completed"
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        Redis.from_url(settings.redis_url).delete(queue)
