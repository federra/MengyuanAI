"""Read-only old-column/byte preservation audit before and after an approved migration."""

import hashlib
import json
import sys
from pathlib import Path

from psycopg import connect, sql
from shortfilm.config import settings
from sqlalchemy.engine import make_url

path = Path("evidence/entity-upgrade-audit.json")
url = (
    make_url(settings.database_url)
    .set(drivername="postgresql")
    .render_as_string(hide_password=False)
)
with connect(url) as conn:
    if sys.argv[1] == "before":
        columns = {}
        for table, column in conn.execute(
            "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name!='alembic_version' ORDER BY table_name,ordinal_position"
        ):
            columns.setdefault(table, []).append(column)
        report = {"columns": columns}
    else:
        report = json.loads(path.read_text())
    inventory = {}
    for table, names in report["columns"].items():
        query = sql.SQL(
            "SELECT row_to_json(t)::text FROM (SELECT {} FROM {}) t ORDER BY row_to_json(t)::text"
        ).format(sql.SQL(",").join(map(sql.Identifier, names)), sql.Identifier(table))
        rows = conn.execute(query).fetchall()
        inventory[table] = {
            "count": len(rows),
            "sha256": hashlib.sha256("\n".join(r[0] for r in rows).encode()).hexdigest(),
        }
    media = conn.execute("SELECT object_key,sha256 FROM media_files ORDER BY object_key").fetchall()
    for key, digest in media:
        assert hashlib.sha256((settings.storage_root / key).read_bytes()).hexdigest() == digest
    revision = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    if sys.argv[1] == "before":
        report.update(before=inventory, old_revision=revision, media=media)
    else:
        assert inventory == report["before"], "Old data changed"
        assert [list(row) for row in media] == report["media"], "Media records changed"
        report.update(new_revision=revision, old_rows_unchanged=True, media_hashes_unchanged=True)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(sys.argv[1], revision, len(inventory), "tables;", len(media), "files; audit saved")
