import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy.dialects.postgresql import insert

from shortfilm.config import settings
from shortfilm.db import Session
from shortfilm.models import Principal, ProjectType, PromptVersion


def seed():
    with Session.begin() as db:
        db.execute(
            insert(Principal)
            .values(id=settings.local_owner_id, name="本地创作者")
            .on_conflict_do_nothing()
        )
        for name in ["营销短视频", "通用短视频", "剧情短片"]:
            db.execute(
                insert(ProjectType)
                .values(id=uuid5(NAMESPACE_URL, name), name=name)
                .on_conflict_do_nothing()
            )
        rows = json.loads((Path(__file__).parent / "data/prompt-seeds.json").read_text())
        for row in rows:
            db.execute(
                insert(PromptVersion)
                .values(
                    id=uuid5(NAMESPACE_URL, row["key"]),
                    interaction_key=row["key"],
                    revision=1,
                    template=f"任务：{row['scene']}。输入：{row['inputs']}。输出：{row['output']}。验收：{row['acceptance']}。",
                    specification=row,
                )
                .on_conflict_do_nothing()
            )


if __name__ == "__main__":
    seed()
    print("Seed data ready (no generated content).")
