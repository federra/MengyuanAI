"""One explicit user-approved mapping; never generates images or guesses identities."""
import json
from pathlib import Path
from urllib.request import Request, urlopen

base = 'http://127.0.0.1:8010/api/v1/projects/c5d12d1c-c909-4555-b76e-f169a8ceac7d'
mapping = [
 ('护目镜','07bb96e6-5b3c-54e1-a7c4-b8bebacd100e','6cbca300-27ae-517c-9a0e-c7dec9f07696'),
 ('珠峰峰顶下方','17c81a3d-8f68-5c09-804c-ca893772ae9f','5971b288-13d5-515e-9670-7ae46535a86d'),
 ('珠峰北坡','dac7011a-b87d-54ca-a82a-b0a9d8d5af68','d2676c40-f2da-5cd7-810f-8deec9454841'),
]

def get(path):
    with urlopen(base + path) as r:
        return json.load(r)


entities = {e['id']: e for e in get('/entities')}
board = get('/stages/board')['item']
refs = get('/media/reference-bindings')
active_refs = {(s['id'], ref) for s in board['body']['shots'] for group in s['refs'].values() for ref in group}
active = {r['entity_id'] for r in refs if (r['shot_id'],r['ref_id']) in active_refs}
items = []
report = []
for name, source_id, target_id in mapping:
    source, target = entities[source_id], entities[target_id]
    assert target_id in active and source['name'] == target['name'] == name
    assert source['kind'] == target['kind'] and source['output_file_id']
    assert target['output_file_id'] in (None, source['output_file_id']), 'New user choice must not be overwritten'
    report.append({'name':name,'source_entity_id':source_id,'source_version_id':source['version_id'],'target_entity_id':target_id,'target_before_version_id':target['version_id'],'file_id':source['output_file_id']})
    if target['output_file_id'] == source['output_file_id']:
        continue
    item = {k:target[k] for k in ('id','revision','kind','name','description','voice','three_view','input_file_id','output_file_id')}
    item['output_file_id'] = source['output_file_id']
    items.append(item)
if items:
    request = Request(base+'/entities/batch', data=json.dumps({'base_board_version_id':board['version_id'],'items':items}).encode(),method='PUT',headers={'Content-Type':'application/json','Idempotency-Key':'user-approved-reuse-8848-20260911-three-images'})
    with urlopen(request) as r:
        response=json.load(r)
    assert len(response['affected_shot_ids']) >= 1
current = get('/entities')
refs = get('/media/reference-bindings')
images = get('/reference-images')
for entry in report:
    target=next(e for e in current if e['id']==entry['target_entity_id'])
    assert target['output_file_id']==entry['file_id']
    linked=[r for r in refs if r['entity_id']==target['id'] and (r['shot_id'],r['ref_id']) in active_refs]
    assert linked and all(r['file_id']==entry['file_id'] for r in linked)
    target_images=[i for i in images if i['entity_id']==target['id'] and i['file_id']==entry['file_id']]
    assert target_images and not any(i['confirmed'] for i in target_images)
    entry.update(target_after_version_id=target['version_id'],linked_shots=len(linked),confirmed=False)
path=Path('evidence/image-preview-auto-reference')
path.mkdir(parents=True,exist_ok=True)
(path/'approved-reuse.json').write_text(json.dumps({'mapping':report,'providerCalls':0},ensure_ascii=False,indent=2))
print('Approved existing images reused:', len(report), '; no supplier calls')
