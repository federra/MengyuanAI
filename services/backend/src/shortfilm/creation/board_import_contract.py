"""Versioned public import contract, bundled for installed backend deployments."""

import json
import math
import re

from fastapi import HTTPException

SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "AI短片工坊 分镜导入包 v1",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "format": {"const": "shortfilm-storyboard-import"},
        "schemaVersion": {"const": 1},
        "shots": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 100,
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
                    },
                    "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 600},
                    "prompt": {"type": "string", "minLength": 1, "maxLength": 10000},
                    "assets": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 100,
                                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
                                },
                                "kind": {"enum": ["角色", "场景", "道具", "站位"]},
                                "name": {"type": "string", "minLength": 1, "maxLength": 100},
                                "description": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2000,
                                },
                            },
                            "required": ["id", "kind", "name", "description"],
                        },
                        "minItems": 0,
                        "maxItems": 100,
                    },
                    "dialogues": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 100,
                                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
                                },
                                "speaker": {"type": "string", "minLength": 1, "maxLength": 100},
                                "emotion": {"type": "string", "minLength": 1, "maxLength": 100},
                                "text": {"type": "string", "maxLength": 10000},
                                "voice": {"type": "string", "minLength": 1, "maxLength": 100},
                            },
                            "required": ["id", "speaker", "emotion", "text", "voice"],
                        },
                        "minItems": 1,
                        "maxItems": 100,
                    },
                    "bindings": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "assetIds": {
                                "type": "array",
                                "items": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 100,
                                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
                                },
                                "minItems": 0,
                                "maxItems": 100,
                            },
                            "dialogueIds": {
                                "type": "array",
                                "items": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 100,
                                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
                                },
                                "minItems": 1,
                                "maxItems": 100,
                            },
                        },
                        "required": ["assetIds", "dialogueIds"],
                    },
                    "generation": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "model": {"type": "string", "minLength": 1, "maxLength": 200},
                            "aspect": {"enum": ["9:16", "16:9", "1:1"]},
                            "resolution": {"enum": ["720P", "1080P", "4K"]},
                        },
                        "required": [],
                    },
                },
                "required": ["id", "duration", "prompt", "assets", "dialogues", "bindings"],
            },
            "minItems": 1,
            "maxItems": 100,
        },
    },
    "required": ["format", "schemaVersion", "shots"],
}

TEMPLATE = {
    "format": "shortfilm-storyboard-import",
    "schemaVersion": 1,
    "shots": [
        {
            "id": "shot-1",
            "duration": 5,
            "prompt": "中景，角色走进场景，拿起道具。参考 @[person-1] @[scene-1] @[prop-1] @[position-1]",
            "assets": [
                {"id": "person-1", "kind": "角色", "name": "主角", "description": "角色外貌与服装"},
                {"id": "scene-1", "kind": "场景", "name": "房间", "description": "室内环境与光线"},
                {"id": "prop-1", "kind": "道具", "name": "信件", "description": "关键道具外观"},
                {
                    "id": "position-1",
                    "kind": "站位",
                    "name": "门边站位",
                    "description": "角色面向室内",
                },
            ],
            "dialogues": [
                {
                    "id": "line-1",
                    "speaker": "主角",
                    "emotion": "自然",
                    "text": "终于回来了。",
                    "voice": "默认音色",
                }
            ],
            "bindings": {
                "assetIds": ["person-1", "scene-1", "prop-1", "position-1"],
                "dialogueIds": ["line-1"],
            },
        }
    ],
}


def invalid(path, message):
    raise HTTPException(
        422, [{"loc": ["packageJson", *path], "msg": message, "type": "value_error"}]
    )


def validate(value, schema, path=()):
    """Validate precisely the small, fixed public schema vocabulary without coercion."""
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        invalid(path, "格式或版本不正确")
    if "enum" in schema and (not isinstance(value, str) or value not in schema["enum"]):
        invalid(path, "不支持的选项")
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            invalid(path, "必须为对象")
        fields = schema["properties"]
        for key in value:
            if key not in fields:
                invalid((*path, key), "不允许未知字段")
        for key in schema.get("required", []):
            if key not in value:
                invalid((*path, key), "缺少必填字段")
        for key, item in value.items():
            validate(item, fields[key], (*path, key))
    elif kind == "array":
        if not isinstance(value, list):
            invalid(path, "必须为数组")
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 100000):
            invalid(path, "数组数量超出允许范围")
        for index, item in enumerate(value):
            validate(item, schema["items"], (*path, index))
    elif kind == "string":
        if not isinstance(value, str):
            invalid(path, "必须为文本")
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 1048576):
            invalid(path, "文本长度超出允许范围")
        if schema.get("minLength", 0) and not value.strip():
            invalid(path, "必填文本不能为空白")
        if schema.get("pattern") and not re.fullmatch(schema["pattern"], value):
            invalid(path, "ID须以字母开头且只包含字母、数字、下划线或连字符")
    elif kind == "number":
        if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
            invalid(path, "必须为有限数字")
        if value <= schema.get("exclusiveMinimum", -math.inf) or value > schema.get(
            "maximum", math.inf
        ):
            invalid(path, "数字超出允许范围")


def parse_package(raw):
    try:
        encoded = raw.encode("utf-8", errors="strict")
    except UnicodeError:
        invalid((), "文件必须为有效UTF-8")
    if len(encoded) > 1048576:
        invalid((), "文件不能超过1MB")
    depth, quoted, escaped = 0, False, False
    for char in raw:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > 32:
                invalid((), "JSON嵌套过深")
        elif char in "]}":
            depth -= 1

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                invalid((key,), "JSON键重复")
            result[key] = value
        return result

    def constant(value):
        invalid((), "JSON不能包含NaN或Infinity")

    try:
        package = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError):
        invalid((), "JSON格式无效")
    validate(package, SCHEMA)
    # Escaped lone surrogates are not UTF-8 content either.
    try:
        json.dumps(package, ensure_ascii=False).encode("utf-8", errors="strict")
    except UnicodeError:
        invalid((), "JSON文本包含非法Unicode字符")
    seen = set()
    for index, shot in enumerate(package["shots"]):
        path = ("shots", index)
        for identifier in [
            shot["id"],
            *[a["id"] for a in shot["assets"]],
            *[d["id"] for d in shot["dialogues"]],
        ]:
            if identifier in seen:
                invalid(path, "镜头、图片、台词ID必须在整个文件内唯一")
            seen.add(identifier)
        refs = shot["bindings"]["assetIds"]
        lines = shot["bindings"]["dialogueIds"]
        if len(set(refs)) != len(refs) or len(set(lines)) != len(lines):
            invalid((*path, "bindings"), "绑定ID不能重复")
        if set(refs) != set(re.findall(r"@\[([^\]]+)\]", shot["prompt"])) or not set(refs).issubset(
            {a["id"] for a in shot["assets"]}
        ):
            invalid((*path, "bindings", "assetIds"), "图片绑定必须匹配本镜提示词中的图片ID")
        if set(lines) != {d["id"] for d in shot["dialogues"]}:
            invalid((*path, "bindings", "dialogueIds"), "台词绑定必须完整匹配本镜台词ID")
        # Every temporary reference becomes a canonical 36-character UUID.
        # Validate the internal representation before persisting a usable preview.
        mapped_length = len(shot["prompt"].strip()) + sum(
            36 - len(match[1]) for match in re.finditer(r"@\[([^\]]+)\]", shot["prompt"])
        )
        if mapped_length > 10000:
            invalid((*path, "prompt"), "图片ID映射后提示词超过10000字符，请缩短正文或减少重复引用")
    return package


def statistics(package):
    return {
        "shots": len(package["shots"]),
        "dialogues": sum(len(s["dialogues"]) for s in package["shots"]),
        "assets": sum(len(s["assets"]) for s in package["shots"]),
        "totalSeconds": sum(s["duration"] for s in package["shots"]),
    }
