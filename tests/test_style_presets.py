# ruff: noqa: F401, F811
from uuid import NAMESPACE_URL, uuid5

from shortfilm.config_models import Resource, ResourceVersion
from shortfilm.configuration.style_seeds import STYLES, seed_styles
from shortfilm.db import Session
from sqlalchemy import select
from test_story import client


def test_three_presets_are_versioned_editable_and_reseed_keeps_user_edits(client):
    with Session.begin() as db:
        seed_styles(db)
        for name in STYLES:
            rid = uuid5(NAMESPACE_URL, 'shortfilm:style:' + name)
            row = db.get(Resource, rid)
            assert row and row.kind == 'style'
            old = db.scalar(select(ResourceVersion).where(ResourceVersion.resource_id == rid, ResourceVersion.revision == 1))
            assert old.content == STYLES[name]
        rid = uuid5(NAMESPACE_URL, 'shortfilm:style:清新动画')
        row = db.get(Resource, rid)
        row.revision = 2
        db.add(ResourceVersion(resource_id=rid, revision=2, name='清新动画', content='用户自定义动画色板', required_variables=[]))
        db.flush()
        seed_styles(db)
        assert db.get(Resource, rid).revision == 2
        assert db.scalar(select(ResourceVersion.content).where(ResourceVersion.resource_id == rid, ResourceVersion.revision == 2)) == '用户自定义动画色板'
