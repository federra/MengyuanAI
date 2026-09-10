from copy import deepcopy

from shortfilm.creation.snapshots import render_configuration


def test_board_prompt_freezes_full_text_authority_without_rewriting_resources():
    frozen = {
        "interaction_key": "storyboard",
        "configuration": {
            "template": {"revision": 7, "content": "{{source}}", "required_variables": ["source"]},
            "method": None, "style": None, "specification": {},
        },
    }
    before = deepcopy(frozen)
    source = {"text": "场一 夜 外\n猫：完整保留这句对白。\n场二 日 内\n狗把信交还。", "scenes": [], "estimatedSeconds": 1}
    result = render_configuration(frozen, {"kind": "board.generate", "source": source, "input": source})
    assert "source.text完整剧本正文是唯一叙事依据" in result["prompt"]["template"]
    assert "不能作为固定时长或删减正文的依据" in result["prompt"]["template"]
    assert "完整保留这句对白" in result["prompt"]["template"]
    assert frozen == before


# Reuse only isolated PostgreSQL client and fake configuration fixtures.
from test_story import client, model, new_project, post  # noqa: E402,F401


def test_edited_script_is_persisted_and_frozen_for_board(client, model):  # noqa: F811
    import json
    from uuid import uuid4

    base = f"/api/v1/projects/{new_project(client)}"
    imported = post(client, base + "/stories/import-txt", {
        "filename": "卡通故事.txt", "text": "小猫归还信件。",
        "expected_story_version_id": None,
    })
    assert imported.status_code == 200, imported.text
    story = imported.json()["items"][0]
    body = {
        "text": "旧正文", "estimatedSeconds": 1,
        "scenes": [{"id": "old-scene", "heading": "旧场景", "actions": [],
                    "dialogues": [{"speaker": "旧人物", "emotion": "", "text": "旧台词"}]}],
    }
    first = client.put(base + "/stages/script", json={
        "revision": 0, "source_version_id": story["version_id"], "body": body,
    })
    assert first.status_code == 200, first.text
    full = "场一 夜 外\n小猫走到邮筒前。\n小猫：这封信应该还给你。\n\n场二 日 内\n小狗：谢谢你。"
    saved = client.put(base + "/stages/script", json={
        "revision": 1, "source_version_id": story["version_id"], "body": {**body, "text": full},
    })
    assert saved.status_code == 200, saved.text
    item = saved.json()
    assert item["body"]["text"] == full
    assert "旧台词" not in json.dumps(item["body"], ensure_ascii=False)
    assert client.get(base + "/stages/script").json()["item"]["version_id"] == item["version_id"]
    key = str(uuid4())
    request = {"source_version_id": item["version_id"], "target_revision": 0}
    pending = post(client, base + "/stages/board/generate", request, key)
    assert pending.status_code == 202, pending.text
    job = pending.json()
    assert job["snapshot"]["source"]["text"] == full
    assert "source.text完整剧本正文是唯一叙事依据" in job["snapshot"]["prompt"]["template"]
    assert post(client, base + "/stages/board/generate", request, key).json()["id"] == job["id"]
    assert client.get(base + f"/versions/{first.json()['version_id']}").json()["body"]["text"] == "旧正文"
    other = f"/api/v1/projects/{new_project(client)}"
    assert post(client, other + "/stages/board/generate", request).status_code == 404
    # No execute_job or worker: this tests the real API/PG snapshot without a model call.
