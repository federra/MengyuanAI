from celery import Celery

from shortfilm.config import settings
from shortfilm.jobs.service import execute_job

celery = Celery("shortfilm", broker=settings.redis_url)
celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    task_ignore_result=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    broker_connection_timeout=5,
    broker_transport_options={
        "visibility_timeout": 60,
        "socket_timeout": 5,
        "socket_connect_timeout": 5,
    },
    task_default_queue="media",
    task_routes={"shortfilm.execute": {"queue": "media"}},
)


@celery.task(name="shortfilm.execute")
def run(job_id: str):
    execute_job(job_id)
