# -*- coding: utf-8 -*-
"""
Локальный backend веб-приложения. Обслуживает сразу все видео из папки
data/ (каждое видео — папка data/<код видео>): библиотеку, редактор
фрагментов любого видео, раздел Anki и скачивание новых видео.

Папка data берётся из MEDIA_STUDY_DATA_DIR (её выставляет media_study/web/run.py);
для совместимости понимается и старая YT_ENG_STUDY_PROJECT_DIR — тогда data
это её родительская папка.

API редактора для конкретного видео — /api/p/<код видео>/..., файлы видео —
/media/<код видео>/source.mp4 и т.п. Видео отдаётся через StaticFiles —
Starlette у него из коробки поддерживает HTTP Range (206 Partial Content),
это и даёт браузерному <video> нормальную перемотку.
"""
from pathlib import Path
import html
import re
import json
import os
import subprocess
import sys
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from media_study.core.audio import AUDIO_RATE, build_audio_track, sample_for_frame, wav_slice
from media_study.web import library
from media_study.web.manifest_store import ManifestStore

_data_dir_env = os.environ.get("MEDIA_STUDY_DATA_DIR", "")
_legacy_project_env = os.environ.get("YT_ENG_STUDY_PROJECT_DIR", "")
if _data_dir_env:
    DATA_DIR = Path(_data_dir_env).resolve()
elif _legacy_project_env:
    DATA_DIR = Path(_legacy_project_env).resolve().parent
else:
    raise RuntimeError(
        "Не задана папка с видео — запускайте сервер через "
        "`py -3.12 -m media_study.web.run`, а не uvicorn напрямую."
    )
if not DATA_DIR.exists():
    raise RuntimeError(f"Папка с видео не найдена: {DATA_DIR}")

STATIC_DIR = Path(__file__).parent / "static"
REPO_DIR = Path(__file__).resolve().parents[2]  # корень проекта

app = FastAPI(title="media-study")


# Интерфейс (html/js/css) браузер не должен брать из кэша: иначе после
# обновления кода страница может работать со старым player.js или app.js.
# Видео и волну это не касается — они большие и не меняются.
@app.middleware("http")
async def no_cache_for_ui(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# Пока идёт перекраска карточек Anki (кнопка в настройках) – правка видео и
# всё, что пишет в Anki (передача, перевод, возврат на правку), запрещены:
# иначе перекраска и эти действия меняли бы одни и те же заметки вперемешку.
# Перенос на другой диск Anki не трогает – его можно.
_recolor: dict = {}
_ANKI_LOCK_PATHS = ("/api/agent/run", "/api/agent/apply", "/api/anki/return", "/api/anki/check")


@app.middleware("http")
async def lock_while_recolor(request, call_next):
    path = request.url.path
    if (request.method in ("POST", "PATCH", "PUT", "DELETE") and _recolor.get("running")
            and ((path.startswith("/api/p/") and not path.endswith(("/move", "/move/cancel"))) or path in _ANKI_LOCK_PATHS)):
        from fastapi.responses import JSONResponse

        return JSONResponse({"detail": "Идёт перекраска карточек Anki – правка и передача в Anki недоступны, подождите"}, status_code=423)
    return await call_next(request)


# -- видео (проекты) ---------------------------------------------------------------


class Project:
    """Одно видео: папка, хранилище манифеста и подготовленные для редактора файлы."""

    def __init__(self, project_dir: Path):
        self.dir = project_dir
        self.id = project_dir.name
        self.store = ManifestStore(project_dir)
        self.audio_path = project_dir / "audio.pcm"
        self.export_dir = project_dir / "export"
        self._prepared = False

    def prepare(self) -> None:
        """Волна для дорожки и несжатый звук — строятся один раз, при первом открытии."""
        if self._prepared:
            return
        video = self.store.load().video
        waveform = self.dir / "waveform.bin"
        if not waveform.exists():
            from media_study.core.waveform import build_waveform

            print(f"{self.id}: строю звуковую волну для дорожки (один раз)...", flush=True)
            build_waveform(self.dir / video.source_file, waveform, video.fps, video.total_frames)
        if not self.audio_path.exists():
            master = self.dir / (video.master_file or "")
            source = master if video.master_file and master.exists() else self.dir / video.source_file
            print(f"{self.id}: извлекаю звуковую дорожку (один раз)...", flush=True)
            try:
                build_audio_track(source, self.audio_path)
            except Exception as error:  # например, у видео нет звука
                print(f"{self.id}: звук извлечь не удалось ({error}) — редактор будет без звука.", flush=True)
        self._prepared = True


_projects: dict[str, Project] = {}
_projects_lock = threading.Lock()


def project(project_id: str) -> Project:
    """Видео по коду; 404, если такого нет или этап 1 ещё не закончен."""
    project_dir = DATA_DIR / project_id
    if "/" in project_id or "\\" in project_id or not (project_dir / "manifest.json").exists():
        raise HTTPException(status_code=404, detail=f"видео {project_id} не найдено или ещё обрабатывается")
    with _projects_lock:
        if project_id not in _projects:
            _projects[project_id] = Project(project_dir)
        return _projects[project_id]


def _public(manifest) -> dict:
    """Манифест для редактора (все фрагменты, в том числе уже переданные в Anki)."""
    return manifest.to_dict()


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


# -- библиотека ---------------------------------------------------------------------


@app.get("/api/projects")
def list_projects():
    return library.list_projects(DATA_DIR)


@app.get("/api/p/{project_id}/summary")
def project_summary(project_id: str):
    return library.summary(project(project_id).dir)


@app.get("/api/p/{project_id}/stats")
def project_stats(project_id: str):
    p = project(project_id)
    summary = library.summary(p.dir)
    _anki_flag_counts()  # обновить кэш переведённых, если устарел
    summary["translated"] = _anki_flags_cache.get("translated", {}).get(project_id, 0)
    # Сколько фрагментов ещё без перевода (и переданные в Anki, и нет) — для кнопки "Перевести".
    from media_study.export import anki, translator

    try:
        summary["to_translate"] = len(translator.project_cards(p.dir))
        # Окно видео – точное число прямо из Anki, без кэша: перевод пишется пачками
        # и должен быть виден сразу (в списке видео – кэш на минуту).
        summary["translated"] = translator.in_anki_text_count(p.dir) - summary["to_translate"]
    except (anki.AnkiUnavailable, RuntimeError):
        summary["to_translate"] = None  # Anki закрыт — неизвестно
        # Переведено – последнее известное (иначе при закрытом Anki было бы 0).
        summary["translated"] = _anki_flags_cache.get("translated", {}).get(project_id, 0)
    summary["id"] = project_id
    _card_states(summary, _anki_flag_counts(), {a["id"] for a in _translation_activity() if a.get("id")})
    from . import storage

    return {"summary": summary, "stats": library.stats(p.dir), "disk": library.disk_usage(p.dir),
            "deck_sync": _deck_sync_state(), "storage": _storage_info(project_id)}


@app.get("/api/p/{project_id}/disk")
def project_disk(project_id: str):
    """Место на диске по этапам — и для видео, которое ещё не обработано."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    return {**library.disk_usage(project_dir), "storage": _storage_info(project_id)}


def _storage_info(project_id: str) -> dict:
    """Где лежит видео, куда его можно перенести и как идёт перенос."""
    from . import storage

    here = storage.location(DATA_DIR, project_id)
    # Свободное место на текущем – для строки "сейчас здесь" в окне хранилища.
    for s in storage.storages(DATA_DIR):
        if os.path.normcase(s["path"]) == os.path.normcase(here["path"]) and "free" in s:
            here["free"], here["total"] = s["free"], s["total"]
    move = storage.MOVES.get(project_id)
    return {
        "here": here,
        "targets": [s for s in storage.storages(DATA_DIR)
                    if s["online"] and os.path.normcase(s["path"]) != os.path.normcase(here["path"])],
        "move": move and {**{k: move[k] for k in ("done", "total", "dest", "error", "finished")}, "waiting": move.get("waiting", "")},
    }


@app.get("/api/storages")
def list_storages():
    """Хранилища (настройки): путь, диск, свободно / всего, сколько видео и места занимают."""
    from . import storage

    result = storage.storages(DATA_DIR)
    for s in result:
        s["videos"], s["used"] = 0, 0
    for link in DATA_DIR.iterdir():
        if not link.is_dir() or not any((link / m).exists() for m in ("manifest.json", "video_info.json", "phase1_status.json")):
            continue
        here = storage.location(DATA_DIR, link.name)
        for s in result:
            if os.path.normcase(s["path"]) == os.path.normcase(here["path"]):
                s["videos"] += 1
                s["used"] += _disk_total(link.name)
    return result


@app.post("/api/p/{project_id}/move/cancel")
def cancel_move(project_id: str):
    """Отменить перенос на другой диск (видео остаётся на старом месте)."""
    from . import storage

    if not storage.cancel_move(project_id):
        raise HTTPException(status_code=400, detail="перенос не идёт")
    return {"ok": True}


@app.get("/api/p/{project_id}/edit_state")
def edit_state(project_id: str):
    """
    Можно ли открыть видео в редакторе: нельзя, пока оно переносится на
    другой диск; и пока идёт передача в Anki или перевод, если править уже
    нечего (все фрагменты переданы/передаются).
    """
    from . import storage

    project_dir = DATA_DIR / project_id
    if storage.moving(project_id):
        return {"locked": True, "reason": "Видео переносится на другой диск – править можно после переноса"}
    if not (project_dir / "manifest.json").exists():
        return {"locked": False, "reason": ""}
    item = library.summary(project_dir)
    busy = _stage3_status(project(project_id))["notes_left"] or project_id in {
        a["id"] for a in _translation_activity() if a.get("id")}
    if busy and not item.get("editable"):
        return {"locked": True, "reason": "Идёт передача в Anki или перевод, а править больше нечего"}
    return {"locked": False, "reason": ""}


class MoveRequest(BaseModel):
    dest: str


@app.post("/api/p/{project_id}/move")
def move_project(project_id: str, body: MoveRequest):
    """
    Перенести видео в другое хранилище (копия -> ссылка -> удаление старого).
    Нельзя, пока над видео идёт процесс: обработка, передача в Anki, перевод.
    """
    from . import storage

    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    known = [s["path"] for s in storage.storages(DATA_DIR)]
    if not any(os.path.normcase(body.dest) == os.path.normcase(p) for p in known):
        raise HTTPException(status_code=400, detail="такого хранилища нет в настройках")
    item = library.summary(project_dir)
    busy = item["state"] == "processing" or (item["state"] == "ready" and _stage3_status(project(project_id), fresh=True)["notes_left"]) \
        or project_id in {a["id"] for a in _translation_activity() if a.get("id")}
    if busy:
        raise HTTPException(status_code=409, detail="Над видео идёт процесс – перенести можно после него")
    # Свободного места должно хватить (с запасом 1 ГБ).
    need = _disk_total(project_id)
    dest = next(s for s in storage.storages(DATA_DIR) if os.path.normcase(s["path"]) == os.path.normcase(body.dest))
    if dest.get("free", 0) < need + 2**30:
        raise HTTPException(status_code=400, detail="На диске не хватит места")
    # Закрыть копию видео в редакторе этого сервера нельзя – её держит браузер;
    # если файлы заняты, перенос сам сообщит об этом.
    try:
        storage.start_move(DATA_DIR, project_id, body.dest)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    _disk_cache.pop(project_id, None)
    return {"ok": True}


class ProjectSettingsRequest(BaseModel):
    group: str | None = None
    title: str | None = None


@app.patch("/api/p/{project_id}/settings")
def update_project_settings(project_id: str, body: ProjectSettingsRequest):
    """
    Переименовать автора (группу) и/или название видео. Колода Anki
    (<корень>::<автор>::<название>) переименовывается вслед — карточки
    переезжают в новую колоду (если Anki закрыт — когда он откроется).
    """
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    settings = library.project_settings(project_dir)
    if body.group is not None and body.group.strip():
        settings["group"] = body.group.strip()
    if body.title is not None and body.title.strip():
        settings["title"] = body.title.strip()
    library.save_project_settings(project_dir, settings)
    _deck_sync_run()
    return {**library.summary(project_dir), "deck_sync": _deck_sync_state()}


# -- добавить и обработать (этап 1) ------------------------------------------------


def _priority_flag() -> int:
    """Пониженный приоритет фоновых процессов (настройка low_priority)."""
    return subprocess.BELOW_NORMAL_PRIORITY_CLASS if library.app_settings(DATA_DIR).get("low_priority", True) else 0


def _worker_env() -> dict:
    """Окружение фоновых процессов: сколько ядер оставить свободными (media_study/core/resources.py)."""
    from media_study.core.resources import ENV_RESERVE

    reserve = library.app_settings(DATA_DIR).get("reserve_cpu_cores", 2)
    return {**os.environ, "PYTHONIOENCODING": "utf-8", ENV_RESERVE: str(int(reserve))}


def _spawn_phase1(project_dir: Path, args: list[str]) -> None:
    """Этап 1 в фоне; вывод — в data/<id>/phase1.log, ход — в phase1_status.json."""
    from . import storage

    storage.new_project_dir(DATA_DIR, project_dir.name)
    log = open(project_dir / "phase1.log", "a", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, "-u", "-m", "media_study.ingest.cli", *args, "--project-dir", str(project_dir)],
        cwd=str(REPO_DIR),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | _priority_flag(),
        close_fds=True,
        env=_worker_env(),
    )
    # Чтобы обработку можно было отменить из окна видео (см. cancel_process).
    (project_dir / PHASE1_PID_FILE).write_text(str(process.pid), encoding="utf-8")


PHASE1_PID_FILE = "phase1.pid"


@app.post("/api/p/{project_id}/process/cancel")
def cancel_process(project_id: str):
    """
    Отменить идущее скачивание/обработку: процесс этапа 1 (со всеми дочерними —
    ffmpeg, распознавание) завершается. Готовые шаги остаются (при следующем
    запуске не переделываются), скачивание продолжится с места остановки.
    """
    project_dir = DATA_DIR / project_id
    pid_path = project_dir / PHASE1_PID_FILE
    if not pid_path.exists():
        raise HTTPException(status_code=400, detail="обработка не запущена из приложения")
    pid = pid_path.read_text(encoding="utf-8").strip()
    # Номер процесса мог достаться другой программе (обработка давно кончилась) —
    # завершаем, только если это и правда этап 1 этого видео.
    command = subprocess.run(
        ["powershell", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"],
        capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW,
    ).stdout
    if "media_study.ingest.cli" not in command or project_id not in command:
        pid_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="обработка этого видео сейчас не идёт")
    subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    pid_path.unlink(missing_ok=True)
    from media_study.core.progress import report

    report(project_dir, "failed", None, force=True)
    status_path = project_dir / "phase1_status.json"
    data = json.loads(status_path.read_text(encoding="utf-8"))
    data["label"] = "Обработка отменена – можно запустить снова"
    status_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return library.summary(project_dir)


class DownloadRequest(BaseModel):
    url: str


@app.post("/api/download")
def download(body: DownloadRequest):
    """Добавить по ссылке: скачивание в фоне; обработка — сразу или кнопкой (настройка auto_process)."""
    from media_study.ingest.build_manifest import _extract_video_id

    url = body.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="пустая ссылка")
    project_id = _extract_video_id(url)
    project_dir = DATA_DIR / project_id
    if (project_dir / "manifest.json").exists():
        raise HTTPException(status_code=400, detail="это видео уже обработано")
    settings = library.app_settings(DATA_DIR)
    args = [url] if settings["auto_process"] else [url, "--only-add"]
    if settings.get("download_max_height"):
        args += ["--max-height", str(int(settings["download_max_height"]))]
    _spawn_phase1(project_dir, args)
    return {"id": project_id}


@app.get("/api/p/{project_id}/pack")
def export_pack(project_id: str):
    """Набор от сообщества из этого видео (файл .mspack.json, без медиа – см. media_study/packs.py)."""
    from fastapi.responses import Response
    from urllib.parse import quote

    from media_study import packs

    p = project(project_id)
    pack, warnings = packs.export_pack(p.dir)
    name = packs.pack_filename(pack)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"}
    if warnings:
        headers["X-Pack-Warnings"] = quote(" | ".join(warnings))
    return Response(json.dumps(pack, ensure_ascii=False), media_type="application/json", headers=headers)


@app.post("/api/packs/import")
async def import_pack(request: Request):
    """
    Набор от сообщества: видео по ссылке из набора скачивается и сразу
    размечается по набору (без распознавания). Набор для своего файла (без
    ссылки) – добавьте файл, затем "Применить набор" в окне "Обработки".
    """
    from media_study import packs
    from media_study.ingest.build_manifest import _extract_video_id

    try:
        pack = json.loads(await request.body())
        packs.validate(pack)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error) or "не удалось прочитать набор")
    url = (pack.get("media") or {}).get("source_url", "").strip()
    if not url.startswith("http"):
        return {"id": None, "needs_file": True, "title": (pack.get("project") or {}).get("title", "")}
    project_id = _extract_video_id(url)
    project_dir = DATA_DIR / project_id
    if (project_dir / "manifest.json").exists():
        raise HTTPException(status_code=400, detail="это видео уже есть – чтобы разметить его заново по набору, удалите его")
    from . import storage

    project_dir = storage.new_project_dir(DATA_DIR, project_id, audio=(pack.get("media") or {}).get("kind") == "audio")
    (project_dir / "pack.json").write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    args = [url]
    settings = library.app_settings(DATA_DIR)
    if settings.get("download_max_height"):
        args += ["--max-height", str(int(settings["download_max_height"]))]
    _spawn_phase1(project_dir, args)
    return {"id": project_id}


@app.post("/api/p/{project_id}/pack")
async def apply_pack(project_id: str, request: Request):
    """Применить набор к уже добавленному (ещё не обработанному) видео или аудио – и обработать по нему."""
    from media_study import packs

    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    if (project_dir / "manifest.json").exists():
        raise HTTPException(status_code=400, detail="видео уже обработано")
    try:
        pack = json.loads(await request.body())
        packs.validate(pack)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error) or "не удалось прочитать набор")
    (project_dir / "pack.json").write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    _spawn_phase1(project_dir, ["--process"])
    return {"ok": True}


@app.put("/api/import")
async def import_file(request: Request, name: str):
    """
    Добавить свой файл (видео или аудио). Файл приходит телом запроса целиком
    (без multipart — так можно слать гигабайты потоком) и сразу пишется на диск.
    """
    from media_study.ingest.acquire import import_file as accept_file, slug_for_file

    size = int(request.headers.get("content-length") or 0)
    project_id = slug_for_file(name, size)
    from . import storage

    from media_study.ingest.acquire import AUDIO_EXTENSIONS

    project_dir = storage.new_project_dir(DATA_DIR, project_id, audio=Path(name).suffix.lower() in AUDIO_EXTENSIONS)
    incoming = project_dir / f"incoming{Path(name).suffix.lower()}"
    with open(incoming, "wb") as out:
        async for chunk in request.stream():
            out.write(chunk)
    try:
        accept_file(incoming, project_dir, name, move=True)
    except Exception as error:
        raise HTTPException(status_code=400, detail=str(error))
    if library.app_settings(DATA_DIR)["auto_process"]:
        _spawn_phase1(project_dir, ["--process"])
    return {"id": project_id}


class SourcesRequest(BaseModel):
    sources: list[str]
    # Помощь агента: "" — нет; "deep" — глубокий поиск (агент + ссылки);
    # "search" — агент сам ищет достоверные источники (ссылки не нужны).
    agent: str | bool = ""
    # Без пустых фрагментов: при нарезке фрагменты без текста (музыка, шумы)
    # не создаются.
    no_gaps: bool = False
    # Языки видео (core/lang.py): речь и карточки; None – не менять.
    speech_lang: str | None = None
    card_lang: str | None = None


@app.patch("/api/p/{project_id}/sources")
def update_sources(project_id: str, body: SourcesRequest):
    """Ссылки на текст для сверки и режим помощи агента (см. SourcesRequest)."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    settings = library.project_settings(project_dir)
    settings["sources"] = [s.strip() for s in body.sources if s.strip()]
    settings["agent"] = library.agent_mode(body.agent)
    settings["no_gaps"] = bool(body.no_gaps)
    for key in ("speech_lang", "card_lang"):
        value = getattr(body, key)
        if value:
            settings[key] = value
    library.save_project_settings(project_dir, settings)
    return library.summary(project_dir)


@app.post("/api/p/{project_id}/process")
def process(project_id: str):
    """Запустить обработку уже добавленного видео (или продолжить прерванную)."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    if library.phase1_running(project_dir):
        raise HTTPException(status_code=400, detail="уже обрабатывается")
    from media_study.ingest.acquire import master_path

    url = library.video_info(project_dir).get("webpage_url")
    if master_path(project_dir) is None and url:
        # Скачивание оборвалось — докачать (с места обрыва) и обработать.
        args = [url]
        height = library.app_settings(DATA_DIR).get("download_max_height")
        if height:
            args += ["--max-height", str(int(height))]
        _spawn_phase1(project_dir, args)
    else:
        _spawn_phase1(project_dir, ["--process"])
    return library.summary(project_dir)


# -- настройки и текущая активность ---------------------------------------------------


# Ключ OpenRouter – secrets/openrouter_key.txt в корне проекта (media_study/core/secrets.py);
# путь к действующему – в настройке openrouter_key_file (запасной – _next).


def _openrouter_key() -> str:
    path = library.app_settings(DATA_DIR).get("openrouter_key_file") or ""
    try:
        return Path(path).read_text(encoding="utf-8").strip() if path else ""
    except OSError:
        return ""


# Переименование колод Anki (корень, автор, название поменялись). Если Anki
# закрыт — повторяется в фоне раз в DECK_SYNC_RETRY секунд, пока не получится.
DECK_SYNC_RETRY = 30
_deck_sync = {"pending": False, "message": "", "moved": [], "lock": threading.Lock(), "retrying": False}


def _deck_sync_run() -> dict:
    result = _deck_sync_run_once()
    if result["pending"] and not _deck_sync["retrying"]:
        _deck_sync["retrying"] = True

        def retry():
            while _deck_sync["pending"]:
                time.sleep(DECK_SYNC_RETRY)
                try:
                    _deck_sync_run_once()
                except Exception as error:  # не валить сервер из фонового потока
                    _deck_sync["message"] = f"ошибка переименования колод: {error}"
            _deck_sync["retrying"] = False

        threading.Thread(target=retry, daemon=True).start()
    return result


def _deck_sync_run_once() -> dict:
    from media_study.export import decks

    with _deck_sync["lock"]:
        result = decks.sync(DATA_DIR, lambda pid, deck: project(pid).store.set_anki_deck(deck))
        _deck_sync.update(pending=result["pending"], message=result["message"])
        if result["moved"]:
            _deck_sync["moved"] = result["moved"]
    return result


def _deck_sync_state() -> dict:
    return {"pending": _deck_sync["pending"], "message": _deck_sync["message"], "moved": _deck_sync["moved"]}


_models_cache: dict = {"at": 0.0, "models": []}
# Кого показывать в списке моделей перевода (остальные можно вписать вручную).
MODEL_PROVIDERS = ("anthropic/", "openai/", "google/", "deepseek/", "x-ai/", "qwen/", "mistralai/")
PROVIDER_NAMES = {"anthropic/": "Anthropic", "openai/": "OpenAI", "google/": "Google", "deepseek/": "DeepSeek",
                  "x-ai/": "xAI", "qwen/": "Qwen", "mistralai/": "Mistral"}


@app.get("/api/openrouter/models")
def openrouter_models():
    """Модели для перевода (текстовые, без :batch), с ценой за миллион токенов; кэш на час."""
    import urllib.request

    if time.time() - _models_cache["at"] < 3600 and _models_cache["models"]:
        return _models_cache["models"]
    try:
        with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))["data"]
    except OSError as error:
        raise HTTPException(status_code=503, detail=f"OpenRouter не отвечает: {error}")
    models = []
    for m in data:
        mid = m.get("id", "")
        modality = (m.get("architecture") or {}).get("output_modalities") or ["text"]
        if not mid.startswith(MODEL_PROVIDERS) or mid.endswith(":batch") or mid.startswith("~") or "image" in mid or modality != ["text"]:
            continue
        pricing = m.get("pricing") or {}
        prompt, completion = float(pricing.get("prompt") or 0) * 1e6, float(pricing.get("completion") or 0) * 1e6
        if prompt <= 0:
            continue
        provider = next(p for p in MODEL_PROVIDERS if mid.startswith(p))
        models.append({"id": mid, "name": m.get("name", mid), "prompt": round(prompt, 3), "completion": round(completion, 3),
                       "created": m.get("created", 0), "provider": PROVIDER_NAMES.get(provider, provider.rstrip("/"))})
    # По компании (в порядке MODEL_PROVIDERS), внутри — по цене (вход + выход), дешевле выше.
    models.sort(key=lambda x: (MODEL_PROVIDERS.index(next(p for p in MODEL_PROVIDERS if x["id"].startswith(p))),
                               x["prompt"] + x["completion"], x["id"]))
    _models_cache.update(at=time.time(), models=models, all_ids={m.get("id", "") for m in data})
    return models


@app.get("/api/anki/models")
def anki_models():
    """Типы заметок из Anki – для списка в настройках (нужны хотя бы два поля: лицо и оборот)."""
    from media_study.export import anki

    try:
        names = anki.invoke("modelNames")
    except anki.AnkiUnavailable:
        raise HTTPException(503, "Anki закрыт")
    return {"models": sorted(names, key=str.lower)}


@app.get("/api/settings")
def get_settings():
    # Ключ OpenRouter отдаётся только локальной странице настроек (поле со "скрыть/показать").
    from media_study.ingest.speech.elevenlabs import api_key as elevenlabs_key

    return {**library.app_settings(DATA_DIR), "openrouter_key": _openrouter_key(), "elevenlabs_key": elevenlabs_key(DATA_DIR),
            "deck_sync": _deck_sync_state()}


@app.patch("/api/settings")
def update_settings(body: dict):
    """
    Общие настройки. Ключ OpenRouter пишется в secrets/openrouter_key.txt. Новый
    запас до/после отрезка применяется ко всем видео — к фрагментам, которые
    ещё не просмотрены (после скрытой метки); просмотренные не меняются.
    """
    # Модели должны быть на OpenRouter (вписанную вручную с опечаткой не сохраняем).
    wanted = [(name, (body.get(field) or "").strip()) for field, name in
              (("openrouter_model", "перевода"), ("search_model", "поиска"))]
    if any(value for _, value in wanted):
        try:
            openrouter_models()
            known = _models_cache.get("all_ids") or set()
        except HTTPException:
            known = set()  # OpenRouter не отвечает — не мешаем сохранить
        for name, value in wanted:
            if value and known and value not in known:
                raise HTTPException(status_code=400, detail=f"модели {name} «{value}» нет на OpenRouter")
    if "storages" in body:
        paths = []
        for raw in body.get("storages") or []:
            path = str(raw).strip().rstrip("\\/")
            if not path:
                continue
            if not os.path.isabs(path) or not Path(os.path.splitdrive(path)[0] + "\\").exists():
                raise HTTPException(status_code=400, detail=f"Хранилище «{path}»: диск не найден")
            if os.path.normcase(os.path.abspath(path)) == os.path.normcase(str(DATA_DIR.resolve())):
                continue
            Path(path).mkdir(parents=True, exist_ok=True)
            if path not in paths:
                paths.append(path)
        body["storages"] = paths
    # Ключи – в secrets/ в корне проекта (в настройки не пишутся).
    from media_study.core import secrets

    el_key = body.pop("elevenlabs_key", None)
    if el_key is not None:
        secrets.write(secrets.ELEVENLABS_KEY, el_key)
    key = (body.pop("openrouter_key", None) or "").strip()
    if key and key != _openrouter_key():
        secrets.write(secrets.OPENROUTER_KEY, key)
        body["openrouter_key_file"] = str(secrets.OPENROUTER_KEY)
    old = library.app_settings(DATA_DIR)
    old_padding = old["context_padding_seconds"]
    before = library.app_settings(DATA_DIR)
    saved = library.save_app_settings(DATA_DIR, body)
    # Обратные карточки только что включили – создать их для уже переведённых (в фоне).
    if any(saved.get(k) and not before.get(k) for k in ("reverse_cards_video", "reverse_cards_audio")):
        def make_reverse():
            from media_study.export import anki, reverse

            try:
                reverse.sync_all(DATA_DIR)
            except anki.AnkiUnavailable:
                print("Обратные карточки: Anki закрыт – создадутся при следующей передаче", flush=True)
            except RuntimeError as error:
                print(f"Обратные карточки: {error}", flush=True)

        threading.Thread(target=make_reverse, daemon=True).start()
    if saved["anki_deck_root"] != old["anki_deck_root"] or saved.get("anki_deck_root_audio") != old.get("anki_deck_root_audio"):
        _deck_sync_run()
    if saved["context_padding_seconds"] != old_padding:
        for item in library.list_projects(DATA_DIR):
            if item["state"] == "ready":
                project(item["id"]).store.set_default_padding(saved["context_padding_seconds"])
    from media_study.ingest.speech.elevenlabs import api_key as elevenlabs_key

    return {**saved, "openrouter_key": _openrouter_key(), "elevenlabs_key": elevenlabs_key(DATA_DIR), "deck_sync": _deck_sync_state()}


# Перекраска готовых карточек (кнопка в настройках) – в фоне, ход в "Сейчас идёт".
_recolor.update({"running": False, "done": 0, "total": 0, "changed": 0, "error": ""})


@app.post("/api/anki/recolor")
def anki_recolor():
    from media_study.export import anki

    if _recolor["running"]:
        raise HTTPException(status_code=409, detail="Перекраска уже идёт")
    # Идёт передача в Anki или перевод – они сами пишут в те же карточки.
    busy = [a for a in activity() if a.get("kind") in ("anki", "translate")]
    if busy:
        raise HTTPException(status_code=409, detail=f"Сейчас идёт {busy[0]['label'].lower()} – перекрасить можно после")

    def run():
        _recolor.update(running=True, done=0, total=0, changed=0, error="")
        try:
            _recolor["changed"] = anki.recolor_all(progress=lambda done, total: _recolor.update(done=done, total=total))
            from media_study.export import reverse

            reverse.sync_all(DATA_DIR)  # обратные – в новых цветах
        except Exception as error:  # Anki закрыт и т.п.
            _recolor["error"] = str(error)[:300]
        finally:
            _recolor["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True}


@app.get("/api/anki/recolor")
def anki_recolor_state():
    return _recolor


@app.get("/api/asr/status")
def asr_status():
    """Локальный Whisper: модели (установлена ли), видеокарта и библиотеки CUDA, идущие установки."""
    from media_study.ingest.speech import whisper_models

    return whisper_models.status()


class AsrInstall(BaseModel):
    what: str  # "model" | "cuda"
    name: str | None = None


@app.post("/api/asr/install")
def asr_install(body: AsrInstall):
    from media_study.ingest.speech import whisper_models

    if body.what == "cuda":
        whisper_models.install_cuda()
    elif body.what == "model" and body.name in {m[0] for m in whisper_models.MODELS}:
        whisper_models.install_model(body.name)
    else:
        raise HTTPException(status_code=400, detail="неизвестно, что ставить")
    return {"ok": True}


class ElevenLabsCheck(BaseModel):
    key: str | None = None  # не задан – сохранённый
    proxy: str | None = None


@app.post("/api/elevenlabs/check")
def elevenlabs_check(body: ElevenLabsCheck):
    """Кнопка "Проверить" в настройках: ключ и доступ к ElevenLabs (с введёнными, ещё не сохранёнными значениями)."""
    import requests

    from media_study.ingest.speech import elevenlabs as el

    key = (body.key or "").strip() or el.api_key(DATA_DIR)
    if not key:
        return {"ok": False, "message": "Ключ не задан"}
    proxy = (body.proxy if body.proxy is not None else library.app_settings(DATA_DIR).get("elevenlabs_proxy") or "").strip()
    proxies = {"http": proxy, "https": proxy} if proxy else None
    try:
        r = requests.get(el.CHECK_URL, headers={"xi-api-key": key}, proxies=proxies, timeout=20, allow_redirects=False)
    except requests.RequestException as error:
        return {"ok": False, "message": f"Нет связи: {error}"[:300]}
    if el._blocked(r):
        return {"ok": False, "message": "ElevenLabs недоступен из вашей страны – включите VPN или укажите прокси"}
    if r.status_code == 401:
        return {"ok": False, "message": "Ключ не подходит"}
    if r.status_code != 200:
        return {"ok": False, "message": f"Ответ {r.status_code}: {r.text[:200]}"}
    sub = r.json().get("subscription") or {}
    left = (sub.get("character_limit") or 0) - (sub.get("character_count") or 0)
    return {"ok": True, "message": f"Работает: тариф {sub.get('tier') or '?'}, осталось кредитов {left:,}".replace(",", " ")}


# Счётчики разделов меню (Медиа, Обработка) по режимам – раз в 10 с, не чаще.
_counts_cache: dict = {"at": 0.0, "value": None}


@app.get("/api/counts")
def menu_counts():
    if time.time() - _counts_cache["at"] > 10 or _counts_cache["value"] is None:
        value = {"video": {"ready": 0, "pending": 0}, "audio": {"ready": 0, "pending": 0}}
        for item in library.list_projects(DATA_DIR):
            kind = "audio" if item.get("audio_only") else "video"
            value[kind]["ready" if item["state"] == "ready" else "pending"] += 1
        _counts_cache.update(at=time.time(), value=value)
    return _counts_cache["value"]


@app.get("/api/activity")
def activity():
    """Что сейчас идёт: скачивание/обработка видео и очереди Anki — с процентом и временем."""
    items = []
    for item in library.list_projects(DATA_DIR):
        if item["state"] == "processing":
            items.append({
                "kind": "phase1", "id": item["id"], "title": item["title"], "label": item["status"], "step": item.get("step"),
                "percent": item.get("percent"), "eta_seconds": None,
            })
        elif item["state"] == "ready":
            q = _stage3_status(project(item["id"]))
            if q["notes_left"]:
                done = item["notes_in_anki"]
                total = done + q["notes_left"]
                items.append({
                    "kind": "anki", "id": item["id"], "title": item["title"],
                    "label": "Ждёт Anki (откройте Anki)" if q["state"] == "waiting_anki" else "Передача в Anki",
                    "percent": round(100 * done / total, 1) if total else None, "eta_seconds": None,
                })
    items += _translation_activity()
    if _recolor["running"]:
        total = _recolor["total"] or 0
        items.append({"kind": "anki", "id": None, "title": "Карточки Anki", "label": "Перекраска", "lock": True,
                      "detail": f"{_recolor['done']}/{total}" if total else "",
                      "percent": round(100 * _recolor["done"] / total, 1) if total else None, "eta_seconds": None})
    from . import storage

    for move in storage.activity():
        move["title"] = library.title_of(DATA_DIR / move["id"])
        items.append(move)
    return items


def _pid_alive(pid) -> bool:
    import ctypes

    if not pid:
        return False
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259  # STILL_ACTIVE


def _fragments_word(n: int) -> str:
    """Форма слова "фрагмент" по числу (для подписи "N/K фрагментов")."""
    a, b = n % 100, n % 10
    if 11 <= a <= 14 or b == 0 or b >= 5:
        return "фрагментов"
    return "фрагмент" if b == 1 else "фрагмента"


def _translation_activity() -> list[dict]:
    """Перевод в "Сейчас идёт": идущий процесс агента (пачки) и заявки Batch API."""
    from media_study.export import agent

    items = []
    st = agent.load_json(DATA_DIR / agent.STATUS_FILE, {})
    if st.get("state") == "running" and _pid_alive(st.get("pid")):
        title = library.title_of(DATA_DIR / st["project"]) if st.get("project") else "карточки с флагом"
        # "Перевод: 28% – N/K фрагментов": процент и счёт – по фрагментам (карточкам), не по пачкам.
        cards_total, cards_done = st.get("cards_total") or 0, st.get("cards_done") or 0
        items.append({"kind": "translate", "id": st.get("project"), "title": title, "label": "Перевод",
                      "detail": f"{cards_done}/{cards_total} {_fragments_word(cards_total)}" if cards_total else "",
                      "percent": round(100 * cards_done / cards_total, 1) if cards_total else None, "eta_seconds": None})
    for job in agent.load_json(DATA_DIR / agent.BATCH_JOBS_FILE, []):
        groups = job.get("groups", [])
        total = job.get("total") or len(groups) or 0
        # Заявка сообщает только число готовых запросов (пачек) – фрагменты по их доле.
        cards_total = sum(len(g) for g in groups)
        share = (job.get("done") or 0) / total if total else 0
        items.append({"kind": "translate", "id": job["project"], "title": library.title_of(DATA_DIR / job["project"]),
                      "label": "Перевод пакетом",
                      "detail": f"{round(cards_total * share)}/{cards_total} {_fragments_word(cards_total)}" if cards_total else "",
                      "percent": round(100 * share, 1) if total else None, "eta_seconds": None})
    return items


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


@app.get("/api/stats")
def overall_stats():
    """
    Раздел "Статистика": по каждому видео – длительность, правка, Anki,
    перевод, место на диске и расходы OpenRouter (страница сама считает итоги).
    """
    _anki_flag_counts()  # обновить кэш "переведено" (не чаще раза в минуту)
    translated = _anki_flags_cache.get("translated", {})
    videos = []
    for item in library.list_projects(DATA_DIR):
        row = {key: item.get(key) for key in (
            "id", "title", "group", "state", "duration", "fragments_total", "active_total", "cards_total",
            "reviewed", "edit_bar", "in_anki", "exported", "deleted_total", "bar_total", "flagged", "audio_only")}
        row["costs"] = library.project_settings(DATA_DIR / item["id"]).get("costs", {})
        row["translated"] = translated.get(item["id"], 0) if item["state"] == "ready" else 0
        row["disk_total"] = _disk_total(item["id"])
        row["editor_seconds"] = _editor_seconds(item["id"])
        videos.append(row)
    return {"videos": videos, "openrouter_usage": _openrouter_usage()}


# Сколько всего потрачено по ключу OpenRouter (его собственный счётчик) – для
# "Статистики": итог совпадает с OpenRouter, а не только с учтёнными по видео
# расходами. Спрашивается не чаще раза в 5 минут.
_usage_cache: dict = {"at": 0.0, "value": None}


def _openrouter_usage() -> float | None:
    """Последнее известное значение сразу; устарело – обновляется в фоне (страница не ждёт сеть)."""
    if time.time() - _usage_cache["at"] >= 300 and not _usage_cache.get("busy"):
        _usage_cache["busy"] = True

        def refresh():
            from media_study.export.translator import _post

            try:
                reply = _post(DATA_DIR, "/key", None, "GET")
                _usage_cache["value"] = float((reply.get("data") or reply).get("usage") or 0)
            except Exception:  # нет сети / ключа – покажем только учтённое
                pass
            _usage_cache.update(at=time.time(), busy=False)

        threading.Thread(target=refresh, daemon=True).start()
    return _usage_cache["value"]


# -- результаты таймера правки (кнопка "Сохранить" у таймера, раздел "Статистика") --
TIMER_FILE = "timer_results.json"


def _timer_results() -> list[dict]:
    return library.read_json(DATA_DIR / TIMER_FILE, [])


def _save_timer_results(items: list[dict]) -> None:
    from media_study.export.agent import save_json

    save_json(DATA_DIR / TIMER_FILE, items)


@app.get("/api/timer")
def timer_results():
    """Сохранённые результаты таймера (новые – первыми)."""
    return sorted(_timer_results(), key=lambda r: r.get("saved_at", ""), reverse=True)


class TimerResult(BaseModel):
    ms: int  # время работы таймера
    frags: int  # отредактировано фрагментов за это время
    project: str | None = None  # видео, открытое в редакторе


@app.post("/api/timer")
def save_timer_result(body: TimerResult):
    if body.ms < 1000:
        raise HTTPException(status_code=400, detail="Таймер ещё не запускали")
    from datetime import datetime

    item = {"id": uuid.uuid4().hex[:12], "saved_at": datetime.now().isoformat(timespec="seconds"),
            "ms": body.ms, "frags": body.frags, "project": body.project,
            "title": library.title_of(DATA_DIR / body.project) if body.project and (DATA_DIR / body.project).is_dir() else ""}
    _save_timer_results(_timer_results() + [item])
    return item


@app.delete("/api/timer/{result_id}")
def delete_timer_result(result_id: str):
    items = _timer_results()
    left = [r for r in items if r.get("id") != result_id]
    if len(left) == len(items):
        raise HTTPException(status_code=404, detail="нет такого результата")
    _save_timer_results(left)
    return {"ok": True}


@app.get("/api/anki/overview")
def anki_overview():
    """Раздел "Видео": по каждому готовому видео — прогресс правки, Anki и очередь."""
    result = []
    flags = _anki_flag_counts()
    # Видео, которые сейчас переводятся (идёт агент или ждёт пакетная заявка).
    translating = {a["id"] for a in _translation_activity() if a.get("id")}
    for item in library.list_projects(DATA_DIR):
        if item["state"] != "ready":
            continue
        item["translated"] = _anki_flags_cache.get("translated", {}).get(item["id"], 0)
        item["disk_total"] = _disk_total(item["id"])
        # Буква диска, где лежит медиа (основное хранилище или ссылка на другой диск).
        from . import storage as _storage

        item["drive"] = _storage.location(DATA_DIR, item["id"])["label"][:2]
        _card_states(item, flags, translating)
        result.append(item)
    from . import storage

    result += storage.offline_projects(DATA_DIR)
    return result


def _card_states(item: dict, flags: dict, translating: set) -> None:
    """
    Этап видео для оформления карточки (список видео) и окна подробностей:
    complete / ready_to_send / sending / ready_to_translate / translating.
    item — library.summary с уже посчитанным "translated".
    """
    item["stage3"] = _stage3_status(project(item["id"]))
    per = {int(k): v for k, v in flags.get(item["id"], {}).items()}
    item["anki_flags"] = per
    item["flag_interval"] = sum(per.get(f, 0) for f in INTERVAL_FLAGS)
    item["flag_translation"] = sum(per.get(f, 0) for f in TRANSLATION_FLAGS)
    # Видео готово целиком: всё отредактировано и передано в Anki, ничего
    # не вернулось на правку и все карточки переведены.
    item["complete"] = bool(
        item["active_total"] and item["exported"] == item["active_total"] and item["reviewed"] >= item["fragments_total"]
        and not item["flagged"] and not item["flag_interval"]
        # Переведены все фрагменты с текстом (пустые карточки "без_текста" перевода не ждут).
        and item["translated"] >= item["cards_total"] > 0
    )
    # Идёт передача в Anki (клипы кодируются / карточки создаются).
    q = item["stage3"] or {}
    item["sending"] = bool(q.get("pending") or q.get("notes_left"))
    # Всё, что можно, отредактировано (не тронутых и вернувшихся нет), но ещё
    # не всё в Anki (в том числе пока передаётся) — синяя карточка. Цвет
    # меняется, только когда передача закончилась.
    item["ready_to_send"] = bool(
        item["active_total"] and not item["awaiting"] and (item["exported"] < item["active_total"] or item["sending"])
    )
    # Всё передано в Anki, править нечего, осталось только перевести —
    # розоватая карточка с кнопкой "Перевести".
    item["ready_to_translate"] = bool(
        item["active_total"] and not item["complete"] and not item["awaiting"] and not item["sending"]
        and item["exported"] == item["active_total"] and not item["flagged"] and not item["flag_interval"]
        and item["translated"] < item["cards_total"]
    )
    item["translating"] = item["id"] in translating
    from . import storage

    # Видео переносится на другой диск: кнопка "Перемещение…" на карточке,
    # править и запускать процессы нельзя.
    item["moving"] = storage.moving(item["id"])


@app.post("/api/anki/check")
def anki_check():
    """Карточки приложения (тип media-study) с любым флагом — кандидаты на доработку."""
    from media_study.export import anki

    try:
        flagged = anki.flagged_notes()
    except anki.AnkiUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error))
    for item in flagged:
        manifest_path = DATA_DIR / item["project"] / "manifest.json"
        state = "unknown"
        if manifest_path.exists():
            manifest = project(item["project"]).store.load()
            fragment = next((f for f in manifest.fragments if f.id == item["fragment_id"]), None)
            if fragment is not None:
                state = "in_anki" if fragment.exported else "returned"
        item["state"] = state
    return flagged


class ReturnItem(BaseModel):
    project: str
    fragment_id: str


class ReturnRequest(BaseModel):
    items: list[ReturnItem]


# -- агент перевода (флаг "перевод" в Anki) -----------------------------------------


_batch_poll = {"at": 0.0}
BATCH_POLL_SECONDS = 60


@app.get("/api/agent")
def agent_state():
    """Ход агента, заявки Batch API (готовые — подтягиваются) и предложения (ещё не одобренные)."""
    from media_study.export import agent

    if time.time() - _batch_poll["at"] > BATCH_POLL_SECONDS:
        _batch_poll["at"] = time.time()
        try:
            agent.poll_batches(DATA_DIR)
        except Exception:
            pass  # нет сети/ключа — попробуем позже
    jobs = agent.load_json(DATA_DIR / agent.BATCH_JOBS_FILE, [])
    return {
        "status": agent.load_json(DATA_DIR / agent.STATUS_FILE, {"state": "idle"}),
        "batches": [{"id": j["id"], "project": j["project"], "cards": len(j["cards"]), "state": j.get("state", "отправлено"),
                     "submitted": j["submitted"]} for j in jobs],
        "proposals": agent.prune_stale(DATA_DIR),
    }


_batch_poller = {"running": False}


def _ensure_batch_poller() -> None:
    """Пока есть заявки Batch API — раз в BATCH_POLL_SECONDS забирать готовые (в фоне)."""
    from media_study.export import agent

    if _batch_poller["running"]:
        return
    _batch_poller["running"] = True

    def loop():
        while agent.load_json(DATA_DIR / agent.BATCH_JOBS_FILE, []):
            time.sleep(BATCH_POLL_SECONDS)
            try:
                agent.poll_batches(DATA_DIR)
                _anki_flags_cache["at"] = 0.0  # переведённые поменялись — перечитать
            except Exception:
                pass
        _batch_poller["running"] = False

    threading.Thread(target=loop, daemon=True).start()


class AgentRunRequest(BaseModel):
    limit: int | None = None
    project: str | None = None  # перевести непереведённые карточки этого видео (иначе — по флагам)
    batch: bool = False  # одной заявкой Batch API: вдвое дешевле, ответ позже


@app.post("/api/agent/run")
def agent_run(body: AgentRunRequest):
    """Запустить агента в фоне: предложения по карточкам с красным/зелёным флагом."""
    from media_study.export import agent

    status = agent.load_json(DATA_DIR / agent.STATUS_FILE, {})
    if status.get("state") == "running" and time.time() - status.get("updated", 0) < 300:
        raise HTTPException(status_code=409, detail="агент уже работает")
    agent.save_json(DATA_DIR / agent.STATUS_FILE, {"state": "running", "done": 0, "total": 0, "updated": time.time()})
    log = open(DATA_DIR / "agent.log", "a", encoding="utf-8")
    args = [sys.executable, "-m", "media_study.export.agent", "--data-dir", str(DATA_DIR)]
    if body.limit:
        args += ["--limit", str(body.limit)]
    if body.project:
        args += ["--project", body.project]
    if body.batch:
        args += ["--batch"]
        threading.Timer(5, _ensure_batch_poller).start()  # заявка уйдёт — начать ждать ответ
    subprocess.Popen(
        args, cwd=str(REPO_DIR), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | _priority_flag(), close_fds=True,
        env=_worker_env(),
    )
    return {"started": True}


class AgentStopRequest(BaseModel):
    project: str | None = None  # остановить только перевод этого видео (иначе — всё)


@app.post("/api/agent/stop")
def agent_stop(body: AgentStopRequest):
    """
    Остановить перевод: идущий процесс (сделанные пачки уже записаны) и
    заявки Batch API (отменяются у OpenRouter).
    """
    from media_study.export import agent, translator

    stopped = []
    st = agent.load_json(DATA_DIR / agent.STATUS_FILE, {})
    if st.get("state") == "running" and _pid_alive(st.get("pid")) and (not body.project or st.get("project") == body.project):
        subprocess.run(["taskkill", "/PID", str(st["pid"]), "/F"], capture_output=True)
        agent.save_json(DATA_DIR / agent.STATUS_FILE, {**st, "state": "idle", "message": "Остановлено", "updated": time.time()})
        stopped.append("process")
    jobs = agent.load_json(DATA_DIR / agent.BATCH_JOBS_FILE, [])
    keep = []
    for job in jobs:
        if body.project and job["project"] != body.project:
            keep.append(job)
            continue
        try:
            translator._post(DATA_DIR, f"/batches/{job['id']}/cancel")
        except Exception:
            pass  # уже завершена/отменена
        stopped.append(job["id"])
    agent.save_json(DATA_DIR / agent.BATCH_JOBS_FILE, keep)
    return {"stopped": stopped}


class AgentApplyRequest(BaseModel):
    approve: list[int] = []
    reject: list[int] = []
    edits: dict[str, str] = {}  # id заметки -> оборот, поправленный вручную


@app.post("/api/agent/apply")
def agent_apply(body: AgentApplyRequest):
    """Одобренные предложения — в Anki, отклонённые — прочь."""
    from media_study.export import agent, anki

    try:
        result = agent.apply(DATA_DIR, body.approve, body.reject, body.edits)
    except anki.AnkiUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error))
    _anki_flags_cache["at"] = 0.0  # флаги изменились — перечитать
    return result


@app.post("/api/anki/return")
def anki_return(body: ReturnRequest):
    """Вернуть помеченные карточки на правку: их фрагменты снова редактируются в редакторе."""
    returned: dict[str, list[str]] = {}
    for item in body.items:
        returned.setdefault(item.project, []).append(item.fragment_id)
    for project_id, fragment_ids in returned.items():
        project(project_id).store.return_from_stage3(fragment_ids)
        _pull_texts_from_anki(project_id, fragment_ids)
    return {"returned": {k: len(v) for k, v in returned.items()}}


def _pull_texts_from_anki(project_id: str, fragment_ids: list[str]) -> int:
    """
    Вернувшиеся из Anki фрагменты: если текст карточки поправили в Anki, он
    становится текстом фрагмента (с именами говорящих: "Имя: реплика").
    Возвращает, у скольких текст поменялся.
    """
    from media_study.export import anki
    from media_study.export.worker import known_speakers

    p = project(project_id)
    manifest = p.store.load()
    known = known_speakers(p.dir, manifest)
    entries = {e["fragment_id"]: e for e in library.export_index(p.dir) if e.get("anki_note_id")}
    wanted = [fid for fid in fragment_ids if fid in entries]
    if not wanted:
        return 0
    try:
        notes = {n["noteId"]: n for n in anki.invoke("notesInfo", notes=[entries[fid]["anki_note_id"] for fid in wanted])}
    except (anki.AnkiUnavailable, RuntimeError):
        return 0
    changed = 0
    for fid in wanted:
        note = notes.get(entries[fid]["anki_note_id"])
        fragment = next((f for f in manifest.fragments if f.id == fid), None)
        if not note or fragment is None:
            continue
        front = note["fields"][anki.FRONT_FIELD]["value"]
        card = anki.plain_front(front)
        expected = anki.card_content(fragment.text, known)[0]
        if not card or card.strip() == expected.strip():
            continue
        new_text = anki.text_from_card(card, fragment.text, known)
        if new_text != fragment.text:
            p.store.update_fragment(fid, text=new_text)
            changed += 1
    return changed


# -- редактор одного видео ------------------------------------------------------------


class UpdateFragmentRequest(BaseModel):
    algo_start_frame: int | None = None
    algo_end_frame: int | None = None
    text: str | None = None
    text_marks: str | None = None  # разметка правки (см. Fragment.text_marks)
    needs_review: bool | None = None
    review_note: str | None = None
    link: bool = False  # режим "связанные границы" (см. ManifestStore.update_fragment)


class UnvoicedRequest(BaseModel):
    value: bool


@app.post("/api/p/{project_id}/fragments/{fragment_id}/unvoiced")
def set_unvoiced(project_id: str, fragment_id: str, body: UnvoicedRequest):
    """Отметка "не озвучено" (карточка без видео, с подписью Rover:)."""
    manifest = _call(lambda: project(project_id).store.set_unvoiced(fragment_id, body.value))
    return manifest.by_id(fragment_id).to_dict()


class HeardRequest(BaseModel):
    ranges: list[list[int]]
    rebase: bool = False


class MergeRequest(BaseModel):
    direction: str


class SplitRequest(BaseModel):
    current_frame: int


class PaddingRequest(BaseModel):
    side: str  # "left" | "right"
    direction: int  # +1 увеличить, -1 уменьшить


def _call(action):
    """Ошибки хранилища — в понятные ответы: нет фрагмента -> 404, нельзя -> 400."""
    try:
        return action()
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.get("/api/p/{project_id}/manifest")
def get_manifest(project_id: str):
    p = project(project_id)
    p.prepare()
    from media_study.web.library import title_of

    data = _public(p.store.load())
    # Название – заданное вручную в окне видео (если есть): его показывает меню "Сейчас правится".
    data["video"]["title"] = title_of(p.dir)
    data["video"]["group"] = library.group_of(p.dir)  # автор – над названием в ссылке меню
    # Аудио без видео: редактор показывает фон с кругом вместо картинки.
    data["video"]["audio_only"] = bool(library.video_info(p.dir).get("audio_only"))
    # Режим "говорящие на карточках" этого видео (кнопка в редакторе).
    data["video"]["show_speakers"] = library.show_speakers(p.dir)
    return data


@app.post("/api/p/{project_id}/fragments/{fragment_id}/sound-only")
def set_sound_only(project_id: str, fragment_id: str, body: UnvoicedRequest):
    """Отметка "только озвучка" (в карточке – звук без картинки)."""
    manifest = _call(lambda: project(project_id).store.set_sound_only(fragment_id, body.value))
    return manifest.by_id(fragment_id).to_dict()


class SpeakersRequest(BaseModel):
    on: bool


def _fragment_signature(fragment) -> str:
    """Отпечаток правки фрагмента (всё, кроме отметок этапа 3) – изменился ли он с момента снимка."""
    import hashlib

    data = {k: v for k, v in fragment.to_dict().items() if k not in ("exported", "anki_flagged")}
    return hashlib.md5(json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


@app.post("/api/p/{project_id}/speakers")
def set_speakers(project_id: str, body: SpeakersRequest):
    """
    Режим "говорящие на карточках" видео. Касается всех карточек сразу:
    уже переданные в Anki (и переведённые) возвращаются на повторную
    передачу – помечаются вернувшимися, при следующей передаче их карточки
    обновятся (клип не перекодируется, перевод на обороте остаётся).
    """
    p = project(project_id)
    settings = library.project_settings(p.dir)
    previous = bool(settings.get("show_speakers", library.show_speakers(p.dir)))
    if previous == body.on and "show_speakers" in settings:
        return {"manifest": None, "returned": 0, "restored": 0, "on": body.on}
    settings["show_speakers"] = body.on
    library.save_project_settings(p.dir, settings)
    from media_study.core.manifest import STATUS_ACTIVE

    # Снимок прошлого переключения: режим нажали случайно и вернули обратно –
    # фрагменты, которые с тех пор не трогали, снова считаются переданными в
    # Anki (их карточки не менялись). Изменённые остаются вернувшимися.
    undo_path = p.dir / "speakers_undo.json"
    undo = library.read_json(undo_path, None)
    manifest = p.store.load()
    ids = [f.id for f in manifest.fragments if f.exported and f.status == STATUS_ACTIVE]
    before = {f.id: {"flagged": bool(f.anki_flagged)} for f in manifest.fragments if f.id in set(ids)}
    for entry in library.export_index(p.dir):
        if entry["fragment_id"] in before:
            before[entry["fragment_id"]]["redo"] = bool(entry.get("redo"))
    if ids:
        p.store.return_from_stage3(ids)
        try:
            _pull_texts_from_anki(project_id, ids)
        except Exception as error:  # Anki закрыт – правки из Anki подтянутся при следующем возврате
            print(f"Говорящие: тексты из Anki не подтянуты ({error})", flush=True)
    manifest = p.store.load()
    restored = {}
    if undo and bool(undo.get("on")) == body.on:
        snapshot = undo.get("fragments") or {}
        for f in manifest.fragments:
            state = snapshot.get(f.id)
            if state and f.id not in before and not f.exported and f.status == STATUS_ACTIVE and _fragment_signature(f) == state.get("sig"):
                restored[f.id] = state
        if restored:
            p.store.restore_to_stage3(restored)
    # Новый снимок – по только что вернувшимся (их отпечаток – уже после
    # подтягивания текстов из Anki); вернуть их можно, снова выбрав прежний режим.
    if ids:
        current = {f.id: f for f in manifest.fragments}
        snapshot = {i: {**before[i], "sig": _fragment_signature(current[i])} for i in ids if i in current}
        undo_path.write_text(json.dumps({"on": previous, "fragments": snapshot}, ensure_ascii=False), encoding="utf-8")
    elif undo_path.exists():
        undo_path.unlink()
    return {"manifest": get_manifest(project_id), "returned": len(ids), "restored": len(restored), "on": body.on}


@app.patch("/api/p/{project_id}/fragments/{fragment_id}")
def update_fragment(project_id: str, fragment_id: str, body: UpdateFragmentRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.update_fragment(fragment_id, **body.model_dump()))
    # Сдвинутые вместе с этой границей соседи (режим "связанные границы").
    linked = [manifest.by_id(i).to_dict() for i in getattr(store, "last_linked", [])]
    return {**manifest.by_id(fragment_id).to_dict(), "linked": linked}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/heard")
def mark_heard(project_id: str, fragment_id: str, body: HeardRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.mark_heard(fragment_id, body.ranges, body.rebase))
    return manifest.by_id(fragment_id).to_dict()


@app.post("/api/p/{project_id}/fragments/{fragment_id}/reset")
def reset_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.reset(fragment_id)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/padding")
def change_padding(project_id: str, fragment_id: str, body: PaddingRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.change_side_padding(fragment_id, body.side, body.direction))
    return manifest.by_id(fragment_id).to_dict()


@app.post("/api/p/{project_id}/fragments/{fragment_id}/delete")
def soft_delete_fragment(project_id: str, fragment_id: str, link: bool = False):
    # link – режим "связанные границы" (см. ManifestStore.soft_delete).
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.soft_delete(fragment_id, link=link)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/restore")
def restore_fragment(project_id: str, fragment_id: str, link: bool = False):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.restore(fragment_id, link=link)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/delete_final")
def hard_delete_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, nearest_left_id = _call(lambda: store.hard_delete(fragment_id))
    return {"manifest": _public(manifest), "nearest_left_fragment_id": nearest_left_id}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/merge")
def merge_fragment(project_id: str, fragment_id: str, body: MergeRequest):
    store = project(project_id).store
    manifest, merged_id = _call(lambda: store.merge(fragment_id, body.direction))
    # junction – где в новом тексте стык двух фраз (подсветка в редакторе).
    return {"manifest": _public(manifest), "merged_fragment_id": merged_id, "junction": store.last_junction}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/split")
def split_fragment(project_id: str, fragment_id: str, body: SplitRequest):
    store = project(project_id).store
    manifest, left_id, right_id = _call(lambda: store.split(fragment_id, body.current_frame))
    return {"manifest": _public(manifest), "left_fragment_id": left_id, "right_fragment_id": right_id}


# Кусок звука на окно фрагмента [start_frame, end_frame) — WAV, точно по сэмплам.
@app.get("/api/p/{project_id}/audio")
def audio(project_id: str, start_frame: int, end_frame: int):
    p = project(project_id)
    p.prepare()
    if not p.audio_path.exists():
        raise HTTPException(status_code=404, detail="у видео нет звуковой дорожки")
    fps = p.store.load().video.fps
    data, start_sample = wav_slice(p.audio_path, sample_for_frame(start_frame, fps), sample_for_frame(end_frame, fps))
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"X-Audio-Start-Sample": str(start_sample), "X-Audio-Rate": str(AUDIO_RATE)},
    )


# История у каждого фрагмента своя: "назад"/"вперёд" — для текущего фрагмента.
def _history(store: ManifestStore, fragment_id: str) -> dict:
    return {"can_undo": store.can_undo(fragment_id), "can_redo": store.can_redo(fragment_id)}


@app.get("/api/p/{project_id}/fragments/{fragment_id}/history")
def get_history(project_id: str, fragment_id: str):
    return _history(project(project_id).store, fragment_id)


@app.post("/api/p/{project_id}/fragments/{fragment_id}/undo")
def undo(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, focus_id = _call(lambda: store.undo(fragment_id))
    return {"manifest": _public(manifest), "focus_fragment_id": focus_id, "history": _history(store, focus_id)}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/redo")
def redo(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, focus_id = _call(lambda: store.redo(fragment_id))
    return {"manifest": _public(manifest), "focus_fragment_id": focus_id, "history": _history(store, focus_id)}


# Если приложение открыли, а в очереди Anki что-то осталось (например,
# компьютер перезагружали) — очередь продолжается.
try:
    if any(
        _stage3_status(project(item["id"]))["notes_left"]
        for item in library.list_projects(DATA_DIR) if item["state"] == "ready"
    ):
        _spawn_worker()
except Exception as error:  # очередь не должна мешать запуску приложения
    print(f"Очередь этапа 3 не запущена: {error}", flush=True)


# Файлы видео и статика фронтенда монтируются ПОСЛЕ api-роутов — Starlette
# матчит в порядке регистрации, поэтому более специфичные /api/* выше.
@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Браузер сам спрашивает /favicon.ico (вкладки без <link rel=icon>) — отдаём SVG-значок вместо 404."""
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


_load_anki_cache()  # последние известные числа из Anki
# Сводки всех медиа – в кэш сразу при запуске, в фоне (первый заход в раздел не ждёт).
threading.Thread(target=lambda: library.list_projects(DATA_DIR), daemon=True).start()
app.mount("/media", StaticFiles(directory=str(DATA_DIR)), name="media")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# Заявки Batch API, оставшиеся с прошлого запуска сервера, — продолжать ждать ответ.
try:
    _ensure_batch_poller()
except Exception:  # data/ ещё нет и т.п.
    pass
