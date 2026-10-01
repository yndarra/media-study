# -*- coding: utf-8 -*-
"""
Этап 1, первая половина — "добавить": видео (или аудио) появляется в
data/<id>/ как мастер-файл source_raw.<расширение> + video_info.json, но
ещё не обработано. Обработку (копия для редактора, распознавание речи,
нарезка на фразы) запускает phase1_ingest.build_manifest.process_project —
отдельно, чтобы до неё к видео можно было прикрепить источники текста для
сверки.

Источники:
  - ссылка (YouTube и всё, что умеет yt-dlp) — acquire_url;
  - свой файл с компьютера (видео или аудио любого формата, который
    понимает ffmpeg) — import_file.
"""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe

from common.progress import report

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".aif"}


def master_path(project_dir: Path) -> Path | None:
    """Мастер-файл проекта (source_raw.<расширение>), если он уже есть."""
    candidates = [p for p in Path(project_dir).glob("source_raw.*") if not p.name.endswith((".part", ".tmp", ".ytdl"))]
    return candidates[0] if candidates else None


def media_streams(path: Path) -> dict:
    """Есть ли в файле видео и звук, и его длительность (по выводу ffmpeg -i)."""
    stderr = subprocess.run([get_ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace").stderr
    duration = 0.0
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    if match:
        h, m, s = match.groups()
        duration = int(h) * 3600 + int(m) * 60 + float(s)
    # Обложка альбома в аудиофайле — тоже "Video:" (attached pic), это не видео.
    video_lines = [line for line in stderr.splitlines() if "Video:" in line and "attached pic" not in line]
    return {"has_video": bool(video_lines), "has_audio": "Audio:" in stderr, "duration": duration}


def acquire_url(url: str, project_dir: Path, max_height: int | None = None) -> dict:
    """Скачивает по ссылке мастер (не выше max_height), субтитры (если есть) и данные видео."""
    from . import download as download_mod

    project_dir = Path(project_dir)
    report(project_dir, "download", 0, force=True)
    downloaded = download_mod.download_video(url, project_dir, max_height)
    report(project_dir, "downloaded", 100, force=True)
    return downloaded


def slug_for_file(name: str, size: int) -> str:
    """Код проекта для своего файла: имя латиницей + короткий хеш (уникальность)."""
    stem = re.sub(r"[^A-Za-z0-9]+", "_", Path(name).stem).strip("_")[:40] or "file"
    digest = hashlib.sha1(f"{name}:{size}".encode("utf-8")).hexdigest()[:6]
    return f"{stem}_{digest}"


def import_file(source: Path, project_dir: Path, original_name: str, move: bool = False) -> dict:
    """
    Принимает свой файл: кладёт его мастером source_raw.<расширение> и пишет
    video_info.json (название — имя файла, автор — "Свои файлы").
    """
    project_dir = Path(project_dir)
    project_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(original_name).suffix.lower() or ".bin"
    target = project_dir / f"source_raw{ext}"
    if move:
        shutil.move(str(source), target)
    elif Path(source).resolve() != target.resolve():
        shutil.copyfile(source, target)
    streams = media_streams(target)
    if not streams["has_audio"]:
        raise RuntimeError("в файле нет звука — распознавать нечего")
    info = {
        "id": project_dir.name,
        "title": Path(original_name).stem,
        "channel": "Свои файлы",
        "duration": round(streams["duration"]),
        "audio_only": not streams["has_video"],
        "local_file": original_name,
    }
    (project_dir / "video_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    report(project_dir, "downloaded", 100, force=True)
    return info
