# -*- coding: utf-8 -*-
"""
Наборы от сообщества: готовая разметка видео без самого видео.

Кто выверил видео (границы фраз, текст, говорящие, перевод), выгружает
набор – один файл .mspack.json. Другой пользователь добавляет то же видео
(по ссылке из набора – само; свой файл – вручную) и применяет набор:
распознавание речи и нарезка не нужны, фрагменты, тексты и переводы
берутся из набора, можно сразу передавать в Anki. Видео и звук в наборе
не лежат – только тайминги и тексты (юридически чисто, файл маленький).

Что внутри набора (format = "media-study-pack", version = 1):
  media     – откуда видео (ссылка, id), длительность, частота кадров и
              огибающая громкости по кадрам (waveform.bin, base64) – по ней
              у получателя находится сдвиг, если его копия начинается чуть
              раньше/позже (другая заливка, свой файл);
  project   – название, автор (группа), ссылки на источники текста;
  fragments – живые фрагменты по порядку: начало/конец (секунды), текст
              с говорящими ("Имя: реплика"), "не озвучено"; промежутки между
              ними у получателя – удалённые фрагменты;
  reviewed  – сколько секунд видео выверено (дальше – как вышло у автора
              без проверки), full – выверено всё;
  translations – перевод (оборот карточки) по номеру фрагмента в наборе;
  glossary  – словарь группы (имена и термины для перевода и распознавания).
"""
from __future__ import annotations

import base64
import json
from datetime import datetime
from pathlib import Path

FORMAT = "media-study-pack"
VERSION = 1
MAX_SHIFT_SECONDS = 20.0  # насколько копии видео могут разойтись по началу


# ---------------------------------------------------------------- выгрузка
def export_pack(project_dir: Path, log=print) -> tuple[dict, list[str]]:
    """Набор из выверенного видео. Возвращает (набор, предупреждения)."""
    from media_study.core.manifest import Manifest, STATUS_ACTIVE
    from media_study.web.library import group_of, last_touched_index, project_settings, title_of, video_info

    project_dir = Path(project_dir)
    manifest = Manifest.load(project_dir / "manifest.json")
    fps = manifest.video.fps
    info = video_info(project_dir)
    settings = project_settings(project_dir)
    warnings: list[str] = []

    live = [(i, f) for i, f in enumerate(manifest.fragments) if f.status == STATUS_ACTIVE]
    reviewed_index = last_touched_index(manifest)
    full = bool(manifest.settings.get("finished")) or reviewed_index >= len(manifest.fragments) - 1
    reviewed_seconds = (manifest.fragments[reviewed_index].algo_end_frame / fps) if reviewed_index >= 0 else 0.0

    translations = _collect_translations(project_dir, [f for _, f in live], warnings)
    fragments = []
    for k, (_, f) in enumerate(live):
        item = {"start": round(f.algo_start_frame / fps, 4), "end": round(f.algo_end_frame / fps, 4), "text": f.text}
        if f.unvoiced:
            item["unvoiced"] = True
        fragments.append(item)
    pack_translations = {str(k): translations[f.id] for k, (_, f) in enumerate(live) if f.id in translations}

    envelope = ""
    wave = project_dir / "waveform.bin"
    if wave.exists():
        envelope = base64.b64encode(wave.read_bytes()).decode("ascii")
    group = group_of(project_dir)
    glossary = {}
    gpath = project_dir.parent / "glossary" / f"{group}.json"
    if gpath.exists():
        try:
            glossary = json.loads(gpath.read_text(encoding="utf-8"))
        except ValueError:
            pass
    pack = {
        "format": FORMAT,
        "version": VERSION,
        "created": datetime.now().isoformat(timespec="seconds"),
        "media": {
            "kind": "audio" if info.get("audio_only") else "video",
            "source_url": manifest.video.youtube_url or info.get("webpage_url", ""),
            "media_id": info.get("id") or manifest.video.video_id,
            "original_title": info.get("title") or manifest.video.title,
            "duration": round(manifest.video.total_frames / fps, 3),
            "fps": fps,
            "total_frames": manifest.video.total_frames,
            "envelope": envelope,
        },
        "project": {"title": title_of(project_dir), "group": group, "sources": settings.get("sources") or []},
        "reviewed": {"full": full, "seconds": round(reviewed_seconds, 3)},
        "fragments": fragments,
        "translations": pack_translations,
        "glossary": glossary,
    }
    log(f"Набор: {len(fragments)} фрагментов, переводов {len(pack_translations)}, выверено "
        + ("всё" if full else f"{round(reviewed_seconds / 60, 1)} мин"))
    return pack, warnings


def _collect_translations(project_dir: Path, fragments, warnings: list[str]) -> dict:
    """Перевод по id фрагмента: из Anki (переданные) и из export/translations.json (ещё нет)."""
    from media_study.export import anki
    from media_study.export.worker import read_json

    result = {}
    stored = read_json(project_dir / "export" / "translations.json", {})
    for f in fragments:
        entry = stored.get(f.id)
        if entry and entry.get("back") and (entry.get("text") or "").strip() == f.text.strip():
            result[f.id] = entry["back"]
    index = {e["fragment_id"]: e["anki_note_id"] for e in read_json(project_dir / "export" / "index.json", [])
             if e.get("anki_note_id")}
    wanted = [f for f in fragments if f.id in index and f.id not in result]
    if not wanted:
        return result
    try:
        notes = {n["noteId"]: n for n in anki.invoke("notesInfo", notes=[index[f.id] for f in wanted])}
    except anki.AnkiUnavailable:
        warnings.append(f"Anki закрыт – переводы {len(wanted)} уже переданных карточек в набор не попали (откройте Anki и выгрузите снова)")
        return result
    for f in wanted:
        note = notes.get(index[f.id])
        if not note:
            continue
        back, _ = anki.unmark(note["fields"].get(anki.BACK_FIELD, {}).get("value", ""))
        if back.strip():
            result[f.id] = back
    return result


def pack_filename(pack: dict) -> str:
    title = pack.get("project", {}).get("title") or pack.get("media", {}).get("media_id") or "pack"
    safe = "".join(ch for ch in title if ch not in '\\/:*?"<>|').strip() or "pack"
    return f"{safe}.mspack.json"


# ---------------------------------------------------------------- проверка
def validate(pack: dict) -> None:
    if not isinstance(pack, dict) or pack.get("format") != FORMAT:
        raise ValueError("это не набор media-study")
    if int(pack.get("version", 0)) > VERSION:
        raise ValueError("набор сделан более новой версией приложения – обновите приложение")
    if not pack.get("fragments"):
        raise ValueError("в наборе нет фрагментов")


# ---------------------------------------------------------------- сдвиг копий
def find_shift(pack_envelope: bytes, pack_fps: float, own_envelope: bytes, own_fps: float) -> float:
    """
    На сколько секунд своя копия сдвинута относительно копии автора набора
    (положительное – у себя всё позже). По огибающим громкости: перебор сдвига
    в пределах MAX_SHIFT_SECONDS, лучшая корреляция. Огибающих нет – 0.
    """
    import numpy as np

    if not pack_envelope or not own_envelope:
        return 0.0
    step = 0.1  # с – общий шаг сетки (частоты кадров у копий могут отличаться)

    def grid(env: bytes, fps: float) -> np.ndarray:
        a = np.frombuffer(env, dtype=np.uint8).astype(np.float32)
        t = np.arange(0, len(a) / fps, step)
        idx = np.minimum((t * fps).astype(int), len(a) - 1)
        g = a[idx]
        return (g - g.mean()) / (g.std() + 1e-6)

    a, b = grid(pack_envelope, pack_fps), grid(own_envelope, own_fps)
    n = min(len(a), len(b))
    max_lag = int(MAX_SHIFT_SECONDS / step)
    best, best_lag = -1e9, 0
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            x, y = a[: n - lag], b[lag:n]
        else:
            x, y = a[-lag:n], b[: n + lag]
        if len(x) < 50:
            continue
        score = float(np.dot(x, y) / len(x))
        if score > best:
            best, best_lag = score, lag
    return best_lag * step


# ---------------------------------------------------------------- применение
def build_manifest_from_pack(project_dir: Path, pack: dict, video_info, padding_seconds: float, log=print):
    """
    Манифест по набору (вместо распознавания и нарезки). video_info – своей
    копии (fps, кадры). Промежутки между фрагментами набора – удалённые
    фрагменты; выверенная часть – как просмотренная в редакторе.
    """
    from media_study.core.manifest import DEFAULT_SETTINGS, Manifest, STATUS_DELETED
    from media_study.ingest.segment import build_fragments

    validate(pack)
    project_dir = Path(project_dir)
    fps, total = video_info.fps, video_info.total_frames
    media = pack.get("media", {})
    own_wave = project_dir / "waveform.bin"
    shift = find_shift(base64.b64decode(media.get("envelope") or ""), float(media.get("fps") or fps),
                       own_wave.read_bytes() if own_wave.exists() else b"", fps)
    if abs(shift) >= 0.05:
        log(f"Набор: своя копия сдвинута на {shift:+.1f} с – тайминги поправлены")

    def frame(seconds: float) -> int:
        return max(0, min(total, round((seconds + shift) * fps)))

    entries, kinds = [], []
    cursor = 0
    for item in pack["fragments"]:
        start, end = frame(float(item["start"])), frame(float(item["end"]))
        if end <= start:
            continue  # за пределами своей копии (после сдвига)
        if start > cursor:
            entries.append({"start_frame": cursor, "end_frame": start, "text": ""})
            kinds.append(None)
        # Наложения (автор расширил границу на пару кадров) – как у автора.
        entries.append({"start_frame": start, "end_frame": end, "text": item.get("text", "")})
        kinds.append(item)
        cursor = max(cursor, end)
    if cursor < total:
        entries.append({"start_frame": cursor, "end_frame": total, "text": ""})
        kinds.append(None)
    fragments = build_fragments(entries, fps, total, padding_seconds)
    for fragment, item in zip(fragments, kinds):
        if item is None:
            fragment.status = STATUS_DELETED  # промежуток – удалён у автора набора
        elif item.get("unvoiced"):
            fragment.unvoiced = True
    settings = {**DEFAULT_SETTINGS, "context_padding_seconds": padding_seconds}
    reviewed = pack.get("reviewed") or {}
    if reviewed.get("full"):
        settings["finished"] = True
    else:
        until = frame(float(reviewed.get("seconds") or 0))
        done = [i for i, f in enumerate(fragments) if f.algo_end_frame <= until]
        if done:
            settings["reviewed_through"] = done[-1]
    settings["pack"] = {"created": pack.get("created", ""), "fragments": len(pack["fragments"]), "shift": round(shift, 2)}
    manifest = Manifest(video=video_info, fragments=fragments, settings=settings)
    _apply_side_data(project_dir, pack, fragments, kinds)
    live = sum(1 for k in kinds if k is not None)
    log(f"Набор применён: {live} фрагментов" + (f", переводов {len(pack.get('translations') or {})}" if pack.get("translations") else ""))
    return manifest


def _apply_side_data(project_dir: Path, pack: dict, fragments, kinds) -> None:
    """Переводы – в export/translations.json, словарь – в словарь группы, название/автор/источники – в project.json."""
    from media_study.web.library import project_settings, save_project_settings

    # Переводы: номер фрагмента в наборе -> id фрагмента здесь.
    translations = pack.get("translations") or {}
    if translations:
        out_dir = project_dir / "export"
        out_dir.mkdir(exist_ok=True)
        path = out_dir / "translations.json"
        stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        k = -1
        now = datetime.now().isoformat(timespec="seconds")
        for fragment, item in zip(fragments, kinds):
            if item is None:
                continue
            k += 1
            back = translations.get(str(k))
            if back:
                stored[fragment.id] = {"text": fragment.text, "back": back, "model": "pack", "created": now}
        path.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    project = pack.get("project") or {}
    settings = project_settings(project_dir)
    for key in ("title", "group"):
        if project.get(key) and not settings.get(key):
            settings[key] = project[key]
    if project.get("sources") and not settings.get("sources"):
        settings["sources"] = project["sources"]
    save_project_settings(project_dir, settings)
    # Словарь группы: недостающие имена и термины.
    glossary = pack.get("glossary") or {}
    if glossary and isinstance(glossary, dict):
        group = settings.get("group") or project.get("group")
        if group:
            gdir = project_dir.parent / "glossary"
            gdir.mkdir(exist_ok=True)
            gpath = gdir / f"{group}.json"
            current = json.loads(gpath.read_text(encoding="utf-8")) if gpath.exists() else {}
            for key, value in glossary.items():
                current.setdefault(key, value)
            gpath.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
