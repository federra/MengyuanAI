import pytest


@pytest.fixture(autouse=True)
def isolated_credential_vault(tmp_path, monkeypatch):
    """Never access native user credentials, including from inherited subprocesses."""
    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(tmp_path / "credentials"))
