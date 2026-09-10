import logging
import time
from uuid import uuid4

from fastapi import FastAPI
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from shortfilm.assets.references import router as references
from shortfilm.assets.router import router as assets
from shortfilm.config import settings as runtime_settings
from shortfilm.configuration.asset_credentials import router as asset_credentials
from shortfilm.creation.board_import import router as board_import
from shortfilm.creation.retry import router as retries
from shortfilm.creation.router import router as creation
from shortfilm.creation.stages import router as stages
from shortfilm.db import Session
from shortfilm.finishing.router import router as finishing
from shortfilm.jobs.router import router as jobs
from shortfilm.media.generation_router import router as media_generation
from shortfilm.media.router import router as files
from shortfilm.projects.router import router as projects
from shortfilm.settings.router import router as settings

app = FastAPI(
    title="AI短片工坊",
    version="0.1.0",
    description="本地单用户短片工坊：M1故事版本与DeepSeek适配器；真实文本验收及后续成片能力单独验证。",
)
logger = logging.getLogger("shortfilm.api")
for router in (board_import, finishing, asset_credentials, projects, files, jobs, settings, creation, retries, stages, assets, references, media_generation):
    app.include_router(router, prefix="/api/v1")


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    if request.url.path.startswith(("/api/v1/settings/model-credentials/", "/api/v1/settings/asset-credentials")):
        return JSONResponse({"detail": "凭据请求格式无效"}, status_code=422)
    return await request_validation_exception_handler(request, exc)


@app.middleware("http")
async def trace(request, call_next):
    trace_id, start = str(uuid4()), time.monotonic()
    sensitive = request.url.path.startswith(("/api/v1/settings/model-credentials/", "/api/v1/settings/asset-credentials"))
    # Model route writes also control where a later authenticated request is sent.
    model_write = "/settings/bindings/" in request.url.path and "/model:" in request.url.path
    if (sensitive or model_write or runtime_settings.public_origin) and request.method not in ("GET", "HEAD", "OPTIONS"):
        allowed = {
            f"http://{host}:{port}"
            for host in ("localhost", "127.0.0.1", "[::1]")
            for port in (5180, 5181, 8010)
        }
        if runtime_settings.public_origin:
            allowed = {runtime_settings.public_origin}
        origin = request.headers.get("origin")
        if (origin is not None and origin not in allowed) or request.headers.get(
            "sec-fetch-site"
        ) == "cross-site":
            return JSONResponse({"detail": "仅允许受信应用来源执行此操作"}, status_code=403)
    try:
        response = await call_next(request)
    except Exception:
        logger.error("request_failed traceId=%s", trace_id)
        return JSONResponse(
            {"detail": "服务暂不可用", "traceId": trace_id},
            status_code=503,
            headers={"X-Trace-ID": trace_id},
        )
    if sensitive:
        response.headers["Cache-Control"] = "no-store"
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
