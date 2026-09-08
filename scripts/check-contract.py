import json
from pathlib import Path

from shortfilm.main import app

assert json.loads(Path("contracts/openapi.json").read_text()) == app.openapi(), (
    "OpenAPI drift: run make contract"
)
print("OpenAPI contract matches application.")
