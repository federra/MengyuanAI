"""Local deterministic composition. No provider calls, shell, or remote protocols."""

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from shortfilm.media.processing import run_tool


def run(arguments, alive):
    # A file avoids pipe backpressure; heartbeat also fences abandoned encoders.
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(arguments, stdout=subprocess.DEVNULL, stderr=log)
        start = time.monotonic()
        try:
            while True:
                try:
                    code = process.wait(timeout=1)
                    if code:
                        raise ValueError("export_encoding_failed")
                    break
                except subprocess.TimeoutExpired:
                    if not alive():
                        raise ValueError("export_lease_lost")
                    if time.monotonic() - start > 3600:
                        raise ValueError("export_encoding_timeout")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def probe(path):
    return json.loads(
        run_tool(
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
    )


def subtitle(text, path, width, height):
    candidates = [
        os.environ.get("SHORTFILM_SUBTITLE_FONT", ""),
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    font_path = next((f for f in candidates if f and Path(f).is_file()), None)
    if not font_path:
        raise ValueError("export_subtitle_font_missing")
    size = max(16, round(height * 0.04))
    font = ImageFont.truetype(font_path, size)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    lines, line = [], ""
    # Render literal text with Pillow: braces/backslashes are never ASS/filter code.
    for char in text:
        if char == "\n" or draw.textlength(line + char, font=font) > width * 0.88:
            lines.append(line)
            line = "" if char == "\n" else char
        else:
            line += char
    if line:
        lines.append(line)
    if len(lines) > 4:
        raise ValueError("export_subtitle_too_long_split_dialogue")
    y = height - round(height * 0.06) - len(lines) * round(size * 1.4)
    for line in lines:
        x = (width - draw.textlength(line, font=font)) / 2
        draw.text(
            (x, y),
            line,
            font=font,
            fill="white",
            stroke_width=max(1, size // 14),
            stroke_fill="black",
        )
        y += round(size * 1.4)
    image.save(path)


def base_args():
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-y",
        "-filter_complex_threads",
        "1",
    ]


def media_input(path):
    return ["-protocol_whitelist", "file,pipe", "-i", str(path)]


def compose(snapshot, target, resolve_path, alive):
    d, spec = snapshot["draft"], snapshot["specification"]
    w, h, fps = spec["width"], spec["height"], d["fps"]
    with tempfile.TemporaryDirectory(prefix="shortfilm-render-") as tmp:
        root = Path(tmp)
        segments = []
        for n, clip in enumerate(snapshot["clips"]):
            if not alive():
                raise ValueError("export_lease_lost")
            duration, trim = clip["duration"], clip["trim_start"]
            source = resolve_path(clip["file"]["object_key"])
            source_meta = probe(source)
            video_stream = next(s for s in source_meta["streams"] if s["codec_type"] == "video")
            if (
                trim + duration
                > float(video_stream.get("duration") or source_meta["format"]["duration"]) + 0.001
            ):
                raise ValueError("export_video_too_short")
            args = base_args() + media_input(source)
            args += ["-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={duration}"]
            filters = []
            fit = (
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
                if d["fit"] == "pad"
                else f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
            )
            filters.append(
                f"[0:v:0]trim=start={trim}:duration={duration},setpts=PTS-STARTPTS,{fit},setsar=1,fps={fps},format=yuv420p[v0]"
            )
            filters.append("[1:a:0]asetpts=PTS-STARTPTS[a0]")
            audio_labels, visual, input_index = ["[a0]"], "v0", 2
            if d["original_audio"] and any(
                s["codec_type"] == "audio" for s in source_meta["streams"]
            ):
                filters.append(
                    f"[0:a:0]atrim=start={trim}:duration={duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={d['original_volume']}[original]"
                )
                audio_labels.append("[original]")
            for j, line in enumerate(clip["lines"]):
                if line["start"] + line["duration"] > duration + 0.000001:
                    raise ValueError("export_dialogue_overflow")
                if d["narration"]:
                    voice = resolve_path(line["file"]["object_key"])
                    actual = float(probe(voice)["format"]["duration"])
                    if line["start"] + actual > duration + 0.001:
                        raise ValueError("export_dialogue_overflow")
                    args += media_input(voice)
                    delay = round(line["start"] * 48000)
                    filters.append(
                        f"[{input_index}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={d['voice_volume']},adelay={delay}S:all=1[voice{j}]"
                    )
                    audio_labels.append(f"[voice{j}]")
                    input_index += 1
                if d["subtitles"]:
                    png = root / f"sub-{n}-{j}.png"
                    subtitle(line["text"], png, w, h)
                    args += media_input(png)
                    end = line["start"] + line["duration"]
                    filters.append(
                        f"[{visual}][{input_index}:v:0]overlay=0:0:eof_action=repeat:enable='gte(t,{line['start']})*lt(t,{end})'[v{j + 1}]"
                    )
                    visual = f"v{j + 1}"
                    input_index += 1
            filters.append(
                "".join(audio_labels)
                + f"amix=inputs={len(audio_labels)}:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[audio]"
            )
            segment = root / f"clip-{n}.mp4"
            args += [
                "-filter_complex",
                ";".join(filters),
                "-map",
                f"[{visual}]",
                "-map",
                "[audio]",
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                str(segment),
            ]
            run(args, alive)
            segments.append(segment)
        args = base_args()
        for segment in segments:
            args += media_input(segment)
        graph = (
            "".join(f"[{i}:v:0][{i}:a:0]" for i in range(len(segments)))
            + f"concat=n={len(segments)}:v=1:a=1[v][a]"
        )
        audio_label = "a"
        if snapshot["music"]:
            args += ["-stream_loop", "-1"] + media_input(
                resolve_path(snapshot["music"]["object_key"])
            )
            graph += f";[{len(segments)}:a:0]aresample=48000,aformat=channel_layouts=stereo,volume={d['music_volume']}[music];[a][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[mixed]"
            audio_label = "mixed"
        args += [
            "-filter_complex",
            graph,
            "-map",
            "[v]",
            "-map",
            f"[{audio_label}]",
            "-t",
            str(snapshot["duration"]),
            "-r",
            str(fps),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(target),
        ]
        run(args, alive)
    data = probe(target)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
    num, den = video["avg_frame_rate"].split("/")
    actual_fps = float(num) / float(den)
    duration = float(video["duration"])
    if (
        (video["width"], video["height"], video["codec_name"], audio["codec_name"])
        != (w, h, "h264", "aac")
        or abs(duration - snapshot["duration"]) > 1 / fps + 0.001
        or abs(actual_fps - fps) > 0.01
        or abs(float(audio["duration"]) - snapshot["duration"]) > 0.08
    ):
        raise ValueError("export_output_validation_failed")
    run(
        base_args() + media_input(target) + ["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
        alive,
    )
    return {
        "width": w,
        "height": h,
        "duration": duration,
        "fps": actual_fps,
        "video_codec": "h264",
        "audio_codec": "aac",
        "sample_rate": int(audio["sample_rate"]),
        "channels": int(audio["channels"]),
    }
