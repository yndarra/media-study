# -*- coding: utf-8 -*-
"""Открытые вкладки (отметка раз в секунду), журналы, перезапуск и остановка сервера.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import os
import subprocess
import threading
import time
import uuid

from fastapi import HTTPException
from pathlib import Path
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, REPO_DIR, STATIC_DIR, app, project
from .stage3 import _stage3_status


# -- открытые вкладки -------------------------------------------------------------
#
# Каждая открытая страница раз в секунду отмечается на сервере (heartbeat).
# Это нужно start.bat: после перезапуска сервера он спрашивает
# /api/clients, есть ли уже открытая вкладка, — если есть, новую не
# открывает. Сама вкладка, заметив, что сервер сменился (другой instance),
# перезагружается, но только самая свежая из открытых; остальные помечают
# себя устаревшими, чтобы две копии редактора не правили одно и то же.
# Заодно отметка приносит состояние очереди Anki открытого видео.
SERVER_INSTANCE = uuid.uuid4().hex
SERVER_STARTED = time.monotonic()
CLIENT_WINDOW_SECONDS = 3.0  # вкладка считается открытой, если отмечалась за это время
READY_AFTER_SECONDS = 2.5  # к этому моменту все открытые вкладки успевают отметиться
_clients: dict[str, dict] = {}


class HeartbeatRequest(BaseModel):
    client_id: str
    opened_at: float  # когда вкладка открыта (мс с эпохи, из браузера)
    project: str | None = None  # какое видео сейчас открыто в редакторе
    editing: bool = False  # открыт сам редактор (а не другой раздел) – время идёт в статистику


# Время в редакторе по каждому медиа (для "Статистики"): пока вкладка сообщает,
# что открыт редактор, секунды копятся здесь и раз в EDITOR_FLUSH секунд
# дописываются в project.json ("editor_seconds"). Между отметками – не больше
# EDITOR_MAX_GAP (вкладка в фоне отмечается реже, но закрытую не считаем).
EDITOR_FLUSH = 30
EDITOR_MAX_GAP = 90
_editor_time: dict = {"pending": {}, "last": {}, "flushed": time.monotonic()}


def _count_editor_time(client_id: str, project_id: str | None, editing: bool) -> None:
    now = time.monotonic()
    prev = _editor_time["last"].get(client_id)
    _editor_time["last"][client_id] = (now, project_id if editing else None)
    if prev and prev[1] and editing and prev[1] == project_id:
        gap = now - prev[0]
        if gap <= EDITOR_MAX_GAP:
            pending = _editor_time["pending"]
            pending[project_id] = pending.get(project_id, 0.0) + gap
    if now - _editor_time["flushed"] >= EDITOR_FLUSH:
        _flush_editor_time()


def _flush_editor_time() -> None:
    _editor_time["flushed"] = time.monotonic()
    pending, _editor_time["pending"] = _editor_time["pending"], {}
    for project_id, seconds in pending.items():
        project_dir = DATA_DIR / project_id
        if not project_dir.is_dir():
            continue
        settings = library.project_settings(project_dir)
        settings["editor_seconds"] = round(settings.get("editor_seconds", 0) + seconds, 1)
        library.save_project_settings(project_dir, settings)


def _editor_seconds(project_id: str) -> float:
    """Сколько всего редактор был открыт на этом медиа (с ещё не записанным)."""
    saved = library.project_settings(DATA_DIR / project_id).get("editor_seconds", 0)
    return round(saved + _editor_time["pending"].get(project_id, 0.0))


def _live_clients() -> dict:
    now = time.monotonic()
    return {cid: c for cid, c in _clients.items() if now - c["seen"] <= CLIENT_WINDOW_SECONDS}


@app.post("/api/heartbeat")
def heartbeat(body: HeartbeatRequest):
    _clients[body.client_id] = {"opened_at": body.opened_at, "seen": time.monotonic()}
    _count_editor_time(body.client_id, body.project, body.editing)
    live = _live_clients()
    newest = max(live.values(), key=lambda c: c["opened_at"])["opened_at"]
    stage3 = None
    translated = None
    if body.project and (DATA_DIR / body.project / "manifest.json").exists():
        stage3 = _stage3_status(project(body.project))
        translated = _translated_ids(body.project)
    return {
        "instance": SERVER_INSTANCE,
        # Версия интерфейса (время последней правки html/js/css): сменилась –
        # вкладка сама перезагружается (правки интерфейса без перезапуска сервера).
        "ui": _ui_version(),
        # Видео, которые сейчас переносятся: вкладка отпускает их файл в плеере.
        "moving": [pid for pid, st in __import__("media_study.web.storage", fromlist=["MOVES"]).MOVES.items() if not st["finished"]],
        "ready": time.monotonic() - SERVER_STARTED >= READY_AFTER_SECONDS,
        "newest": body.opened_at >= newest,
        "stage3": stage3,
        "translated_ids": translated,
    }


def _ui_version() -> str:
    # Версия интерфейса – по самому свежему файлу static/ вместе с папками
    # css/ и js/ (вкладка перезагружается, когда он меняется).
    return str(max((p.stat().st_mtime_ns for p in STATIC_DIR.rglob("*") if p.is_file()), default=0))


# -- журналы и остановка (низ меню: "Журнал" и "Остановить") ------------------------
#
# Сервер работает без окна консоли; его журнал (data/server.log) и журналы
# фоновых процессов смотрятся в приложении – окошком, которое дописывается
# по мере появления строк.
LOG_FILES = {"server": "server.log", "anki": "stage3_worker.log", "translate": "agent.log"}
LOG_TAIL_BYTES = 96 * 1024  # при открытии – только хвост журнала


@app.get("/api/logs")
def read_log(name: str = "server", since: int | None = None):
    """Новые строки журнала с байта since (нет since – последние LOG_TAIL_BYTES)."""
    if name not in LOG_FILES:
        raise HTTPException(status_code=404, detail="нет такого журнала")
    path = DATA_DIR / LOG_FILES[name]
    if not path.exists():
        return {"text": "", "next": 0}
    size = path.stat().st_size
    start = max(0, size - LOG_TAIL_BYTES) if since is None or since > size else since
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(min(size - start, 2 * 2**20))
    text = data.decode("utf-8", errors="replace")
    if since is None and start > 0:
        text = text.split("\n", 1)[-1]  # с начала строки
    return {"text": text, "next": start + len(data)}


@app.post("/api/restart")
def restart():
    """
    Перезапустить сервер (кнопка внизу меню): запускается новая копия (без
    окна, тот же журнал), которая ждёт, пока эта освободит порт, и эта выходит.
    """
    import sys as _sys

    pythonw = Path(_sys.executable).with_name("pythonw.exe")
    exe = str(pythonw if pythonw.exists() else _sys.executable)
    args = [a for a in _sys.argv[1:]]
    if "--log-file" not in args:
        args += ["--log-file", str(DATA_DIR / "server.log")]
    code = ("import sys, time, runpy; time.sleep(1.5); "
            f"sys.argv = ['media_study.web.run'] + {args!r}; runpy.run_module('media_study.web.run', run_name='__main__')"
            # метка для start.bat (закрывает прежний сервер по "-m media_study.web.run" в командной строке)
            "  # -m media_study.web.run")
    subprocess.Popen([exe, "-c", code], cwd=str(REPO_DIR), close_fds=True,
                     creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
    _flush_editor_time()  # время в редакторе – записать до выхода
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True}


@app.post("/api/shutdown")
def shutdown():
    """
    Остановить сервер (кнопка внизу меню). Фоновые процессы – обработка,
    передача в Anki, перевод – живут отдельно и доделывают своё.
    """
    _flush_editor_time()  # время в редакторе – записать до выхода
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True}


# Фрагменты видео, чьи карточки в Anki уже переведены (оборот заполнен) — для
# розового фона строк в списке фрагментов редактора. Anki спрашивается не чаще
# раза в TRANSLATED_TTL секунд (вкладка отмечается каждую секунду).
TRANSLATED_TTL = 8.0
_translated_cache: dict[str, tuple[float, list[str]]] = {}


def _translated_ids(project_id: str) -> list[str]:
    from media_study.export import anki

    now = time.monotonic()
    cached = _translated_cache.get(project_id)
    if cached and now - cached[0] < TRANSLATED_TTL:
        return cached[1]
    try:
        note_ids = anki.invoke("findNotes", query=f'"tag:{anki.TAG}::{project_id}::*" -"{anki.BACK_FIELD}:"')
        notes = anki.invoke("notesInfo", notes=note_ids) if note_ids else []
        ids = [fid for _, fid in (anki.parse_tags(n.get("tags", [])) for n in notes) if fid]
    except (anki.AnkiUnavailable, RuntimeError):
        ids = cached[1] if cached else []  # Anki закрыт — последнее известное
    _translated_cache[project_id] = (now, ids)
    return ids


@app.get("/api/clients")
def clients():
    return {
        "ready": time.monotonic() - SERVER_STARTED >= READY_AFTER_SECONDS,
        "count": len(_live_clients()),
    }
