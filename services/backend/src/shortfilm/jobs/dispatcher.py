import logging
import time

from sqlalchemy import select, update

from shortfilm.db import Session
from shortfilm.jobs.service import now, recover_jobs
from shortfilm.jobs.worker import celery
from shortfilm.models import Job, Outbox

logger = logging.getLogger(__name__)


def dispatch_once():
    recover_jobs()
    # Publish outside a database transaction. A crash between send and mark may
    # duplicate delivery, which the worker's row lock and result PK absorb.
    with Session() as db:
        ids = list(
            db.execute(
                select(Outbox.job_id, Job.kind)
                .join(Job, Job.id == Outbox.job_id)
                .where(Outbox.sent_at.is_(None), Job.state == "queued")
                .limit(100)
            )
        )
    for jid, kind in ids:
        celery.send_task(
            "shortfilm.execute",
            args=[str(jid)],
            queue="ai" if kind.startswith("story.") else "media",
            retry=False,
        )
        with Session.begin() as db:
            db.execute(update(Outbox).where(Outbox.job_id == jid).values(sent_at=now()))
    return len(ids)


def main():
    logging.basicConfig(level=logging.INFO)
    while True:
        try:
            dispatch_once()
        except Exception:
            # Do not log broker URLs, credentials, payloads, or raw exceptions.
            logger.error("dispatcher unavailable; pending jobs retained in PostgreSQL")
        time.sleep(2)


if __name__ == "__main__":
    main()
