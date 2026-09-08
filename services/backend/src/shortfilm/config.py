from pathlib import Path
from uuid import UUID

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHORTFILM_", extra="ignore")
    database_url: str = "postgresql+psycopg://shortfilm@127.0.0.1:55432/shortfilm"
    redis_url: str = "redis://127.0.0.1:56379/0"
    storage_root: Path = Path(".local/media")
    local_owner_id: UUID = UUID("00000000-0000-4000-8000-000000000001")
    max_upload_bytes: int = 20 * 1024 * 1024
    lease_seconds: int = 30
    redispatch_seconds: int = 30


settings = Settings()
