# ruff: noqa: F401, F811
"""New one-response contract; transport fixtures do not certify model quality."""
from copy import deepcopy
from uuid import uuid4

import pytest
from shortfilm.creation.entity_catalog import GeneratedBoard
from shortfilm.creation.stage_execution import schema_for
from test_content_chain import chain, chain_model
from test_story import client, model


def test_catalog_publishes_entities_bindings_with_board(client, chain_model, monkeypatch):
    original = chain_model.request_json
    def response(config, messages, schema):
        result, meta = original(config, messages, schema)
        if 'catalog' in schema.get('properties', {}):
            result['catalog'] = [
                {'key': 'postman', 'kind': 'character', 'name': '邮差', 'description': '卡通蓝制服邮差，三视图'},
                {'key': 'post', 'kind': 'scene', 'name': '邮局', 'description': '木门邮局'},
                {'key': 'letter', 'kind': 'prop', 'name': '信', 'description': '牛皮纸信封'},
                {'key': 'offscreen', 'kind': 'character', 'name': '未出镜角色', 'description': '剧本中提及的卡通角色'},
            ]
            result['shotEntities'] = [{'shotIndex': 0, 'characters': ['postman'], 'scenes': ['post'], 'props': ['letter'], 'lineCharacters': ['postman', None]}]
        return result, meta
    monkeypatch.setattr(chain_model, 'request_json', response)
    base, _, _, _, board = chain(client)
    entities = client.get(base + '/entities').json()
    assert len(entities) == 4
    role = next(e for e in entities if e['name'] == '邮差')
    assert role['three_view'] is True
    assert all(e['output_file_id'] is None for e in entities)
    shot = board['body']['shots'][0]
    assert '邮差（@[' + shot['refs']['characters'][0] + ']）' in shot['prompt']
    assert len(shot['refs']['characters']) == len(shot['refs']['scenes']) == len(shot['refs']['props']) == 1
    bindings = client.get(base + '/media/line-bindings').json()
    assert any(b['line_id'] == shot['dialogues'][0]['id'] and b['entity_id'] == role['id'] for b in bindings)
    assert client.get(base + '/stages/board').json()['item']['body'] == board['body']


def test_catalog_schema_rejects_bad_bindings_and_preserves_legacy_contract():
    assert schema_for('board.generate').__name__ == 'BoardBody'
    assert schema_for('board.generate', {'entity_catalog_contract': 1}) is GeneratedBoard
    body = {'schemaVersion': 2, 'scriptId': str(uuid4()), 'catalog': [{'key':'r','kind':'character','name':'R','description':'cartoon'}], 'shots':[{'id':'s','dialogue':'Hi','dialogues':[{'id':'l','text':'Hi'}], 'refs':{},'prompt':'hello','duration':3}], 'shotEntities':[{'shotIndex':0,'characters':['r'],'scenes':[],'props':[],'lineCharacters':['r']}]}
    GeneratedBoard.model_validate(body)
    for patch in [{'characters':['missing']}, {'scenes':['r']}, {'shotIndex':1}, {'lineCharacters':[]}]:
        invalid = deepcopy(body)
        invalid['shotEntities'][0].update(patch)
        with pytest.raises(ValueError):
            GeneratedBoard.model_validate(invalid)


def test_voice_assets_are_real_versioned_resources(client):
    base='/api/v1/settings/resources'
    name='Voice '+str(uuid4())
    result=client.post(base,json={'name':name,'kind':'voice','stage':'voice','content':'cartoon_voice_01','required_variables':[]})
    assert result.status_code == 201, result.text
    assert any(r['id']==result.json()['id'] for r in client.get(base+'?kind=voice').json())
    invalid=client.post(base,json={'name':name+' invalid','kind':'voice','stage':'story','content':'{{secret}}','required_variables':[]})
    assert invalid.status_code == 422


def test_invalid_catalog_correction_never_partially_replaces_board(client, chain_model, monkeypatch):
    from shortfilm.jobs.service import execute_job
    from test_story import post
    base, _, _, script, board = chain(client)
    previous = client.get(base + '/entities').json()
    original = chain_model.request_json
    def invalid(config, messages, schema):
        body, metadata = original(config, messages, schema)
        if 'catalog' in schema.get('properties', {}):
            body['catalog'] = [{'key':'same','kind':'character','name':'new','description':'cartoon'}] * 2
        return body, metadata
    monkeypatch.setattr(chain_model, 'request_json', invalid)
    job = post(client, base+'/stages/board/generate', {'source_version_id':script['version_id'],'target_revision':board['revision']}).json()
    execute_job(job['id'])
    assert client.get('/api/v1/jobs/'+job['id']).json()['state'] == 'failed'
    assert client.get(base+'/stages/board').json()['item']['version_id'] == board['version_id']
    assert client.get(base+'/entities').json() == previous


def test_mentions_do_not_guess_duplicate_names_or_match_short_name_first():
    from shortfilm.creation.entity_catalog import insert_catalog_mentions
    assert insert_catalog_mentions('小明和小明叔叔', [('小明', 'a'), ('小明叔叔', 'b')]) == '小明@[a]和小明叔叔@[b]'
    result = insert_catalog_mentions('邮差前进', [('邮差', 'a'), ('邮差', 'b')])
    assert result == '邮差前进 邮差@[a] 邮差@[b]'


def test_inline_roles_relocates_legacy_tail_without_rebinding_or_duplication():
    from shortfilm.creation.entity_catalog import inline_role_mentions
    original = '阿伦·韦克攀爬，护目镜结霜。 @[role] @[prop]'
    expected = '阿伦·韦克（@[role]）攀爬，护目镜结霜。  @[prop]'
    assert inline_role_mentions(original, [('阿伦·韦克', 'role')]) == expected
    assert inline_role_mentions(expected, [('阿伦·韦克', 'role')]) == expected
    assert inline_role_mentions(original, [('阿伦·韦克', 'role'), ('阿伦·韦克','other')]) == original
