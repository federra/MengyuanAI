import logging
import time
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text

from shortfilm.db import Session
from shortfilm.jobs.router import router as jobs
from shortfilm.media.router import router as files
from shortfilm.projects.router import router as projects
from shortfilm.settings.router import router as settings

app = FastAPI(
    title="AI短片工坊",
    version="0.1.0",
    description="M0 本地单用户工程底座；AI 与成片能力在后续里程碑接入。",
)
logger = logging.getLogger("shortfilm.api")
for router in (projects, files, jobs, settings):
    app.include_router(router, prefix="/api/v1")


@app.middleware("http")
async def trace(request, call_next):
    trace_id, start = str(uuid4()), time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        logger.error("request_failed traceId=%s", trace_id)
        return JSONResponse(
            {"detail": "服务暂不可用", "traceId": trace_id},
            status_code=503,
            headers={"X-Trace-ID": trace_id},
        )
    response.headers["X-Trace-ID"] = trace_id
    logger.info(
        "request traceId=%s status=%s ms=%d",
        trace_id,
        response.status_code,
        (time.monotonic() - start) * 1000,
    )
    return response


@app.get("/health/live")
def live():
    return {"status": "ok"}


@app.get("/health/ready")
def ready():
    try:
        with Session() as db:
            db.execute(text("SELECT 1 FROM alembic_version"))
        return {"status": "ok", "database": "ready"}
    except Exception:
        return JSONResponse({"status": "unavailable", "database": "unavailable"}, status_code=503)
