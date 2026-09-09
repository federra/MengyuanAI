"""Deterministic local media fixtures are not supplier acceptance evidence."""

import importlib.util
import subprocess

import pytest
from PIL import Image


def processing():
    assert importlib.util.find_spec("shortfilm.media.processing") is not None, (
        "M2 media verifier missing"
    )
    from shortfilm.media import processing

    return processing


def test_rejects_invalid_media_without_trusting_filename(tmp_path):
    module = processing()
    path = tmp_path / "fake.mp4"
    path.write_bytes(b"not a video")
    with pytest.raises(ValueError, match="media_invalid"):
        module.inspect_media(path, "video")


def test_video_probe_and_last_decodable_frame(tmp_path):
    module = processing()
    source, tail = tmp_path / "fixture.mp4", tmp_path / "tail.png"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=128x72:r=24:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
    )
    metadata = module.inspect_media(source, "video")
    assert metadata["width"] == 128 and metadata["height"] == 72
    assert metadata["duration"] == pytest.approx(1, abs=0.1)
    module.extract_last_frame(source, tail)
    with Image.open(tail) as image:
        assert image.size == (128, 72)
        r, g, b = image.convert("RGB").getpixel((64, 36))
        assert r > 200 and g < 30 and b < 30
    with pytest.raises(ValueError, match="media_stream_missing"):
        module.inspect_media(source, "audio")


def test_audio_probe_preserves_real_duration(tmp_path):
    module = processing()
    source = tmp_path / "fixture.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1.25",
            str(source),
        ],
        check=True,
    )
    metadata = module.inspect_media(source, "audio")
    assert metadata["duration"] == pytest.approx(1.25, abs=0.02)
    assert metadata["mime"] == "audio/wav"
    with pytest.raises(ValueError, match="media_stream_missing"):
        module.inspect_media(source, "video")


def test_tail_uses_video_end_when_audio_continues(tmp_path):
    source, tail = tmp_path / "long-audio.mp4", tmp_path / "tail.png"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=128x72:r=24:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(source),
        ],
        check=True,
    )
    processing().extract_last_frame(source, tail)
    with Image.open(tail) as image:
        r, g, b = image.convert("RGB").getpixel((64, 36))
        assert r > 200 and g < 30 and b < 30
