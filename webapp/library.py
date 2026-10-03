# -*- coding: utf-8 -*-
"""
Библиотека видео для веб-приложения: какие видео есть в data/, их прогресс
и статистика.

Каждое видео — папка data/<код видео>. Пока этап 1 не закончен, в ней нет
manifest.json — такое видео показывается как "обрабатывается" (со строкой из
журнала этапа 1, если он запущен из приложения).

У видео два прогресса:
  - основной — сколько фрагментов передано на этап 3 (в Anki); фрагменты,
    вернувшиеся из Anki на доработку, в него снова не входят;
  - скрытый — последний фрагмент, в котором что-то изменили или удалили
    (просто просмотр не считается). Редактор открывается сразу на нём,
    чтобы не искать место, где остановились. Он всегда не меньше основного:
    переданное в Anki считается отредактированным.

"Автор" (группа в библиотеке и часть пути колоды Anki) — по умолчанию канал
YouTube, его можно переименовать; хранится в data/<id>/project.json, чтобы
его можно было задать ещё до окончания этапа 1.
"""
from pathlib import Path
import json
import statistics

from common.manifest_schema import Manifest, STATUS_ACTIVE


def read_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def project_settings(project_dir: Path) -> dict:
    return read_json(Path(project_dir) / "project.json", {})


def save_project_settings(project_dir: Path, settings: dict) -> None:
    path = Path(project_dir) / "project.json"
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    # С повторами: сервер в это время читает project.json (список видео раз в
    # 3 с), и Windows не давал его заменить – перевод падал с WinError 5.
    from common.manifest_schema import replace_file

    replace_file(tmp_path, path)


def add_cost(project_dir: Path, kind: str, amount: float) -> None:
    """
    Учесть расход OpenRouter по видео (project.json, "costs"): kind — "search"
    (поиск источников), "translate" (перевод), "retranslate" (повторный перевод
    по флагу). Показывается в окне видео ("Потрачено").
    """
    if not amount:
        return
    settings = project_settings(project_dir)
    costs = settings.setdefault("costs", {})
    costs[kind] = round(costs.get(kind, 0.0) + float(amount), 6)
    save_project_settings(project_dir, settings)


def video_info(project_dir: Path) -> dict:
    return read_json(Path(project_dir) / "video_info.json", {})


def group_of(project_dir: Path) -> str:
    """Автор видео: заданный вручную, иначе канал YouTube."""
    info = video_info(project_dir)
    return project_settings(project_dir).get("group") or info.get("channel") or info.get("uploader") or "Без автора"


def agent_mode(value) -> str:
    """
    Режим помощи агента: "", "deep" или "search" (старое True — "search").
    Не задан вовсе (None) — по умолчанию "search"; "" — пользователь выключил.
    """
    if value is True or value is None:
        return "search"
    return value if value in ("deep", "search") else ""


def sources_display(project_dir: Path) -> list[dict]:
    """
    Источники текста для сверки (окно видео): сначала те, по которым сверялся
    текст, потом найденные агентом, но не использованные; если агент не
    запускался — прикреплённые пользователем ссылки.
    """
    settings = project_settings(project_dir)
    found = settings.get("found_sources") or []
    if found:
        return sorted(({"url": f["url"], "title": f.get("title", ""), "used": bool(f.get("used"))} for f in found),
                      key=lambda f: not f["used"])
    attached = [{"url": url, "title": "", "used": True} for url in settings.get("sources", []) if url]
    if attached:
        return attached
    # Текст сверялся с субтитрами YouTube (ссылки и агента не было).
    manifest_path = Path(project_dir) / "manifest.json"
    if manifest_path.exists():
        kind = Manifest.load(manifest_path).video.subtitle_source or ""
        url = video_info(project_dir).get("webpage_url") or ""
        if kind.startswith("youtube") and url:
            title = "Субтитры YouTube" + (" (ручные)" if kind == "youtube_manual" else " (автоматические)")
            return [{"url": url, "title": title, "used": True}]
    return []


def title_of(project_dir: Path) -> str:
    """Название видео: заданное вручную, иначе с YouTube / имя файла."""
    info = video_info(project_dir)
    return project_settings(project_dir).get("title") or info.get("title") or Path(project_dir).name


def is_edited(fragment) -> bool:
    """Фрагмент изменён пользователем: границы, текст, запас, объединение/разделение."""
    return fragment.edited or fragment.context_custom or bool(fragment.merged_from or fragment.split_from)


def disk_usage(project_dir: Path) -> dict:
    """
    Сколько места занимает видео по этапам (байты):
    master — скачанный оригинал (из него режутся клипы для Anki, поэтому он
    остаётся); editor — копия для редактора (этап 2); editor_audio — звук и
    волна для редактора; clips — клипы этапа 3; total — всё вместе.
    """
    project_dir = Path(project_dir)

    def size(paths) -> int:
        return sum(p.stat().st_size for p in paths if p.is_file())

    from phase1_ingest.acquire import master_path

    master = master_path(project_dir)
    usage = {
        "master": size([master]) if master else 0,
        "editor": size([project_dir / "source.mp4"]),
        "editor_audio": size([project_dir / "audio.pcm", project_dir / "waveform.bin"]),
        "clips": size((project_dir / "export").glob("*")) if (project_dir / "export").is_dir() else 0,
    }
    usage["total"] = size(project_dir.rglob("*"))
    return usage


def is_touched(fragment) -> bool:
    """Фрагмент хоть как-то изменён (для скрытого прогресса)."""
    return (
        fragment.exported
        or fragment.status != STATUS_ACTIVE
        or fragment.edited
        or fragment.context_custom
        or bool(fragment.merged_from or fragment.split_from)
    )


def last_touched_index(manifest: Manifest) -> int:
    """
    Индекс последнего изменённого фрагмента (-1 — ничего не меняли). После
    кнопки "Финиш" в редакторе (settings.finished) просмотрено всё видео.
    """
    if manifest.settings.get("finished") and manifest.fragments:
        return len(manifest.fragments) - 1
    return max((i for i, f in enumerate(manifest.fragments) if is_touched(f)), default=-1)


def export_index(project_dir: Path) -> list[dict]:
    return read_json(Path(project_dir) / "export" / "index.json", [])


# Этап 1 считается идущим, пока его файл состояния обновлялся недавно; иначе
# он прерван (окно закрыли, компьютер выключили) и его можно запустить снова.
PHASE1_STALE_SECONDS = 600

# Общие настройки приложения (страница "Настройки") — data/settings.json.
DEFAULT_APP_SETTINGS = {
    "anki_deck_root": "Claude::2. VIDEOS",  # колода Anki: <корень>::<автор>::<видео>
    # Для аудио (песни и т.п.) – своя корневая колода: <корень>::<исполнитель>::<название>.
    "anki_deck_root_audio": "Claude::1. SONGS",
    # Куда класть новые аудио ("" – как видео: new_video_storage / основное).
    "new_audio_storage": "",
    # Запас до и после отрезка по умолчанию — для всех видео (кроме уже
    # просмотренных фрагментов — до скрытой метки).
    "context_padding_seconds": 3.0,
    # Качество скачивания по ссылке: высота кадра не больше (0 — лучшее доступное).
    "download_max_height": 1440,
    "auto_process": False,  # обрабатывать видео сразу после добавления
    # Производительность: сколько ядер процессора обработка оставляет свободными
    # и пониженный приоритет фоновых процессов (см. common/resources.py).
    "reserve_cpu_cores": 2,
    "low_priority": True,
    # Дополнительные хранилища видео (папки на других дисках, см. storage.py)
    # и куда класть новые видео ("" – в основное, data/).
    "storages": [],
    "new_video_storage": "",
    # Режимы редактора при открытии (кнопки в редакторе меняют их до перезагрузки):
    # автозапуск, остановка на конце отрезка, соседние фразы без удалённых.
    "default_auto_play": True,
    "default_stop_at_end": True,
    "default_skip_deleted": True,
    # Связанные границы (граница двигает и соседнюю): видео – выкл, аудио – вкл.
    "default_link_video": False,
    # Распознавание речи: "whisper" (локально) или "elevenlabs" (Scribe по API,
    # см. phase1_ingest/transcribe_elevenlabs.py); ключ – data/elevenlabs_key.txt.
    "asr_engine": "whisper",
    "elevenlabs_model": "scribe_v2",
    "elevenlabs_language": "en",  # пусто – язык определяется сам
    "elevenlabs_keyterms": True,  # подсказывать имена/термины из словаря (+20% к цене)
    "elevenlabs_proxy": "",  # http://… или socks5://… – если ElevenLabs недоступен напрямую
    "default_link_audio": True,
    # Агент перевода (карточки с флагом "перевод"): модель OpenRouter и файл с ключом.
    "openrouter_model": "google/gemini-3.8-flash",
    # Модель агента поиска источников (с веб-поиском OpenRouter).
    "search_model": "anthropic/claude-sonnet-5.5",
    "openrouter_key_file": "",
    # Запасной ключ: когда на основном кончатся деньги (OpenRouter отвечает 402),
    # запросы переходят на него, и он становится основным.
    "openrouter_key_file_next": "",
}


def app_settings(data_dir: Path) -> dict:
    return {**DEFAULT_APP_SETTINGS, **read_json(Path(data_dir) / "settings.json", {})}


def save_app_settings(data_dir: Path, settings: dict) -> dict:
    merged = {**app_settings(data_dir), **{k: v for k, v in settings.items() if k in DEFAULT_APP_SETTINGS}}
    path = Path(data_dir) / "settings.json"
    path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    return merged


def phase1_running(project_dir: Path) -> bool:
    import time

    status = read_json(Path(project_dir) / "phase1_status.json", None)
    if not status or status.get("step") in ("done", "downloaded", "failed"):
        return False
    return time.time() - status.get("updated", 0) < PHASE1_STALE_SECONDS


def phase1_status(project_dir: Path) -> dict:
    """
    Ход этапа 1: {"label", "percent"} из phase1_status.json. Для этапа 1,
    запущенного до появления этого файла, — по тому, какие файлы уже есть.
    """
    project_dir = Path(project_dir)
    status = read_json(project_dir / "phase1_status.json", None)
    if status:
        # Подпись шага — по его коду (файлы, записанные раньше, могли быть со строчной буквы).
        from common.progress import STEPS

        label = (status.get("label") if status.get("step") == "failed" else None) or \
            STEPS.get(status.get("step"), status.get("label") or "Обрабатывается")
        return {"label": label[:1].upper() + label[1:], "percent": status.get("percent"), "step": status.get("step")}
    if (project_dir / "source.tmp.mp4").exists():
        size = (project_dir / "source.tmp.mp4").stat().st_size / 2**30
        return {"label": f"Делаю копию для редактора (записано {size:.1f} ГБ)", "percent": None}
    if (project_dir / "source.mp4").exists() and not (project_dir / "raw" / "whisper_transcript.json").exists():
        return {"label": "Распознаю речь", "percent": None}
    if (project_dir / "raw" / "whisper_transcript.json").exists():
        return {"label": "Режу на фразы", "percent": None}
    return {"label": "Скачиваю видео", "percent": None}


def summary(project_dir: Path) -> dict:
    project_dir = Path(project_dir)
    info = video_info(project_dir)
    base = {
        "id": project_dir.name,
        "title": title_of(project_dir),
        "group": group_of(project_dir),
        "duration": info.get("duration"),
        # Аудио без видео – свой раздел "Аудио" и свой вид редактора.
        "audio_only": bool(info.get("audio_only")),
    }
    manifest_path = project_dir / "manifest.json"
    if not manifest_path.exists():
        progress = phase1_status(project_dir)
        settings = project_settings(project_dir)
        # "добавлено" — мастер есть, обработка не идёт (ещё не запускали или прервана).
        from phase1_ingest.acquire import master_path

        added = master_path(project_dir) is not None and not phase1_running(project_dir)
        # Что сделает "Обработать" (готовые шаги не переделываются). Пока речь
        # не распознана – просто "Обработать" (готовая копия для редактора –
        # внутренняя подробность, "Обработать речь" только путало).
        if master_path(project_dir) is None:
            next_step = "Докачать и обработать"
        elif not (project_dir / "raw" / "whisper_transcript.json").exists():
            next_step = "Обработать"
        else:
            next_step = "Нарезать на фразы"
        failed = (progress.get("step") == "failed") and not phase1_running(project_dir)
        return {
            **base,
            "state": "failed" if failed else "added" if added else "processing",
            "next_step": next_step,
            "status": progress["label"] if (failed or not added) else "Добавлено, ждёт обработки",
            "percent": progress["percent"] if not (added or failed) else None,
            "step": progress.get("step") if not added else None,
            "sources": settings.get("sources", []),
            "agent": agent_mode(settings.get("agent")),
            "no_gaps": bool(settings.get("no_gaps")),
            "audio_only": bool(info.get("audio_only")),
        }
    manifest = Manifest.load(manifest_path)
    fragments = manifest.fragments
    index = export_index(project_dir)
    with_note = {e["fragment_id"] for e in index if e.get("anki_note_id")}
    active = [f for f in fragments if f.status == STATUS_ACTIVE]
    cards = [f for f in active if f.text.strip()]
    # Скрытая метка: всё до последнего изменённого фрагмента просмотрено
    # пользователем ("отредактировано").
    reviewed = last_touched_index(manifest) + 1
    returned = [f for f in active if f.anki_flagged and not f.exported]  # вернулись из Anki на правку
    head = fragments[:reviewed]
    # Полоса "Отредактировано" (слева направо), до скрытой метки: принято без
    # правок, изменено, удалено; остальное — ещё не тронуто. Передано ли в
    # Anki — не важно (это видно на полосе "Передано в Anki").
    # Удалён пользователем (а не исходник объединения/разделения — те
    # заменены своим результатом и в полосе не считаются).
    removed = lambda f: f.status != STATUS_ACTIVE and not f.absorbed_into and not f.split_into
    # Не озвученные (бирюзовые) — после синих, перед жёлтыми; изменённые —
    # жёлтые, даже если не озвучены.
    edit_bar = {
        "accepted": sum(f.status == STATUS_ACTIVE and not is_edited(f) and not f.is_unvoiced for f in head),
        "unvoiced": sum(f.status == STATUS_ACTIVE and not is_edited(f) and f.is_unvoiced for f in head),
        "changed": sum(f.status == STATUS_ACTIVE and is_edited(f) for f in head),
        "deleted": sum(removed(f) for f in head),
    }
    return {
        **base,
        "state": "ready",
        "fragments_total": len(fragments),
        "active_total": len(active),
        "exported": sum(f.exported for f in active),
        # Уже в Anki по факту (карточка создана); exported − in_anki — ещё в очереди.
        "in_anki": sum(1 for f in active if f.exported and f.id in with_note),
        "editable": sum(not f.exported for f in fragments),
        # Отредактированы (до скрытой метки) и ещё не переданы в Anki – их
        # передаст кнопка "Передать в Anki".
        "sendable": sum(1 for f in head if f.status == STATUS_ACTIVE and not f.exported),
        "last_touched": reviewed,
        "reviewed": reviewed,
        "edit_bar": edit_bar,
        # Ждут правки: ещё не просмотренные + вернувшиеся из Anki.
        "awaiting": sum(f.status == STATUS_ACTIVE for f in fragments[reviewed:]) + sum(
            1 for f in returned if fragments.index(f) < reviewed),
        "deleted_total": sum(removed(f) for f in fragments),
        # Всего в полосе "Отредактировано": живые + удалённые пользователем.
        "bar_total": len(active) + sum(removed(f) for f in fragments),
        "cards_total": len(cards),
        # Переведены заранее и ждут передачи в Anki (перевод лежит в хранилище, текст не менялся).
        "translated_waiting": _translated_waiting(project_dir, cards),
        "clips_done": len(index),
        "notes_in_anki": sum(bool(e.get("anki_note_id")) for e in index),
        "flagged": len(returned),
        "anki_deck": manifest.settings.get("anki_deck"),
        "sources_display": sources_display(project_dir),
    }


def _translated_waiting(project_dir: Path, cards) -> int:
    """Сколько ещё не переданных в Anki фрагментов уже переведено (export/translations.json)."""
    path = Path(project_dir) / "export" / "translations.json"
    if not path.exists():
        return 0
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    return sum(1 for f in cards if not f.exported and f.id in stored
               and stored[f.id].get("text", "").strip() == f.text.strip())


def list_projects(data_dir: Path) -> list[dict]:
    """Все видео в data/ (папки с данными видео), новые — первыми."""
    result = []
    for project_dir in Path(data_dir).iterdir():
        # Видео, которое ещё скачивается, тоже в списке (по файлу хода этапа 1):
        # video_info.json появляется только после скачивания.
        markers = ("manifest.json", "video_info.json", "phase1_status.json")
        if not project_dir.is_dir() or not any((project_dir / name).exists() for name in markers):
            continue
        item = summary(project_dir)
        item["_mtime"] = project_dir.stat().st_ctime
        result.append(item)
    result.sort(key=lambda item: -item.pop("_mtime"))
    return result


def stats(project_dir: Path) -> dict:
    """Подробная статистика видео (страница видео в библиотеке)."""
    project_dir = Path(project_dir)
    manifest = Manifest.load(project_dir / "manifest.json")
    fps = manifest.video.fps
    total = manifest.video.total_frames / fps
    fragments = manifest.fragments
    cards = [f for f in fragments if f.status == STATUS_ACTIVE and f.text.strip()]
    durations = [(f.algo_end_frame - f.algo_start_frame) / fps for f in cards]
    kept = sum(durations)
    words = [len(f.text.split()) for f in cards]
    deleted = [f for f in fragments if f.status != STATUS_ACTIVE]
    text_edited = sum(f.text != f.original_text for f in cards)
    bounds_edited = [f for f in cards if f.algo_start_frame != f.original_algo_start_frame or f.algo_end_frame != f.original_algo_end_frame]
    shifts = [abs(f.algo_start_frame - f.original_algo_start_frame) for f in bounds_edited if f.algo_start_frame != f.original_algo_start_frame]
    shifts += [abs(f.algo_end_frame - f.original_algo_end_frame) for f in bounds_edited if f.algo_end_frame != f.original_algo_end_frame]
    lines: dict[int, int] = {}
    for f in cards:
        n = len(f.text.split("\n"))
        lines[n] = lines.get(n, 0) + 1
    index = export_index(project_dir)
    sizes = [e["size_bytes"] if "size_bytes" in e else (project_dir / "export" / e["clip"]).stat().st_size
             for e in index if (project_dir / "export" / e["clip"]).exists()]
    exported_seconds = sum(e["frames"] / fps for e in index)

    def spread(values, digits=2):
        if not values:
            return None
        return {
            "mean": round(statistics.mean(values), digits), "median": round(statistics.median(values), digits),
            "min": round(min(values), digits), "max": round(max(values), digits),
        }

    return {
        "video_seconds": round(total, 1),
        # Потрачено на OpenRouter по этому видео ($): поиск, перевод, повторный перевод.
        "costs": project_settings(project_dir).get("costs", {}),
        "fragments_total": len(fragments),
        "cards": len(cards),
        "kept_seconds": round(kept, 1),
        "kept_share": round(kept / total, 4) if total else 0,
        "deleted": len(deleted),
        "deleted_seconds": round(sum((f.algo_end_frame - f.algo_start_frame) / fps for f in deleted), 1),
        "clip_seconds": spread(durations),
        "words_total": sum(words),
        "words_per_card": spread(words, 1),
        "words_per_minute": round(sum(words) / kept * 60) if kept else 0,
        "lines_per_card": dict(sorted(lines.items())),
        "text_edited": text_edited,
        "bounds_edited": len(bounds_edited),
        "bound_shift_frames": spread(shifts, 1),
        "needs_review": sum(f.needs_review for f in cards),
        "clips": len(index),
        "clip_megabytes": spread([s / 2**20 for s in sizes], 1),
        "clips_megabytes_total": round(sum(sizes) / 2**20, 1),
        "megabytes_per_second": round(sum(sizes) / 2**20 / exported_seconds, 2) if exported_seconds else None,
    }
