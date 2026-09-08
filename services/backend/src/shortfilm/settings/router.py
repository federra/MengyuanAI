from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.models import ProjectType, PromptVersion
from shortfilm.schemas import SettingsOut

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=SettingsOut)
def get_settings(db: Session = Depends(session)):
    return {
        "project_types": db.scalars(select(ProjectType).order_by(ProjectType.name)).all(),
        "prompt_count": db.scalar(select(func.count()).select_from(PromptVersion)),
        "max_upload_bytes": settings.max_upload_bytes,
    }
