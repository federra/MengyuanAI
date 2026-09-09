import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import pytest


def pytest_sessionstart(session):
    """Fail before test imports: direct pytest must never use the application database."""
    url = urlsplit(os.environ.get("SHORTFILM_DATABASE_URL", ""))
    database = url.path.lstrip("/")
    if url.query or url.fragment or url.scheme != "postgresql+psycopg":
        raise pytest.UsageError("测试数据库必须为显式psycopg地址且不含连接覆盖参数；请运行 make test。")
    root = os.environ.get("SHORTFILM_STORAGE_ROOT", "")
    temporary = Path(tempfile.gettempdir()).resolve()
    if not re.fullmatch(r"shortfilm_test_[a-zA-Z0-9_]+", database) or not root:
        raise pytest.UsageError("测试隔离配置缺失；请运行 make test，禁止连接默认应用数据库。")
    if not Path(root).resolve().is_relative_to(temporary) or Path(root).resolve() == temporary:
        raise pytest.UsageError("测试媒体目录必须是独立临时子目录；请运行 make test。")


@pytest.fixture(autouse=True)
def isolated_credential_vault(tmp_path, monkeypatch):
    """Never access native user credentials, including from inherited subprocesses."""
    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(tmp_path / "credentials"))
