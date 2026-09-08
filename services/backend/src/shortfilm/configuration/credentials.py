"""Local encrypted credentials, separate from DB/media/backups; never cache plaintext.

The application OS account is trusted. This is not a multi-user secret manager.
All readers/writers share an advisory process lock and reject unsafe filesystem entries.
"""

import fcntl
import json
import os
import stat
import threading
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken

_LOCK = threading.RLock()


class CredentialError(Exception):
    pass


def endpoint_identity(endpoint):
    p = urlsplit(endpoint)
    host = (p.hostname or "").lower()
    if (
        p.scheme not in ("https", "http")
        or not host
        or p.username
        or p.password
        or p.query
        or p.fragment
    ):
        raise CredentialError("credential_endpoint_invalid")
    if p.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
        raise CredentialError("credential_endpoint_invalid")
    port = p.port
    authority = f"[{host}]" if ":" in host else host
    if port and port != (443 if p.scheme == "https" else 80):
        authority += f":{port}"
    return urlunsplit((p.scheme, authority, p.path.rstrip("/"), "", ""))


def _check(path, directory=False):
    info = path.lstat()
    if (
        not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or (not directory and info.st_nlink != 1)
    ):
        raise CredentialError("credential_storage_unsafe")


def _read(path):
    _check(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        return stream.read()


def _write(root, name, data):
    target = root / name
    if target.exists() or target.is_symlink():
        _check(target)
    temporary = root / (".tmp-" + uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _vault():
    root = Path(
        os.environ.get(
            "SHORTFILM_CREDENTIAL_ROOT",
            str(Path(__file__).resolve().parents[5] / ".local/credentials"),
        )
    ).absolute()
    try:
        # Refuse symlinks in the complete configured path (including parents).
        for p in (*reversed(root.parents), root):
            if p.is_symlink():
                raise CredentialError("credential_storage_unsafe")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        _check(root, directory=True)
        with _LOCK:
            path = root / "vault.lock"
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                _check(path)
                fcntl.flock(fd, fcntl.LOCK_EX)
                keyfile, datafile = root / "master.key", root / "vault.enc"
                if keyfile.is_symlink() or datafile.is_symlink():
                    raise CredentialError("credential_storage_unsafe")
                if not keyfile.exists():
                    if datafile.exists():
                        raise CredentialError("credential_storage_unavailable")
                    _write(root, "master.key", Fernet.generate_key())
                cipher = Fernet(_read(keyfile))
                data = json.loads(cipher.decrypt(_read(datafile))) if datafile.exists() else {}
                yield root, cipher, data
            finally:
                os.close(fd)
    except CredentialError:
        raise
    except (OSError, ValueError, InvalidToken, TypeError):
        raise CredentialError("credential_storage_unavailable") from None


def metadata(ref, endpoint):
    endpoint = endpoint_identity(endpoint)
    with _vault() as (_, _, data):
        entry = data.get(ref)
        if entry:
            match = entry["endpoint"] == endpoint
            return {
                "configured": match,
                "source": "stored" if match else "endpoint_mismatch",
                "revision": entry["revision"],
            }
    return {
        "configured": bool(os.environ.get(ref)),
        "source": "environment" if os.environ.get(ref) else "none",
        "revision": 0,
    }


def resolve(ref, endpoint, revision=None):
    endpoint = endpoint_identity(endpoint)
    with _vault() as (_, _, data):
        entry = data.get(ref)
        if revision is not None and revision != (entry["revision"] if entry else 0):
            raise CredentialError("credential_revision_conflict")
        if entry:
            if entry["endpoint"] != endpoint:
                raise CredentialError("credential_endpoint_mismatch")
            return entry["secret"]
    value = os.environ.get(ref)
    if not value:
        raise CredentialError("text_credential_missing")
    return value


def save(ref, endpoint, secret, base_version):
    endpoint = endpoint_identity(endpoint)
    with _vault() as (root, cipher, data):
        revision = data.get(ref, {}).get("revision", 0)
        if revision != base_version:
            raise CredentialError("credential_revision_conflict")
        data[ref] = {"endpoint": endpoint, "secret": secret, "revision": revision + 1}
        _write(root, "vault.enc", cipher.encrypt(json.dumps(data).encode()))
    return {"configured": True, "source": "stored", "revision": revision + 1}
