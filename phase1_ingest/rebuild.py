# -*- coding: utf-8 -*-
"""
Пересборка манифеста из уже готовых артефактов проекта — без повторного
скачивания и без повторного распознавания речи (самые долгие шаги).

Нужна после изменений алгоритма нарезки/привязки текста. Копия видео для
редактора пересоздаётся из мастера, только если её нет или она крупнее
допустимого разрешения (или явно передан --remake-proxy).

ВНИМАНИЕ: ручные правки в manifest.json заменяются новым разбиением;
старый манифест сохраняется рядом как manifest.bak-<дата-время>.json.
Фрагменты, уже вынесенные на этап 3 (exported), не трогаются: пересобирается
только часть видео после них.

Использование:
  py -3.12 -m phase1_ingest.rebuild --project-dir data/<id> [--transcript file.txt] [--remake-proxy]
"""
import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from common.audio_track import build_audio_track
from common.manifest_schema import Manifest, VideoInfo
from common.waveform import build_waveform

from .build_manifest import assemble_manifest, load_source_words, unvoiced_speakers
from .download import _pick_subtitle_track
from . import reencode as reencode_mod


def _find_subtitles(project_dir: Path) -> Path | None:
    for candidate in sorted(project_dir.glob("subtitles.*")):
        if candidate.suffix.lower() in (".json3", ".vtt"):
            return candidate
    return None


def rebuild(project_dir: Path, transcript_path: Path | None, remake_proxy: bool) -> None:
    project_dir = Path(project_dir)
    info = json.loads((project_dir / "video_info.json").read_text(encoding="utf-8"))
    whisper = json.loads((project_dir / "raw" / "whisper_transcript.json").read_text(encoding="utf-8"))

    master_path = project_dir / "source_raw.mp4"
    proxy_path = project_dir / "source.mp4"
    if not master_path.exists():
        raise FileNotFoundError(f"нет мастер-файла {master_path} — пересобрать копию для редактора не из чего")

    need_proxy = remake_proxy or not proxy_path.exists()
    if not need_proxy:
        need_proxy = reencode_mod.probe_source(proxy_path)["height"] > reencode_mod.EDITOR_MAX_HEIGHT
    fps = reencode_mod.probe_source(master_path)["fps"]
    if need_proxy:
        print("Делаю копию для редактора (≤720p, all-intra) — это несколько минут...", flush=True)
        total_frames = reencode_mod.make_editing_proxy(master_path, proxy_path, fps=fps)
    else:
        total_frames = reencode_mod.count_frames(proxy_path)

    subtitle_path = _find_subtitles(project_dir)
    source_words = load_source_words(subtitle_path, transcript_path)
    if transcript_path:
        subtitle_source = "user_transcript"
    elif subtitle_path is None:
        subtitle_source = "none"
    elif _pick_subtitle_track(info.get("subtitles") or {}):
        subtitle_source = "youtube_manual"
    else:
        subtitle_source = "youtube_auto"

    video_info = VideoInfo(
        youtube_url=info.get("webpage_url", ""),
        video_id=info.get("id", project_dir.name),
        title=info.get("title", ""),
        fps=fps,
        total_frames=total_frames,
        source_file=proxy_path.name,
        master_file=master_path.name,
        subtitle_source=subtitle_source,
    )
    manifest_path = project_dir / "manifest.json"
    old = Manifest.load(manifest_path) if manifest_path.exists() else None
    # Настройки проекта (запас, порог тишины) переносятся из текущего манифеста.
    settings = old.settings if old else None
    # Фрагменты, вынесенные на этап 3, остаются как есть — пересобирается
    # только то, что после них.
    kept = [f for f in old.fragments if f.exported] if old else []
    start_frame = max((f.algo_end_frame for f in kept), default=0)
    numbers = [int(m.group(1)) for f in kept if (m := re.match(r"frag_(\d+)$", f.id))]
    first_id = max(numbers) + 1 if numbers else 0
    if kept:
        print(f"Вынесено на этап 3: {len(kept)} фрагментов — пересобираю с кадра {start_frame} "
              f"({start_frame / fps:.2f} с).", flush=True)
    manifest = assemble_manifest(
        whisper, source_words, fps, total_frames, video_info, settings,
        boundary_cache=project_dir / "raw" / "sat_boundary_probs.json",
        start_frame=start_frame, first_id=first_id,
        unvoiced=unvoiced_speakers(project_dir),
    )
    manifest.fragments = [*kept, *manifest.fragments]

    if manifest_path.exists():
        # Каждая пересборка сохраняет свою копию — старые копии не перезаписываются.
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        manifest_path.replace(project_dir / f"manifest.bak-{stamp}.json")
    manifest.save(manifest_path)
    build_waveform(proxy_path, project_dir / "waveform.bin", fps, total_frames)
    if not (project_dir / "audio.pcm").exists():
        print("Извлекаю звуковую дорожку для редактора...", flush=True)
        build_audio_track(master_path, project_dir / "audio.pcm")

    phrases = sum(1 for f in manifest.fragments if f.kind == "phrase")
    fillers = len(manifest.fragments) - phrases
    flagged = sum(1 for f in manifest.fragments if f.needs_review)
    print(f"Готово: {len(manifest.fragments)} фрагментов (фраз {phrases}, без слов {fillers}), "
          f"на проверку {flagged}; fps={fps}, кадров={total_frames}")


def main() -> None:
    # Консоль Windows по умолчанию в cp1251 — без этого падаем на любом символе вне её.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Пересобирает manifest.json из готовых артефактов проекта.")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--transcript", help="Текстовый транскрипт без таймкодов вместо субтитров YouTube")
    parser.add_argument("--remake-proxy", action="store_true", help="Принудительно пересоздать копию для редактора")
    args = parser.parse_args()
    rebuild(Path(args.project_dir), Path(args.transcript) if args.transcript else None, args.remake_proxy)


if __name__ == "__main__":
    main()
