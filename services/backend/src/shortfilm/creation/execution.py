import json
import threading
import time
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import select

from shortfilm.config import settings
from shortfilm.creation import provider
from shortfilm.creation.schemas import BatchOutput, RevisionOutput
from shortfilm.db import Session
from shortfilm.jobs.service import finish_job, heartbeat
from shortfilm.models import ContentItem, ContentVersion, JobAttempt, Message, Project, Proposal


def execute_text(job_id, token, snapshot):
    stopped = threading.Event()
    lost = threading.Event()

    def pulse():
        while not stopped.wait(max(0.2, settings.lease_seconds / 3)):
            try:
                if not heartbeat(job_id, token):
                    lost.set()
                    return
            except Exception:
                lost.set()
                return

    thread = threading.Thread(target=pulse, daemon=True)
    thread.start()
    try:
        schema = BatchOutput if snapshot["kind"] == "story.generate" else RevisionOutput
        context = {
            k: snapshot[k]
            for k in ("input", "market", "instruction", "style", "history", "text")
            if k in snapshot
        }
        messages = [
            {
                "role": "system",
                "content": snapshot["prompt"]["template"]
                + "\nJSON Schema: "
                + json.dumps(schema.model_json_schema(), ensure_ascii=False),
            },
            {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
        ]
        for correction in range(3):
            if lost.is_set() or not heartbeat(job_id, token):
                return
            started = time.monotonic()
            raw, metadata = provider.request_json(
                snapshot["model"], messages, schema.model_json_schema()
            )
            with Session.begin() as db:
                attempt = db.scalar(select(JobAttempt).where(JobAttempt.token == token))
                attempt.provider_calls = [
                    *(attempt.provider_calls or []),
                    {
                        **metadata,
                        "correction": correction,
                        "elapsed_ms": round((time.monotonic() - started) * 1000),
                    },
                ]
            try:
                output = schema.model_validate(raw).model_dump()
                finish_job(job_id, token, output)
                return
            except ValidationError as e:
                errors = [{"path": list(err["loc"]), "type": err["type"]} for err in e.errors()]
                # Preserve invalid data as quoted assistant content, never instructions.
                messages += [
                    {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)},
                    {
                        "role": "user",
                        "content": "修正以下校验错误，返回完整 JSON：" + json.dumps(errors),
                    },
                ]
        finish_job(job_id, token, error="invalid_model_output")
    except provider.ProviderFailure as e:
        finish_job(job_id, token, error=e.code, unknown=e.unknown)
    except Exception:
        # A crash may follow an accepted provider request. Never replay blindly.
        finish_job(job_id, token, error="text_execution_unknown", unknown=True)
    finally:
        stopped.set()
        thread.join(timeout=1)


def save_output(db, job, output):
    # Called inside finish_job transaction: content and succeeded commit together.
    db.scalar(select(Project).where(Project.id == job.project_id).with_for_update())
    if job.kind == "story.generate":
        validated = BatchOutput.model_validate(output)
        for story in validated.stories:
            item = ContentItem(
                id=uuid4(), project_id=job.project_id, kind="story", batch_id=job.id, revision=1
            )
            db.add(item)
            db.flush()
            db.add(
                ContentVersion(
                    item_id=item.id,
                    revision=1,
                    body=story.model_dump(),
                    source_version_id=UUID(job.snapshot["idea_version_id"]),
                    job_id=job.id,
                    origin="generation",
                )
            )
    else:
        validated = RevisionOutput.model_validate(output)
        item_id = UUID(job.snapshot["item_id"])
        db.add(
            Proposal(
                item_id=item_id,
                job_id=job.id,
                base_version_id=UUID(job.snapshot["base_version_id"]),
                output=validated.model_dump(),
            )
        )
        db.add(
            Message(item_id=item_id, job_id=job.id, role="assistant", text=validated.changeSummary)
        )
