# ruff: noqa: F401, F811
from uuid import uuid4

from test_content_chain import chain_model
from test_entity_strict import batch, row
from test_media_chain import execute, media_provider
from test_story import client, model


def test_generated_scene_and_prop_link_by_id_and_still_need_confirmation(client, chain_model, media_provider):
    from test_content_chain import chain
    base, _, _, _, board = chain(client)
    pid = base.split('/')[-1]
    current = board['version_id']
    for kind in ['scene', 'prop']:
        entity = row(kind=kind, name='同名元素')
        batch(client, pid, [entity], current)
        bound = client.post(base+f"/entities/{entity['id']}/shot-bindings", json={'entity_revision':1,'board_version_id':current,'shot_id':board['body']['shots'][0]['id'],'mode':'add'},headers={'Idempotency-Key':str(uuid4())}).json()
        current = bound['board_version_id']
        result = client.post(base+'/media/images',json={'entity_id':entity['id'],'entity_revision':1},headers={'Idempotency-Key':str(uuid4())})
        assert result.status_code==202,result.text
        execute(result.json()['id'])
        images=client.get(base+'/reference-images').json()
        image=next(i for i in images if i['entity_id']==entity['id'])
        refs=client.get(base+'/media/reference-bindings').json()
        linked=next(r for r in refs if r['ref_id']==bound['ref_id'])
        assert linked['file_id']==image['file_id'] and linked['entity_id']==entity['id']
        assert not image['confirmed']
        execute(result.json()['id'])
        assert client.get(base+'/media/reference-bindings').json()==refs


def test_generated_position_appends_real_file_and_keeps_result_unconfirmed(client, chain_model, media_provider):
    from test_media_chain import media_board
    base, board = media_board(client, chain_model)
    sid = board['body']['shots'][0]['id']
    task = client.post(base+'/media/images', json={'board_version_id':board['version_id'],'shot_id':sid},headers={'Idempotency-Key':str(uuid4())})
    assert task.status_code==202,task.text
    execute(task.json()['id'])
    current=client.get(base+'/stages/board').json()['item']
    result=next(r for r in client.get(base+'/media/results').json() if r['kind']=='image.position')
    assert current['revision']==board['revision']+1
    assert result['file_id'] in current['body']['shots'][0]['refs']['positions']
    assert not result['stale'] and not result['confirmed']
    execute(task.json()['id'])
    assert client.get(base+'/stages/board').json()['item']['version_id']==current['version_id']
