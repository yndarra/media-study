# -*- coding: utf-8 -*-
"""
Оркестрация Фазы 1:
  скачивание (мастер в максимальном качестве) -> копия для редактора
  (≤720p, CFR, all-intra) -> ASR -> фразы -> пословная привязка текста
  источника -> manifest.json + waveform.bin + audio.pcm (звук для точного
  воспроизведения в редакторе).
"""
import json
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from common.audio_track import build_audio_track
from common.manifest_schema import DEFAULT_SETTINGS, Manifest, VideoInfo, validate_full_coverage
from common.waveform import build_waveform

from . import download as download_mod
from . import reencode as reencode_mod
from . import transcribe as transcribe_mod
from . import subtitles as subtitles_mod
from . import source_text as source_text_mod
from . import segment as segment_mod
from . import boundaries as boundaries_mod


def _extract_video_id(url: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname in ("youtu.be",):
        return parsed.path.lstrip("/")
    query = parse_qs(parsed.query)
    if "v" in query:
        return query["v"][0]
    return parsed.path.strip("/").replace("/", "_") or "video"


def load_source_words(subtitle_path: Path | None, transcript_path: Path | None) -> list[dict]:
    """Пользовательский транскрипт имеет приоритет над субтитрами YouTube."""
    if transcript_path is not None:
        return source_text_mod.words_from_transcript(transcript_path)
    if subtitle_path is not None and Path(subtitle_path).exists():
        return source_text_mod.words_from_cues(subtitles_mod.load_subtitle_cues(subtitle_path))
    return []


def assemble_manifest(
    whisper_transcript: dict,
    source_words: list[dict],
    fps: float,
    total_frames: int,
    video_info: VideoInfo,
    settings: dict | None = None,
    boundary_cache: Path | None = None,
    start_frame: int = 0,
    first_id: int = 0,
    unvoiced: set[str] | None = None,
) -> Manifest:
    """
    Общая часть сборки манифеста — для полного прогона и для пересборки.
    start_frame/first_id — собрать только хвост видео начиная с этого кадра
    (начало уже вынесено на этап 3), с номерами фрагментов начиная с first_id.
    unvoiced — говорящие, чьи реплики в видео не звучат (см. unvoiced_speakers).
    """
    settings = {**DEFAULT_SETTINGS, **(settings or {})}
    min_filler = settings["min_filler_seconds"]
    padding = settings["context_padding_seconds"]

    words = segment_mod.flatten_words(whisper_transcript)
    if source_words:
        # Лишний текст источника (чего в речи нет) — в сторону, до нарезки и сверки.
        source_words = source_text_mod.trim_extra_source(words, source_words, unvoiced)
    # Где резать речь на фразы — по смыслу (модель + пунктуация источника +
    # паузы), см. boundaries.py; boundary_cache — кэш предсказаний модели.
    phrases = boundaries_mod.segment_words(
        words, source_words, boundary_cache, hard_gap_seconds=min_filler, start_seconds=start_frame / fps,
    )
    raw_segments = segment_mod.merge_glitches(phrases, min_filler)
    entries = segment_mod.fill_full_coverage(raw_segments, fps, total_frames, min_filler, start_frame=start_frame)
    if source_words:
        source_text_mod.assign_source_words(entries, words, source_words, unvoiced)
        # Реплики разных говорящих — в разные фрагменты; фраза, оборванная на
        # запятой, — вместе со своим продолжением (см. reshape.py).
        from . import reshape

        entries = reshape.split_by_speakers(entries, words, fps, source_text_mod._join)
        entries = reshape.merge_comma_tails(entries, fps, reshape.proper_words(source_words))
        for entry in entries:
            entry.pop("_words", None)
    # Каждая строка карточки — законченная фраза: заглавная, знак конца,
    # парные кавычки (см. common/text_polish.py).
    from common.text_polish import polish_text

    for entry in entries:
        if entry.get("text", "").strip():
            entry["text"] = polish_text(entry["text"])
    fragments = segment_mod.build_fragments(entries, fps, total_frames, padding, first_id=first_id)
    if start_frame == 0:
        validate_full_coverage(fragments, total_frames)
    return Manifest(video=video_info, fragments=fragments, settings=settings)


def unvoiced_speakers(project_dir: Path) -> set[str]:
    """
    Говорящие без озвучки из project.json ("unvoiced_speakers": ["Rover"]):
    их реплики (выбор ответа в игре) не произносятся, поэтому не отбрасываются
    как лишний текст, хотя в речи им ничего не соответствует.
    """
    path = Path(project_dir) / "project.json"
    if not path.exists():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")).get("unvoiced_speakers", []))


def find_subtitles(project_dir: Path) -> Path | None:
    for candidate in sorted(Path(project_dir).glob("subtitles.*")):
        if candidate.suffix.lower() in (".json3", ".vtt"):
            return candidate
    return None


def process_project(project_dir: Path, transcript_path: Path | None = None) -> Manifest:
    """
    Этап 1, вторая половина — "обработать" уже добавленное видео (или аудио):
    копия для редактора, распознавание речи, сверка с источником текста,
    нарезка на фразы, звуковая волна и звук для редактора. Источник текста —
    transcript_path, иначе data/<id>/transcript.txt, если он есть, иначе
    субтитры, скачанные вместе с видео. Готовые шаги при повторном запуске
    не переделываются.
    """
    import json

    from common.progress import report

    from .acquire import master_path as find_master

    project_dir = Path(project_dir)
    raw_dir = project_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    master = find_master(project_dir)
    if master is None:
        raise FileNotFoundError(f"в {project_dir} нет мастер-файла source_raw.* — сначала добавьте видео")
    info_path = project_dir / "video_info.json"
    info = json.loads(info_path.read_text(encoding="utf-8")) if info_path.exists() else {}

    proxy_path = project_dir / "source.mp4"
    # Готовые шаги не переделываются — в статусе сразу следующий настоящий шаг
    # (а не "копия для редактора", пока считаются кадры готовой копии).
    if not proxy_path.exists():
        report(project_dir, "proxy", 0, force=True)
    elif not (raw_dir / "whisper_transcript.json").exists():
        report(project_dir, "transcribe", 0, force=True)
    else:
        report(project_dir, "segment", None, force=True)
    encoded = reencode_mod.ingest_source_video(master, proxy_path)
    fps, total_frames = encoded["fps"], encoded["total_frames"]

    if not (raw_dir / "whisper_transcript.json").exists():
        report(project_dir, "transcribe", 0, force=True)
    whisper_transcript = transcribe_mod.transcribe_and_save(proxy_path, raw_dir / "whisper_transcript.json")
    report(project_dir, "segment", None, force=True)
    if transcript_path is None and not (project_dir / "transcript.txt").exists():
        # Ссылки пользователя и/или агент поиска -> transcript.txt (sources/search_agent.py).
        from .sources.search_agent import build_transcript

        report(project_dir, "search", None, force=True)
        build_transcript(project_dir, whisper_transcript, log=lambda m: print(m, flush=True))
        report(project_dir, "segment", None, force=True)
    if transcript_path is None and (project_dir / "transcript.txt").exists():
        transcript_path = project_dir / "transcript.txt"
    subtitle_path = find_subtitles(project_dir)
    source_words = load_source_words(subtitle_path, transcript_path)
    if transcript_path:
        subtitle_source = "user_transcript"
    elif subtitle_path is None:
        subtitle_source = "none"
    else:
        subtitle_source = "youtube_manual" if download_mod._pick_subtitle_track(info.get("subtitles") or {}) else "youtube_auto"

    video_info = VideoInfo(
        youtube_url=info.get("webpage_url", ""),
        video_id=info.get("id") or project_dir.name,
        title=info.get("title", project_dir.name),
        fps=fps,
        total_frames=total_frames,
        source_file=proxy_path.name,
        master_file=master.name,
        subtitle_source=subtitle_source,
    )
    from webapp.library import app_settings, project_settings

    manifest = assemble_manifest(
        whisper_transcript, source_words, fps, total_frames, video_info,
        settings={"context_padding_seconds": app_settings(project_dir.parent)["context_padding_seconds"]},
        boundary_cache=raw_dir / "sat_boundary_probs.json",
        unvoiced=unvoiced_speakers(project_dir),
    )
    # Фрагменты "на слух" (реплики не нашлось в источнике) – ИИ-доводка имён,
    # терминов и ошибок распознавания по контексту (ai_fix.py). Только когда
    # включён агент (это платный запрос, как и поиск).
    if project_settings(project_dir).get("agent") in ("search", "deep"):
        from .ai_fix import fix_unmatched

        report(project_dir, "ai_fix", None, force=True)
        fix_unmatched(project_dir, manifest, log=lambda m: print(m, flush=True))
        report(project_dir, "segment", None, force=True)
    # Флажок "Без пустых фрагментов" (окно видео в "Обработке"): фрагменты без
    # текста — музыка, шумы, звуки природы — в нарезку не попадают.
    if project_settings(project_dir).get("no_gaps"):
        before = len(manifest.fragments)
        manifest.fragments = [f for f in manifest.fragments if f.text.strip()]
        print(f"Без пустых фрагментов: убрано {before - len(manifest.fragments)}", flush=True)
    report(project_dir, "assets", None, force=True)
    build_waveform(proxy_path, project_dir / "waveform.bin", fps, total_frames)
    build_audio_track(master, project_dir / "audio.pcm")
    # Конец фразы на стыках без паузы – по звуку (end_refine.py): whisper
    # обрезает последнее слово, граница выходила левее нужного.
    from .end_refine import refine_touching_ends
    from .segment import flatten_words

    refine_touching_ends(manifest, project_dir / "audio.pcm",
                         {w["id"]: w for w in flatten_words(whisper_transcript) if w.get("id")},
                         log=lambda m: print(m, flush=True))
    # manifest.json — последним: по нему библиотека считает видео готовым.
    manifest.save(project_dir / "manifest.json")
    report(project_dir, "done", 100, force=True)
    return manifest


def build_project(url: str, project_dir: Path, transcript_path: Path | None = None) -> Manifest:
    """Добавить по ссылке и сразу обработать (если мастер уже скачан — скачивание пропускается)."""
    from .acquire import acquire_url, master_path

    project_dir = Path(project_dir)
    if master_path(project_dir) is None or not (project_dir / "video_info.json").exists():
        acquire_url(url, project_dir)
    return process_project(project_dir, transcript_path)
