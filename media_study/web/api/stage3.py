# -*- coding: utf-8 -*-
"""Этап 3: фоновая очередь клипов и карточек Anki, флаги и кэш чисел из Anki.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import subprocess
import sys
import time

from fastapi import HTTPException
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, Project, REPO_DIR, _public, app, project
from .ingest import _priority_flag


# -- этап 3: очередь Anki -----------------------------------------------------------
#
# Кнопка "Anki" в редакторе помечает фрагменты exported (дальше только
# просмотр), а обработку (клипы + карточки) делает отдельный процесс
# media_study.export.worker — он переживает перезапуск редактора и обслуживает
# все видео по очереди.


def _spawn_worker() -> None:
    """Запускает фоновую очередь (второй экземпляр сам завершится, если первый уже работает)."""
    log = open(DATA_DIR / "stage3_worker.log", "a", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, "-m", "media_study.export.worker", "--data-dir", str(DATA_DIR)],
        cwd=str(REPO_DIR),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | _priority_flag(),
        close_fds=True,
    )


_stage3_cache: dict[str, tuple[float, dict]] = {}


def _stage3_status(p: Project, fresh: bool = False) -> dict:
    """Состояние очереди видео; отметка вкладки приходит раз в секунду, поэтому
    результат переиспользуется до 2 секунд."""
    now = time.monotonic()
    cached = _stage3_cache.get(p.id)
    if fresh or cached is None or now - cached[0] > 2.0:
        cached = (now, _compute_stage3_status(p))
        _stage3_cache[p.id] = cached
    return cached[1]


def _compute_stage3_status(p: Project) -> dict:
    """
    Оставшееся время очереди видео: кадры ещё не выгруженных клипов на
    замеренную скорость кодирования + секунда на каждую карточку.
    """
    from media_study.export.worker import DEFAULT_SECONDS_PER_FRAME, STATUS_FILE, pending_fragments

    manifest = p.store.load()
    index = library.export_index(p.dir)
    pending = pending_fragments(manifest, index)
    status = library.read_json(p.export_dir / STATUS_FILE, {})
    spf = status.get("seconds_per_frame", DEFAULT_SECONDS_PER_FRAME)
    notes_left = len(pending) + sum(1 for e in index if not e.get("anki_note_id"))
    eta = sum(f.algo_end_frame - f.algo_start_frame for f in pending) * spf + notes_left * 1.0
    pending_ids = {f.id for f in pending} | {e["fragment_id"] for e in index if not e.get("anki_note_id")}
    return {
        "eta_seconds": round(eta),
        "pending": len(pending),
        "notes_left": notes_left,
        "state": status.get("state", "idle"),
        "message": status.get("message", ""),
        # Переданные фрагменты, по которым карточка ещё не готова.
        "pending_ids": sorted(pending_ids),
    }


class QueueRequest(BaseModel):
    # Не задан — всё видео (кнопка "Передать в Anki" на карточке в списке видео).
    through_fragment_id: str | None = None


@app.post("/api/p/{project_id}/stage3/stop")
def stop_stage3(project_id: str):
    """
    Остановить передачу в Anki: то, что ещё не стало клипом (и не кодируется
    прямо сейчас), возвращается в правку; уже закодированное доделывается.
    """
    from media_study.export.worker import STATUS_FILE

    p = project(project_id)
    keep = {e["fragment_id"] for e in library.export_index(p.dir)}
    status = library.read_json(p.export_dir / STATUS_FILE, {})
    if status.get("state") == "encoding":
        keep.update(word for word in (status.get("message") or "").split() if word.startswith("frag_"))
    manifest, returned = p.store.unqueue_stage3(keep)
    return {"manifest": _public(manifest), "returned": returned, "stage3": _stage3_status(p, fresh=True)}


@app.post("/api/p/{project_id}/finish")
def finish_project(project_id: str):
    """Кнопка "Финиш" в редакторе: всё видео считается отредактированным."""
    manifest = project(project_id).store.mark_finished()
    return {"manifest": _public(manifest)}


@app.post("/api/p/{project_id}/stage3/queue")
def queue_stage3(project_id: str, body: QueueRequest):
    from media_study.export.worker import default_deck

    p = project(project_id)
    if not body.through_fragment_id:
        # Кнопка в списке видео / в окне видео: передаётся только
        # отредактированное – до скрытой метки (последнего изменённого
        # фрагмента). Раньше передавалось всё видео, и не тронутые фрагменты
        # считались "отредактированными" (полоса прыгала на 100%, карточка
        # синела раньше времени).
        manifest = p.store.load()
        last = library.last_touched_index(manifest)
        if last < 0:
            raise HTTPException(status_code=400, detail="Передавать нечего – ещё ничего не отредактировано")
        body.through_fragment_id = manifest.fragments[last].id
    try:
        manifest, queued = p.store.queue_for_stage3(body.through_fragment_id, default_deck(p.dir))
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error))
    _spawn_worker()
    return {"manifest": _public(manifest), "queued": queued, "stage3": _stage3_status(p, fresh=True)}


# Флаги карточек в Anki по видео: {код видео: {номер флага: сколько}}. Anki
# опрашивается не чаще раза в ANKI_FLAGS_TTL секунд (библиотека обновляется
# каждые 5 с); если Anki закрыт — последнее известное.
ANKI_FLAGS_TTL = 60
_anki_flags_cache: dict = {"at": 0.0, "counts": {}}
# (при запуске – последние известные числа с диска, см. _load_anki_cache)
# Флаги карточек: 1 красный — править и обрезку/текст, и перевод; 2 оранжевый
# ("жёлтый") — обрезку/текст; 3 зелёный — перевод.
INTERVAL_FLAGS = (1, 2)
TRANSLATION_FLAGS = (1, 3)


# Последние известные числа из Anki (флаги, переведено) – и на диске: после
# перезапуска сервера при закрытом Anki полосы "Переведено" не обнуляются.
ANKI_CACHE_FILE = "anki_cache.json"


def _load_anki_cache() -> None:
    saved = library.read_json(DATA_DIR / ANKI_CACHE_FILE, {})
    if saved:
        _anki_flags_cache.update(counts=saved.get("counts", {}), translated=saved.get("translated", {}))


def _save_anki_cache() -> None:
    from media_study.export.agent import save_json

    try:
        save_json(DATA_DIR / ANKI_CACHE_FILE, {"counts": _anki_flags_cache.get("counts", {}),
                                               "translated": _anki_flags_cache.get("translated", {}), "saved_at": time.time()})
    except OSError:
        pass


def _anki_flag_counts() -> dict:
    import time as _time

    from media_study.export import anki

    from media_study.export import agent

    # Агент записал новую пачку перевода после последнего подсчёта — считаем заново
    # сразу (иначе полоса "Переведено" в списке отставала бы до минуты).
    agent_updated = (agent.load_json(DATA_DIR / agent.STATUS_FILE, {}) or {}).get("updated") or 0
    if _time.time() - _anki_flags_cache["at"] < ANKI_FLAGS_TTL and agent_updated <= _anki_flags_cache["at"]:
        return _anki_flags_cache["counts"]
    counts: dict = {}
    translated: dict = {}
    try:
        for item in anki.flagged_notes():
            per = counts.setdefault(item["project"], {})
            per[item["flag"]] = per.get(item["flag"], 0) + 1
        # Переведённые карточки — с заполненным оборотом.
        for project_dir in DATA_DIR.iterdir():
            if (project_dir / "export" / "index.json").exists():
                query = f'"tag:{anki.TAG}::{project_dir.name}::*" -"{anki.BACK_FIELD}:"'
                translated[project_dir.name] = len(anki.invoke("findNotes", query=query))
    except (anki.AnkiUnavailable, RuntimeError):
        _anki_flags_cache["at"] = _time.time()
        return _anki_flags_cache["counts"]
    _anki_flags_cache.update(at=_time.time(), counts=counts, translated=translated)
    _save_anki_cache()
    return counts


# Место на диске по видео — пересчёт (обход всех файлов) не чаще раза в DISK_TTL секунд.
DISK_TTL = 30
_disk_cache: dict[str, tuple[float, int]] = {}


def _disk_total(project_id: str) -> int:
    cached = _disk_cache.get(project_id)
    if cached and time.time() - cached[0] < DISK_TTL:
        return cached[1]
    total = library.disk_usage(DATA_DIR / project_id)["total"]
    _disk_cache[project_id] = (time.time(), total)
    return total
