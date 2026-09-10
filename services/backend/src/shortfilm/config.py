from pathlib import Path
from uuid import UUID

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHORTFILM_", extra="ignore")
    public_origin: str = ""
    database_url: str = "postgresql+psycopg://shortfilm@127.0.0.1:55432/shortfilm"
    redis_url: str = "redis://127.0.0.1:56379/0"
    storage_root: Path = Path(".local/media")
    local_owner_id: UUID = UUID("00000000-0000-4000-8000-000000000001")
    max_upload_bytes: int = 20 * 1024 * 1024
    media_video_concurrency: int = Field(default=2, ge=1, le=8)
    lease_seconds: int = 30
    redispatch_seconds: int = 30
    text_endpoint: str = "https://api.deepseek.com"
    text_model: str = "deepseek-v4-pro"
    text_credential_ref: str = "DEEPSEEK_API_KEY"
    text_timeout_seconds: int = 120
    text_json_mode: str = "json_object"
    text_max_tokens: int = 8192


settings = Settings()
