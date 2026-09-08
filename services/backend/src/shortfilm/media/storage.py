import os
import tempfile
from pathlib import Path, PurePosixPath
from typing import Protocol


class StorageAdapter(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def read(self, key: str) -> bytes: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        parts = PurePosixPath(key)
        if not key or "\\" in key or parts.is_absolute() or ".." in parts.parts:
            raise ValueError("invalid object key")
        target = (self.root / key).resolve()
        if target == self.root or not target.is_relative_to(self.root):
            raise ValueError("object key escapes storage")
        return target

    def put(self, key: str, data: bytes) -> None:
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, target)
        finally:
            Path(name).unlink(missing_ok=True)

    def read(self, key: str) -> bytes:
        return self.path(key).read_bytes()
