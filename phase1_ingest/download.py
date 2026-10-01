# -*- coding: utf-8 -*-
"""
Скачивание видео и субтитров через yt-dlp (уже установлен как Python-пакет,
без отдельного бинарника в PATH — используем его напрямую как библиотеку).

Субтитры не пишутся штатным механизмом yt-dlp (writesubtitles/writeautomaticsub),
чтобы не путаться в именах файлов при совпадении кодов языка у ручных и
авто-субтитров: вместо этого сам info-dict, который yt-dlp всегда возвращает,
даёт прямые URL на нужный формат субтитров, и мы скачиваем его сами.
"""
from pathlib import Path
from urllib.request import urlopen
import json

import yt_dlp
from imageio_ffmpeg import get_ffmpeg_exe


PREFERRED_SUBTITLE_FORMATS = ("json3", "vtt")
PREFERRED_LANGS = ("en", "en-US", "en-orig")


def _pick_subtitle_track(tracks_by_lang: dict) -> tuple[str, dict] | None:
    """Выбирает первый доступный язык/формат из списка предпочтений."""
    for lang in PREFERRED_LANGS:
        formats = tracks_by_lang.get(lang)
        if not formats:
            continue
        by_ext = {f["ext"]: f for f in formats if "ext" in f}
        for ext in PREFERRED_SUBTITLE_FORMATS:
            if ext in by_ext:
                return ext, by_ext[ext]
    return None


def download_video(url: str, dest_dir: Path, max_height: int | None = None) -> dict:
    """
    Скачивает видео (лучшее видео+аудио, смёрженные в mp4) и, если доступны,
    субтитры. max_height — не выше этой высоты кадра (1440 = 2K: вдвое-втрое
    меньше места, чем 4K). Возвращает {"video_path", "info", "subtitle_path", "subtitle_source"}.
    """
    from common.progress import report

    dest_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(dest_dir / "source_raw.%(ext)s")

    def on_progress(d: dict) -> None:
        # Видео и звук качаются по отдельности — процент показывается по текущему файлу.
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                report(dest_dir, "download", 100.0 * d.get("downloaded_bytes", 0) / total)

    ydl_opts = {
        "outtmpl": outtmpl,
        "format": (f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best"
                   if max_height else "bestvideo+bestaudio/best"),
        "merge_output_format": "mp4",
        "ffmpeg_location": get_ffmpeg_exe(),
        "quiet": True,
        "noprogress": True,  # процент — через progress_hooks (виден в приложении)
        "no_warnings": True,
        "progress_hooks": [on_progress],
        # Длинные видео качаются долго — сетевые обрывы повторяются, а
        # скачанное продолжается с места обрыва.
        "retries": 20,
        "fragment_retries": 20,
        "continuedl": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        # Сначала только сведения о видео — название и длительность пишутся
        # сразу, чтобы приложение показывало видео (с названием) уже во время
        # скачивания; полный video_info.json перезапишется после скачивания.
        info = ydl.extract_info(url, download=False)
        (dest_dir / "video_info.json").write_text(
            json.dumps(ydl.sanitize_info(info), ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        info = ydl.process_ie_result(info, download=True)

    requested = info.get("requested_downloads") or []
    if requested and requested[0].get("filepath"):
        video_path = Path(requested[0]["filepath"])
    else:
        video_path = dest_dir / "source_raw.mp4"
    if not video_path.exists():
        raise RuntimeError(f"yt-dlp не создал ожидаемый файл: {video_path}")

    subtitle_path = None
    subtitle_source = "none"
    manual = _pick_subtitle_track(info.get("subtitles") or {})
    auto = _pick_subtitle_track(info.get("automatic_captions") or {})
    chosen = manual or auto
    if chosen:
        ext, track = chosen
        subtitle_source = "youtube_manual" if manual else "youtube_auto"
        subtitle_path = dest_dir / f"subtitles.{ext}"
        with urlopen(track["url"]) as response:
            subtitle_path.write_bytes(response.read())

    info_path = dest_dir / "video_info.json"
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    return {
        "video_path": video_path,
        "info": info,
        "subtitle_path": subtitle_path,
        "subtitle_source": subtitle_source,
    }
