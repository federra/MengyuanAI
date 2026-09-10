"""One-response script catalog; publication shares the board transaction."""
from typing import Literal
from uuid import UUID, uuid5

from pydantic import Field, model_validator

from shortfilm.creation.stage_schemas import BoardBody
from shortfilm.schemas import DTO


class CatalogEntry(DTO):
    key: str = Field(min_length=1, max_length=100)
    kind: Literal['character', 'scene', 'prop']
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=10000)


class ShotEntities(DTO):
    shotIndex: int = Field(ge=0)
    characters: list[str]
    scenes: list[str]
    props: list[str]
    lineCharacters: list[str | None]


class GeneratedBoard(BoardBody):
    catalog: list[CatalogEntry] = Field(max_length=1000)
    shotEntities: list[ShotEntities]

    @model_validator(mode='after')
    def catalog_bindings(self):
        entries = {e.key: e for e in self.catalog}
        if len(entries) != len(self.catalog):
            raise ValueError('实体目录键重复')
        if sorted(s.shotIndex for s in self.shotEntities) != list(range(len(self.shots))):
            raise ValueError('每镜必须且只能有一份实体绑定')
        for binding in self.shotEntities:
            shot = self.shots[binding.shotIndex]
            for group, kind in [('characters', 'character'), ('scenes', 'scene'), ('props', 'prop')]:
                keys = getattr(binding, group)
                if len(keys) != len(set(keys)) or any(k not in entries or entries[k].kind != kind for k in keys):
                    raise ValueError('实体引用未知、重复或种类不匹配')
            if len(binding.lineCharacters) != len(shot.dialogues):
                raise ValueError('台词实体绑定数量不匹配')
            if any(k is not None and (k not in entries or entries[k].kind != 'character') for k in binding.lineCharacters):
                raise ValueError('台词必须绑定目录中的角色或为null旁白')
        return self


def publish_catalog(db, project, job, body, catalog, bindings):
    from shortfilm.assets.models import Entity
    from shortfilm.assets.schemas import EntityCreate
    from shortfilm.assets.service import append_entity
    from shortfilm.media.models import LineBinding, ShotReferenceVersion
    entities = {}
    for entry in catalog:
        eid = uuid5(job.id, 'entity:' + entry['key'])
        entity = Entity(id=eid, project_id=project.id, kind=entry['kind'], revision=1)
        db.add(entity)
        db.flush()
        append_entity(db, entity, EntityCreate(kind=entry['kind'], name=entry['name'], description=entry['description'], voice='', three_view=entry['kind'] == 'character'))
        entities[entry['key']] = eid
    for binding in bindings:
        shot = body['shots'][binding['shotIndex']]
        mentions = []
        for group in ['characters', 'scenes', 'props']:
            for key in binding[group]:
                rid = uuid5(job.id, shot['id'] + ':' + key)
                db.add(ShotReferenceVersion(project_id=project.id, shot_id=UUID(shot['id']), ref_id=rid, entity_id=entities[key], file_id=None, revision=1))
                shot['refs'][group].append(str(rid))
                mentions.append((next(e['name'] for e in catalog if e['key'] == key), str(rid)))
        shot['prompt'] = insert_catalog_mentions(shot['prompt'], mentions)
        shot['prompt'] = inline_role_mentions(shot['prompt'], [(name, rid) for name, rid in mentions if rid in shot['refs']['characters']])
        for line, key in zip(shot['dialogues'], binding['lineCharacters'], strict=True):
            if key is not None:
                db.add(LineBinding(project_id=project.id, line_id=UUID(line['id']), entity_id=entities[key], revision=1))
    db.flush()
    return body


def insert_catalog_mentions(prompt, mentions):
    """Resolve only explicit shot catalog bindings, never infer identity from duplicate labels."""
    import re
    from collections import Counter

    counts = Counter(name for name, _ in mentions)
    unique = {name: rid for name, rid in mentions if counts[name] == 1}
    if unique:
        pattern = r'@?(' + '|'.join(re.escape(n) for n in sorted(unique, key=len, reverse=True)) + r')'
        prompt = re.sub(pattern, lambda m: ('' if m[0].startswith('@') else m[1]) + '@[' + unique[m[1]] + ']', prompt)
    for name, rid in mentions:
        token = '@[' + rid + ']'
        if token not in prompt:
            prompt += ' ' + name + token
    return prompt


def inline_role_mentions(prompt, mentions):
    """Relocate existing role tokens using explicit IDs; retain ambiguous names unchanged."""
    import re
    from collections import Counter

    if not mentions:
        return prompt
    counts = Counter(name for name, _ in mentions)
    pattern = '|'.join(re.escape(n) for n in sorted(counts, key=len, reverse=True))
    prose = re.sub(r'@\[[^\]]+\]', '', prompt)
    present = set(re.findall(pattern, prose))
    eligible = {name: rid for name, rid in mentions if counts[name] == 1 and name in present and '@[' + rid + ']' in prompt}
    for rid in eligible.values():
        token = '@[' + rid + ']'
        prompt = prompt.replace('（' + token + '）', '').replace('(' + token + ')', '').replace(token, '')
    return ''.join(part if part.startswith('@[') else re.sub(pattern, lambda m: m[0] + '（@[' + eligible[m[0]] + ']）' if m[0] in eligible else m[0], part) for part in re.split(r'(@\[[^\]]+\])', prompt)).rstrip()
