"""Validate local media and derive the actual last frame, without network protocols."""

import json
import math
import subprocess
from pathlib import Path


def run_tool(arguments, timeout=60):
    try:
        return subprocess.run(arguments, check=True, capture_output=True, timeout=timeout).stdout
    except FileNotFoundError:
        raise ValueError("media_tools_missing") from None
    except (subprocess.SubprocessError, OSError):
        raise ValueError("media_invalid") from None


def inspect_media(path: Path, kind: str):
    if kind not in ("audio", "video"):
        raise ValueError("media_kind_invalid")
    if not path.is_file() or not 0 < path.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError("media_invalid")
    raw = run_tool(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ]
    )
    try:
        data = json.loads(raw)
        streams = [
            s
            for s in data["streams"]
            if s.get("codec_type") == kind and not s.get("disposition", {}).get("attached_pic")
        ]
        if not streams:
            raise ValueError("media_stream_missing")
        stream = streams[0]
        duration = float(stream.get("duration") or data["format"]["duration"])
        if not math.isfinite(duration) or not 0 < duration <= 36000:
            raise ValueError("media_invalid")
        metadata = {"duration": duration, "codec": stream["codec_name"]}
        if kind == "video":
            width, height = int(stream["width"]), int(stream["height"])
            if not 0 < width <= 8192 or not 0 < height <= 8192:
                raise ValueError("media_invalid")
            metadata.update(width=width, height=height, mime="video/mp4")
            if "mp4" not in data["format"]["format_name"].split(","):
                raise ValueError("media_format_unsupported")
        else:
            mime = {
                "mp3": "audio/mpeg",
                "wav": "audio/wav",
                "flac": "audio/flac",
                "ogg": "audio/ogg",
            }.get(data["format"]["format_name"])
            if not mime:
                raise ValueError("media_format_unsupported")
            metadata.update(
                mime=mime, sample_rate=int(stream["sample_rate"]), channels=int(stream["channels"])
            )
    except (KeyError, TypeError, json.JSONDecodeError, OverflowError):
        raise ValueError("media_invalid") from None
    # Decode the complete selected stream. A successful probe alone is insufficient.
    run_tool(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-xerror",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(path),
            "-map",
            f"0:{stream['index']}",
            "-f",
            "null",
            "-",
        ],
        timeout=120,
    )
    return metadata


def extract_last_frame(source: Path, target: Path):
    metadata = inspect_media(source, "video")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        # Decode the video stream and overwrite a single image with each real frame.
        # Container duration may extend past video EOF when the audio track is longer.
        run_tool(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-xerror",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-an",
                "-fps_mode",
                "passthrough",
                "-update",
                "1",
                str(target),
            ],
            timeout=120,
        )
        from PIL import Image

        with Image.open(target) as image:
            image.load()
            if image.size != (metadata["width"], metadata["height"]):
                raise ValueError("media_invalid")
    except (OSError, ValueError):
        target.unlink(missing_ok=True)
        raise ValueError("last_frame_extraction_failed") from None
    return metadata
