"""One persisted job per media command; receipt reconciliation never resubmits a known task."""

import base64
import hashlib
import io
import threading
import warnings
from datetime import timedelta
from uuid import NAMESPACE_URL, UUID, uuid5

from PIL import Image
from sqlalchemy import and_, or_, select, text

from shortfilm.assets.models import ReferenceImage
from shortfilm.config import settings
from shortfilm.creation.provider import ProviderFailure
from shortfilm.db import Session
from shortfilm.jobs.service import heartbeat, now
from shortfilm.media.models import JobDependency, MediaOutcome, MediaRun, MediaSequence
from shortfilm.media.processing import extract_last_frame, inspect_media
from shortfilm.media.sources import (
    board,
    outcome_stale,
    previous_context,
    previous_valid,
    source_stale,
)
from shortfilm.media.storage import LocalStorage
from shortfilm.models import Job, JobAttempt, JobEvent, JobResult, MediaFile, Outbox, Project


def media_kind(kind):
    return kind.startswith("image.") or kind in ("media.audio", "media.video")


def live(db, jid, token):
    job = db.scalar(select(Job).where(Job.id == UUID(str(jid))).with_for_update())
    if not job or job.state != "running" or job.lease_token != token or job.lease_until <= now():
        return None
    return job


def transition(db, job, state, error=None):
    attempt = (
        db.scalar(select(JobAttempt).where(JobAttempt.token == job.lease_token))
        if job.lease_token
        else None
    )
    if attempt:
        attempt.state, attempt.finished_at = state, now()
    job.state, job.error, job.updated_at = state, error, now()
    job.lease_token, job.lease_until = None, None
    db.add(JobEvent(job_id=job.id, state=state))


def requeue(db, job):
    transition(db, job, "queued")
    db.get(Outbox, job.id).sent_at = None


def release_waiting():
    # Lock projects before jobs, matching API commands and result persistence.
    with Session() as db:
        pids = list(
            db.scalars(
                select(Job.project_id)
                .join(MediaRun, Job.id == MediaRun.job_id)
                .where(Job.state.in_(("waiting_dependency", "waiting_provider")))
                .distinct()
            )
        )
    for pid in pids:
        with Session.begin() as db:
            project = db.scalar(select(Project).where(Project.id == pid).with_for_update())
            jobs = list(
                db.scalars(
                    select(Job)
                    .join(MediaRun, Job.id == MediaRun.job_id)
                    .where(
                        Job.project_id == pid,
                        Job.state.in_(("waiting_dependency", "waiting_provider")),
                    )
                    .with_for_update(of=Job)
                )
            )
            for job in jobs:
                run = db.get(MediaRun, job.id)
                if job.state == "waiting_provider":
                    if not run.next_poll_at or run.next_poll_at <= now():
                        requeue(db, job)
                    continue
                if run.cancelled:
                    transition(db, job, "cancelled")
                    continue
                if run.sequence_id and db.get(MediaSequence, run.sequence_id).paused:
                    continue
                dependency = db.get(JobDependency, job.id)
                if dependency:
                    parent = db.get(Job, dependency.parent_id)
                    output = db.scalar(select(MediaOutcome).where(MediaOutcome.job_id == parent.id))
                    if (
                        parent.state != "succeeded"
                        or not output
                        or outcome_stale(db, project, output)
                    ):
                        continue
                    previous = previous_context(output)
                    if source_stale(db, project, job.snapshot, previous):
                        job.error = "media_source_stale"
                        continue
                    run.previous = previous
                elif source_stale(db, project, job.snapshot):
                    job.error = "media_source_stale"
                    continue
                requeue(db, job)


def recover_media(db, job):
    run = db.get(MediaRun, job.id)
    if not run:
        return False
    # A request intent without a durable receipt is uncertain; never blindly replay it.
    state = "queued" if not run.submitted or run.external_id or run.receipt else "unknown"
    transition(db, job, state, "provider_acceptance_unknown" if state == "unknown" else None)
    if state == "queued":
        db.get(Outbox, job.id).sent_at = None
    return True


def data_uri(file):
    storage = LocalStorage(settings.storage_root)
    raw = storage.read(file["object_key"])
    if hashlib.sha256(raw).hexdigest() != file["sha256"]:
        raise ValueError("media_source_stale")
    return "data:" + file["mime"] + ";base64," + base64.b64encode(raw).decode()


def prepare(jid, token):
    with Session.begin() as db:
        initial = db.get(Job, UUID(str(jid)))
        project = db.scalar(
            select(Project).where(Project.id == initial.project_id).with_for_update()
        )
        job = live(db, jid, token)
        if not job:
            return None
        run = db.get(MediaRun, job.id)
        if not run.submitted:
            if run.cancelled:
                transition(db, job, "cancelled")
                return None
            if run.sequence_id and db.get(MediaSequence, run.sequence_id).paused:
                transition(db, job, "waiting_dependency")
                return None
            if source_stale(db, project, job.snapshot, run.previous):
                transition(db, job, "failed", "media_source_stale")
                return None
            if not job.snapshot.get("entity_version_id"):
                board(db, project, confirmed=True)
            if run.previous and not previous_valid(
                db, project, board(db, project), job.snapshot["shot_id"], run.previous
            ):
                transition(db, job, "failed", "previous_frame_stale")
                return None
        previous_file = None
        if run.previous:
            f = db.get(MediaFile, UUID(run.previous["refId"]))
            previous_file = {
                "id": str(f.id),
                "object_key": f.object_key,
                "sha256": f.sha256,
                "mime": f.mime,
            }
        return job.snapshot, run.external_id, run.receipt, previous_file, run.submitted


def mark_submitted(jid, token):
    with Session.begin() as db:
        initial = db.get(Job, UUID(str(jid)))
        project = db.scalar(
            select(Project).where(Project.id == initial.project_id).with_for_update()
        )
        job = live(db, jid, token)
        if not job:
            return False
        run = db.get(MediaRun, job.id)
        if run.cancelled:
            transition(db, job, "cancelled")
            return False
        if source_stale(db, project, job.snapshot, run.previous):
            transition(db, job, "failed", "media_source_stale")
            return False
        dependency = db.get(JobDependency, job.id)
        if dependency:
            parent = db.get(Job, dependency.parent_id)
            if parent.state != "succeeded" or not run.previous:
                transition(db, job, "waiting_dependency")
                return False
        if run.sequence_id and db.get(MediaSequence, run.sequence_id).paused:
            transition(db, job, "waiting_dependency")
            return False
        if job.kind == "media.video" and not run.submitted:
            model = job.snapshot["model"]
            capacity_key = model["provider"] + "/" + model["endpoint"]
            db.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": "media-capacity:" + capacity_key},
            )
            candidates = db.execute(
                select(Job.project_id, MediaRun.job_id, MediaRun.external_id)
                .join(MediaRun, Job.id == MediaRun.job_id)
                .where(
                    MediaRun.submitted.is_(True),
                    Job.kind == "media.video",
                    Job.state.in_(
                        ("running", "waiting_provider", "queued", "unknown", "waiting_dependency")
                    ),
                    Job.snapshot["model"]["provider"].astext == model["provider"],
                    Job.snapshot["model"]["endpoint"].astext == model["endpoint"],
                )
            ).all()
            requests = {(pid, external) for pid, _, external in candidates if external}
            reconciled = set()
            if requests:
                reconciled = set(
                    db.execute(
                        select(Job.project_id, MediaRun.external_id)
                        .join(MediaRun, Job.id == MediaRun.job_id)
                        .where(
                            Job.project_id.in_({pid for pid, _ in requests}),
                            MediaRun.external_id.in_({external for _, external in requests}),
                            Job.snapshot["model"]["provider"].astext == model["provider"],
                            Job.snapshot["model"]["endpoint"].astext == model["endpoint"],
                            or_(
                                Job.state == "succeeded",
                                and_(Job.state == "cancelled", MediaRun.receipt.is_not(None)),
                                and_(
                                    Job.state == "failed",
                                    Job.error.in_(
                                        (
                                            "provider_generation_failed",
                                            "media_download_failed",
                                            "media_invalid",
                                            "last_frame_extraction_failed",
                                        )
                                    ),
                                ),
                            ),
                        )
                    ).all()
                )
            # Same-ID reconciliation is one supplier request, even while old unknown history remains.
            active = len(requests - reconciled) + sum(
                1 for _, _, external in candidates if not external
            )
            if active >= settings.media_video_concurrency:
                transition(db, job, "waiting_dependency", "supplier_capacity_wait")
                return False
        run.submitted = True
        return True


def persist_receipt(jid, token, external_id=None, receipt=None):
    with Session.begin() as db:
        job = live(db, jid, token)
        if not job:
            return False
        run = db.get(MediaRun, job.id)
        if external_id is not None:
            run.external_id = external_id
        if receipt is not None:
            run.receipt = receipt
        return True


def wait_provider(jid, token, error=None):
    with Session.begin() as db:
        job = live(db, jid, token)
        if job:
            db.get(MediaRun, job.id).next_poll_at = now() + timedelta(seconds=10)
            transition(db, job, "waiting_provider", error)


def fail(jid, token, code, unknown=False):
    with Session.begin() as db:
        job = live(db, jid, token)
        if job:
            transition(db, job, "unknown" if unknown else "failed", code)


def save_file(db, project_id, jid, role, raw, mime):
    fid = uuid5(NAMESPACE_URL, "shortfilm:" + str(jid) + ":" + role)
    key = f"projects/{project_id}/{fid}"
    LocalStorage(settings.storage_root).put(key, raw)
    file = db.get(MediaFile, fid)
    if not file:
        file = MediaFile(
            id=fid,
            project_id=project_id,
            object_key=key,
            filename=role
            + {
                "video/mp4": ".mp4",
                "audio/mpeg": ".mp3",
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/webp": ".webp",
            }.get(mime, ".media"),
            mime=mime,
            size=len(raw),
            sha256=hashlib.sha256(raw).hexdigest(),
        )
        db.add(file)
        db.flush()
    return file


def complete(jid, token, raw, receipt):
    storage = LocalStorage(settings.storage_root)
    snapshot = None
    with Session() as db:
        job = db.get(Job, UUID(str(jid)))
        snapshot = job.snapshot
    kind = snapshot["kind"]
    tail = None
    if kind.startswith("image."):
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ("PNG", "JPEG", "WEBP"):
                    raise ValueError("media_invalid")
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                metadata = {
                    "width": image.width,
                    "height": image.height,
                    "mime": Image.MIME[image.format],
                }
    else:
        staging = storage.path(receipt["staged_key"])
        metadata = inspect_media(staging, "video" if kind == "media.video" else "audio")
        if kind == "media.video":
            # Reject unsupported output rather than silently lowering the project specification.
            spec = snapshot["specification"]
            expected_short = {"720P": 720, "1080P": 1080}[spec["resolution"]]
            if min(metadata["width"], metadata["height"]) != expected_short:
                raise ValueError("media_dimensions_mismatch")
            numerator, denominator = map(int, spec["aspect_ratio"].split(":"))
            if abs(metadata["width"] / metadata["height"] - numerator / denominator) > 0.02:
                raise ValueError("media_dimensions_mismatch")
            if abs(metadata["duration"] - snapshot["input"]["duration"]) > 0.6:
                raise ValueError("media_duration_mismatch")
            tail_path = storage.path(receipt["staged_key"] + ".png")
            extract_last_frame(staging, tail_path)
            tail = tail_path.read_bytes()
    with Session.begin() as db:
        initial = db.get(Job, UUID(str(jid)))
        project = db.scalar(
            select(Project).where(Project.id == initial.project_id).with_for_update()
        )
        job = live(db, jid, token)
        if not job:
            return
        run = db.get(MediaRun, job.id)
        file = save_file(db, project.id, jid, "generated", raw, metadata["mime"])
        tail_file = save_file(db, project.id, jid, "tail", tail, "image/png") if tail else None
        output = MediaOutcome(
            project_id=project.id,
            job_id=job.id,
            kind=kind,
            target_id=snapshot["target_id"],
            file_id=file.id,
            tail_file_id=tail_file.id if tail_file else None,
            metadata_json={
                **metadata,
                "usage": receipt.get("usage", {}),
                "provider_request_id": receipt.get("provider_request_id", run.external_id or ""),
            },
        )
        db.add(output)
        if snapshot.get("entity_version_id"):
            db.add(
                ReferenceImage(
                    project_id=project.id,
                    entity_version_id=UUID(snapshot["entity_version_id"]),
                    file_id=file.id,
                )
            )
        db.flush()
        db.add(
            JobResult(
                job_id=job.id,
                output={
                    "media_result_id": str(output.id),
                    "file_id": str(file.id),
                    "tail_file_id": str(tail_file.id) if tail_file else None,
                },
            )
        )
        if not run.cancelled:
            from shortfilm.media.auto_references import link_generated_image

            link_generated_image(db, project, job, output)
        transition(db, job, "cancelled" if run.cancelled else "succeeded")
        from shortfilm.finishing.service import invalidate_completed

        invalidate_completed(db, project.id)


def execute_media(jid, token):
    from shortfilm.media import providers

    stopped, lost = threading.Event(), threading.Event()

    def pulse():
        while not stopped.wait(max(0.2, settings.lease_seconds / 3)):
            try:
                if not heartbeat(jid, token):
                    lost.set()
                    return
            except Exception:
                lost.set()
                return

    thread = threading.Thread(target=pulse, daemon=True)
    thread.start()
    try:
        prepared = prepare(jid, token)
        if not prepared:
            return
        snapshot, external_id, receipt, previous, submitted = prepared
        model, kind = snapshot["model"], snapshot["kind"]
        storage = LocalStorage(settings.storage_root)
        if receipt and receipt.get("staged_key"):
            complete(jid, token, storage.read(receipt["staged_key"]), receipt)
            return
        if kind == "media.video" and external_id:
            try:
                result = providers.poll_video(model, external_id)
            except ProviderFailure:
                wait_provider(jid, token, "provider_query_unavailable")
                return
            if result["state"] == "pending":
                wait_provider(jid, token)
                return
            if result["state"] == "failed":
                fail(jid, token, "provider_generation_failed")
                return
            receipt = {
                "url": result["url"],
                "usage": result.get("usage", {}),
                "provider_request_id": external_id,
            }
            if not persist_receipt(jid, token, receipt=receipt):
                return
        if receipt and receipt.get("url"):
            try:
                raw = providers.download_media(receipt["url"])
            except (ProviderFailure, OSError, ValueError):
                fail(jid, token, "media_download_failed")
                return
        else:
            if submitted:
                fail(jid, token, "provider_acceptance_unknown", unknown=True)
                return
            images = [data_uri(file) for file in snapshot["files"]]
            prompt = snapshot["prompt"]
            prompt += "\n" + "\n".join(
                f"参考图{index + 1}对应 @[{file.get('ref_id', file['id'])}]，按此映射理解素材。"
                for index, file in enumerate(snapshot["files"])
            )
            if previous and previous["id"] not in [f["id"] for f in snapshot["files"]]:
                images.append(data_uri(previous))
            if previous:
                index = (
                    [f["id"] for f in snapshot["files"]]
                    + (
                        []
                        if previous["id"] in [f["id"] for f in snapshot["files"]]
                        else [previous["id"]]
                    )
                ).index(previous["id"]) + 1
                prompt += f"\n参考图{index}是上一镜真实末帧，延续人物、空间与动作；这是多参考约束，不是严格首帧。"
            if lost.is_set() or not mark_submitted(jid, token):
                return
            if kind == "media.video":
                external_id = providers.submit_video(
                    model,
                    {
                        "prompt": prompt,
                        "images": images,
                        "duration": int(snapshot["input"]["duration"]),
                        "resolution": snapshot["specification"]["resolution"],
                        "aspect_ratio": snapshot["specification"]["aspect_ratio"],
                    },
                )
                if persist_receipt(jid, token, external_id=external_id):
                    wait_provider(jid, token)
                return
            if kind == "media.audio":
                line = snapshot["input"]
                generated = providers.generate_audio(
                    model,
                    {
                        "text": line["text"],
                        "voice": line["voice"],
                        "emotion": snapshot["performance_emotion"],
                        "speed": snapshot["speed"],
                    },
                )
            else:
                # Use explicit dimensions compatible with Seedream minimum image pixels.
                size = {"9:16": "1536x2730", "16:9": "2730x1536", "1:1": "2048x2048"}[
                    snapshot["specification"]["aspect_ratio"]
                ]
                generated = providers.generate_image(
                    model, {"prompt": prompt, "images": images, "size": size}
                )
            raw = generated["data"]
            receipt = {
                "usage": generated.get("usage", {}),
                "provider_request_id": generated.get("provider_request_id", ""),
            }
        if lost.is_set():
            return
        staged_key = "staging/" + str(jid) + "/result"
        storage.put(staged_key, raw)
        receipt = {**receipt, "staged_key": staged_key}
        if persist_receipt(jid, token, receipt=receipt):
            complete(jid, token, raw, receipt)
    except ProviderFailure as exc:
        fail(jid, token, exc.code, unknown=exc.unknown)
    except Exception as exc:
        # No raw provider/URL/secret diagnostics reach API logs or job errors.
        code = (
            str(exc)
            if str(exc)
            in (
                "media_source_stale",
                "media_dimensions_mismatch",
                "media_duration_mismatch",
                "last_frame_extraction_failed",
            )
            else "media_invalid"
        )
        with Session() as db:
            run = db.get(MediaRun, UUID(str(jid)))
            uncertain = bool(run and run.submitted and not run.external_id and not run.receipt)
        fail(jid, token, "provider_acceptance_unknown" if uncertain else code, unknown=uncertain)
    finally:
        stopped.set()
        thread.join(timeout=1)
