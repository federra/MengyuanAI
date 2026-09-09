"""Real Redis worker recovery against a local fake Ark task endpoint."""

import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from PIL import Image
from redis import Redis
from sqlalchemy import select, text
from test_processes import wait_for


def test_video_worker_recovers_known_external_id_without_resubmit(tmp_path, monkeypatch):
    from shortfilm.assets.models import Entity, EntityVersion
    from shortfilm.config import settings
    from shortfilm.creation.service import enqueue
    from shortfilm.db import Session
    from shortfilm.jobs.service import now, recover_jobs
    from shortfilm.jobs.worker import celery
    from shortfilm.main import app
    from shortfilm.media.execution import release_waiting
    from shortfilm.media.models import MediaRun
    from shortfilm.media.sources import checked_file
    from shortfilm.models import Job, JobAttempt, Project

    calls = {"submit": 0, "poll": 0}
    lock = threading.Lock()
    poll_started = threading.Event()
    release_poll = threading.Event()

    class FakeArk(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _json(self, body):
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            assert self.path == "/api/v3/contents/generations/tasks"
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with lock:
                calls["submit"] += 1
            self._json({"id": "durable-video-task-1"})

        def do_GET(self):
            assert self.path == "/api/v3/contents/generations/tasks/durable-video-task-1"
            with lock:
                calls["poll"] += 1
                number = calls["poll"]
            if number == 1:
                poll_started.set()
                release_poll.wait(timeout=15)
                self._json({"status": "queued", "usage": {}})
            else:
                self._json({"status": "running", "usage": {}})

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeArk)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}/api/v3"
    monkeypatch.setenv("M2_PROCESS_KEY", "test-only")

    client = TestClient(app)
    project = client.post("/api/v1/projects", json={"name": "媒体进程恢复验收"}).json()
    image = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(image, "PNG")
    image_bytes = image.getvalue()

    with Session.begin() as db:
        from shortfilm.media.storage import LocalStorage
        from shortfilm.models import MediaFile

        project_row = db.get(Project, UUID(project["id"]))
        entity_row = Entity(project_id=project_row.id, kind="scene")
        db.add(entity_row)
        db.flush()
        version = EntityVersion(
            entity_id=entity_row.id,
            revision=1,
            name="邮局",
            description="雨夜邮局",
            voice="",
            three_view=False,
        )
        db.add(version)
        file_id = uuid4()
        object_key = f"projects/{project_row.id}/{file_id}"
        LocalStorage(settings.storage_root).put(object_key, image_bytes)
        db.add(
            MediaFile(
                id=file_id,
                project_id=project_row.id,
                object_key=object_key,
                filename="reference.png",
                mime="image/png",
                size=len(image_bytes),
                sha256=hashlib.sha256(image_bytes).hexdigest(),
            )
        )
        db.flush()
        file = checked_file(db, project_row, file_id)
        snapshot = {
            "kind": "media.video",
            "model": {
                "provider": "volcengine",
                "model": "doubao-seedance-2-0-260128",
                "endpoint": endpoint,
                "credential_ref": "M2_PROCESS_KEY",
                "credential_revision": 0,
                "capability": "video",
                "timeout_seconds": 30,
            },
            "specification": dict(project_row.generation_settings),
            "prompt": "雨夜邮局，固定镜头",
            "target_id": str(entity_row.id),
            "entity_version_id": str(version.id),
            "input": {"duration": 5},
            "files": [file],
        }
        job = enqueue(
            db,
            project_row,
            str(uuid4()),
            {"action": "process-recovery"},
            "media.video",
            snapshot,
        )
        db.add(MediaRun(job_id=job.id))
        jid = str(job.id)

    queue = "media-process-" + uuid4().hex
    worker_args = [
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
    worker_env = {**os.environ, "SHORTFILM_LEASE_SECONDS": "2"}
    process = None
    redis = Redis.from_url(settings.redis_url)
    try:
        with (tmp_path / "worker.log").open("w") as log:
            process = subprocess.Popen(
                worker_args, env=worker_env, stdout=log, stderr=log, start_new_session=True
            )
            celery.send_task("shortfilm.execute", args=[jid], queue=queue)

            def submitted():
                with Session() as db:
                    run = db.get(MediaRun, UUID(jid))
                    job_row = db.get(Job, UUID(jid))
                    return run.external_id == "durable-video-task-1" and job_row.state == "waiting_provider"

            wait_for(submitted)
            with Session.begin() as db:
                db.get(MediaRun, UUID(jid)).next_poll_at = now() - timedelta(seconds=1)
            release_waiting()
            celery.send_task("shortfilm.execute", args=[jid], queue=queue)
            wait_for(poll_started.is_set)

            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            process = None
            release_poll.set()
            with Session.begin() as db:
                db.execute(
                    text(
                        "UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=:id"
                    ),
                    {"id": jid},
                )
            assert recover_jobs() == 1
            with Session() as db:
                run = db.get(MediaRun, UUID(jid))
                job_row = db.get(Job, UUID(jid))
                assert job_row.state == "queued"
                assert run.external_id == "durable-video-task-1"

            process = subprocess.Popen(
                worker_args, env=worker_env, stdout=log, stderr=log, start_new_session=True
            )
            celery.send_task("shortfilm.execute", args=[jid], queue=queue)

            def resumed_pending_query():
                with Session() as db:
                    return (
                        db.get(Job, UUID(jid)).state == "waiting_provider"
                        and calls["poll"] >= 2
                    )

            wait_for(resumed_pending_query)
            with Session() as db:
                run = db.get(MediaRun, UUID(jid))
                attempts = list(
                    db.scalars(select(JobAttempt).where(JobAttempt.job_id == UUID(jid)))
                )
                assert run.external_id == "durable-video-task-1"
                assert len(attempts) == 3
            assert calls == {"submit": 1, "poll": 2}
    finally:
        release_poll.set()
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=8)
        with Session.begin() as db:
            job_row = db.get(Job, UUID(jid))
            run = db.get(MediaRun, UUID(jid))
            if job_row and run:
                run.cancelled = True
                job_row.state = "cancelled"
                job_row.lease_token = None
                job_row.lease_until = None
        redis.delete(queue)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
