import json
import threading
import time
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import select

from shortfilm.config import settings
from shortfilm.creation import provider
from shortfilm.creation.schemas import BatchOutput
from shortfilm.creation.stage_execution import save_stage_output, schema_for, validate_output
from shortfilm.creation.stage_service import enqueue_review
from shortfilm.db import Session
from shortfilm.jobs.service import finish_job, heartbeat, now
from shortfilm.models import ContentItem, ContentVersion, JobAttempt, Project


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
        schema = schema_for(snapshot["kind"], snapshot)
        json_schema = schema.model_json_schema()
        if snapshot["kind"] == "story.generate":
            count = snapshot.get("story_count", 3)
            json_schema["properties"]["stories"].update(minItems=count, maxItems=count)
        context = {
            k: snapshot[k]
            for k in (
                "input",
                "story_count",
                "applicationConstraints",
                "sourceIdea",
                "market",
                "instruction",
                "style",
                "history",
                "text",
                "source",
                "source_version_id",
                "base_version_id",
                "base_revision",
                "report",
                "specification",
            )
            if k in snapshot
        }
        messages = [
            {
                "role": "system",
                "content": snapshot["prompt"]["template"]
                + "\nJSON Schema: "
                + json.dumps(json_schema, ensure_ascii=False),
            },
            {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
        ]
        for correction in range(3):
            if lost.is_set() or not heartbeat(job_id, token):
                return
            started = time.monotonic()
            raw, metadata = provider.request_json(snapshot["model"], messages, json_schema)
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
                with Session() as db:
                    output = validate_output(db, snapshot, raw)
                finish_job(job_id, token, output)
                return
            except (ValidationError, ValueError) as e:
                errors = (
                    [
                        {"path": list(err["loc"]), "type": err["type"], "message": err["msg"]}
                        for err in e.errors(include_input=False, include_context=False)
                    ]
                    if isinstance(e, ValidationError)
                    else [{"semantic": str(e)}]
                )
                # Keep diagnostic reasons, never the rejected model body in attempt metadata.
                with Session.begin() as db:
                    attempt = db.scalar(select(JobAttempt).where(JobAttempt.token == token))
                    calls = list(attempt.provider_calls or [])
                    calls[-1] = {**calls[-1], "validation_errors": errors}
                    attempt.provider_calls = calls
                # Preserve invalid data as quoted assistant content, never instructions.
                messages += [
                    {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)},
                    {
                        "role": "user",
                        "content": "修正以下校验错误，返回完整 JSON："
                        + json.dumps(errors, ensure_ascii=False),
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
    project = db.scalar(select(Project).where(Project.id == job.project_id).with_for_update())
    if job.kind == "story.generate":
        validated = BatchOutput.model_validate(
            output, context={"story_count": job.snapshot.get("story_count", 3)}
        )
        created_at = now()
        # Existing pagination orders equal-time batch items by UUID; assign that order
        # once to retain the model sequence without changing stored history or schema.
        identifiers = sorted(uuid4() for _ in validated.stories)
        for identifier, story in zip(identifiers, validated.stories, strict=True):
            item = ContentItem(
                id=identifier,
                project_id=job.project_id,
                kind="story",
                batch_id=job.id,
                revision=1,
                created_at=created_at,
            )
            db.add(item)
            db.flush()
            version = ContentVersion(
                item_id=item.id,
                revision=1,
                body=story.model_dump(),
                source_version_id=UUID(job.snapshot["idea_version_id"]),
                job_id=job.id,
                origin="generation",
            )
            db.add(version)
            db.flush()
            enqueue_review(
                db,
                project,
                item,
                version,
                job.snapshot.get(
                    "review_configuration", {"configuration_error": "历史任务未冻结质检配置"}
                ),
            )
    else:
        save_stage_output(db, project, job, output)
