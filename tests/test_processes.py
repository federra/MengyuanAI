"""Real Redis + independently killed worker; no eager mode or fake database."""

import io
import os
import signal
import subprocess
import sys
import time
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
from redis import Redis
from sqlalchemy import func, select, text


def wait_for(check, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if value := check():
            return value
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for real process state")


def test_real_queue_worker_kill_and_restart(tmp_path):
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.jobs.worker import celery
    from shortfilm.main import app
    from shortfilm.models import Job, JobAttempt, JobResult

    queue = "m0-test-" + uuid4().hex
    redis = Redis.from_url(settings.redis_url)
    assert redis.ping()
    # A FIFO blocks the real worker in file IO after its committed claim.
    client = TestClient(app)
    p = client.post("/api/v1/projects", json={"name": "Worker 故障恢复验证"}).json()
    image = io.BytesIO()
    Image.new("RGB", (8, 8)).save(image, "PNG")
    raw = image.getvalue()
    f = client.post(
        f"/api/v1/projects/{p['id']}/files",
        files={"file": ("test.png", raw, "image/png")},
    ).json()
    j = client.post(
        f"/api/v1/projects/{p['id']}/jobs",
        json={"kind": "file.verify", "file_id": f["id"]},
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    from shortfilm.models import MediaFile

    with Session() as db:
        key = db.get(MediaFile, f["id"]).object_key
    path = settings.storage_root / key
    path.unlink()
    os.mkfifo(path)
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
            process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
            celery.send_task("shortfilm.execute", args=[j["id"]], queue=queue)

            def running():
                with Session() as db:
                    return db.get(Job, j["id"]).state == "running"

            wait_for(running)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            path.unlink()
            path.write_bytes(raw)
            # Expire the dead process lease without spending 30 seconds waiting.
            with Session.begin() as db:
                db.execute(
                    text(
                        "UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=:id"
                    ),
                    {"id": j["id"]},
                )
            # Run recovery in a separate process, as dispatcher does after restart.
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from shortfilm.jobs.service import recover_jobs; recover_jobs()",
                ],
                check=True,
            )
            with Session() as db:
                assert db.get(Job, j["id"]).state == "queued"
            process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
            for _ in range(4):
                celery.send_task("shortfilm.execute", args=[j["id"]], queue=queue)

            def succeeded():
                with Session() as db:
                    return db.get(Job, j["id"]).state == "succeeded"

            wait_for(succeeded)
            with Session() as db:
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(JobResult)
                        .where(JobResult.job_id == j["id"])
                    )
                    == 1
                )
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(JobAttempt)
                        .where(JobAttempt.job_id == j["id"])
                    )
                    == 2
                )
            # Fresh API process reads the same persistent project.
            code = (
                "from fastapi.testclient import TestClient; from shortfilm.main import app; r=TestClient(app).get('/api/v1/projects/"
                + p["id"]
                + "'); assert r.status_code==200; assert r.json()['name']=='Worker 故障恢复验证'"
            )
            subprocess.run([sys.executable, "-c", code], check=True)
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        if path.exists() and not path.is_file():
            path.unlink()
        redis.delete(queue)
