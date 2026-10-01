# -*- coding: utf-8 -*-
"""
Локальный backend веб-приложения. Обслуживает сразу все видео из папки
data/ (каждое видео — папка data/<код видео>): библиотеку, редактор
фрагментов любого видео, раздел Anki и скачивание новых видео.

Папка data берётся из MEDIA_STUDY_DATA_DIR (её выставляет webapp/run.py);
для совместимости понимается и старая YT_ENG_STUDY_PROJECT_DIR — тогда data
это её родительская папка.

API редактора для конкретного видео — /api/p/<код видео>/..., файлы видео —
/media/<код видео>/source.mp4 и т.п. Видео отдаётся через StaticFiles —
Starlette у него из коробки поддерживает HTTP Range (206 Partial Content),
это и даёт браузерному <video> нормальную перемотку.
"""
from pathlib import Path
import json
import os
import subprocess
import sys
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from common.audio_track import AUDIO_RATE, build_audio_track, sample_for_frame, wav_slice
from webapp import library
from webapp.manifest_store import ManifestStore

_data_dir_env = os.environ.get("MEDIA_STUDY_DATA_DIR", "")
_legacy_project_env = os.environ.get("YT_ENG_STUDY_PROJECT_DIR", "")
if _data_dir_env:
    DATA_DIR = Path(_data_dir_env).resolve()
elif _legacy_project_env:
    DATA_DIR = Path(_legacy_project_env).resolve().parent
else:
    raise RuntimeError(
        "Не задана папка с видео — запускайте сервер через "
        "`py -3.12 -m webapp.run`, а не uvicorn напрямую."
    )
if not DATA_DIR.exists():
    raise RuntimeError(f"Папка с видео не найдена: {DATA_DIR}")

STATIC_DIR = Path(__file__).parent / "static"
REPO_DIR = Path(__file__).resolve().parent.parent

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
            from common.waveform import build_waveform

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
# Это нужно open_editor.bat: после перезапуска сервера он спрашивает
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


def _live_clients() -> dict:
    now = time.monotonic()
    return {cid: c for cid, c in _clients.items() if now - c["seen"] <= CLIENT_WINDOW_SECONDS}


@app.post("/api/heartbeat")
def heartbeat(body: HeartbeatRequest):
    _clients[body.client_id] = {"opened_at": body.opened_at, "seen": time.monotonic()}
    live = _live_clients()
    newest = max(live.values(), key=lambda c: c["opened_at"])["opened_at"]
    stage3 = None
    if body.project and (DATA_DIR / body.project / "manifest.json").exists():
        stage3 = _stage3_status(project(body.project))
    return {
        "instance": SERVER_INSTANCE,
        "ready": time.monotonic() - SERVER_STARTED >= READY_AFTER_SECONDS,
        "newest": body.opened_at >= newest,
        "stage3": stage3,
    }


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
    return {"summary": library.summary(p.dir), "stats": library.stats(p.dir)}


class ProjectSettingsRequest(BaseModel):
    group: str


@app.patch("/api/p/{project_id}/settings")
def update_project_settings(project_id: str, body: ProjectSettingsRequest):
    """Переименовать автора (группу) видео. Колода Anki, если уже создана, не переносится."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    settings = library.project_settings(project_dir)
    settings["group"] = body.group.strip()
    library.save_project_settings(project_dir, settings)
    return library.summary(project_dir)


# -- добавить и обработать (этап 1) ------------------------------------------------


def _spawn_phase1(project_dir: Path, args: list[str]) -> None:
    """Этап 1 в фоне; вывод — в data/<id>/phase1.log, ход — в phase1_status.json."""
    project_dir.mkdir(parents=True, exist_ok=True)
    log = open(project_dir / "phase1.log", "a", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, "-u", "-m", "phase1_ingest.cli", *args, "--project-dir", str(project_dir)],
        cwd=str(REPO_DIR),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )


class DownloadRequest(BaseModel):
    url: str


@app.post("/api/download")
def download(body: DownloadRequest):
    """Добавить по ссылке: скачивание в фоне; обработка — сразу или кнопкой (настройка auto_process)."""
    from phase1_ingest.build_manifest import _extract_video_id

    url = body.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="пустая ссылка")
    project_id = _extract_video_id(url)
    project_dir = DATA_DIR / project_id
    if (project_dir / "manifest.json").exists():
        raise HTTPException(status_code=400, detail="это видео уже обработано")
    auto = library.app_settings(DATA_DIR)["auto_process"]
    _spawn_phase1(project_dir, [url] if auto else [url, "--only-add"])
    return {"id": project_id}


@app.put("/api/import")
async def import_file(request: Request, name: str):
    """
    Добавить свой файл (видео или аудио). Файл приходит телом запроса целиком
    (без multipart — так можно слать гигабайты потоком) и сразу пишется на диск.
    """
    from phase1_ingest.acquire import import_file as accept_file, slug_for_file

    size = int(request.headers.get("content-length") or 0)
    project_id = slug_for_file(name, size)
    project_dir = DATA_DIR / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
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
    agent: bool = False


@app.patch("/api/p/{project_id}/sources")
def update_sources(project_id: str, body: SourcesRequest):
    """Ссылки на текст для сверки и галочка "агент ищет достоверный источник"."""
    project_dir = DATA_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="видео не найдено")
    settings = library.project_settings(project_dir)
    settings["sources"] = [s.strip() for s in body.sources if s.strip()]
    settings["agent"] = body.agent
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
    _spawn_phase1(project_dir, ["--process"])
    return library.summary(project_dir)


# -- настройки и текущая активность ---------------------------------------------------


@app.get("/api/settings")
def get_settings():
    return library.app_settings(DATA_DIR)


@app.patch("/api/settings")
def update_settings(body: dict):
    return library.save_app_settings(DATA_DIR, body)


# Для оценки оставшегося времени этапа 1: когда и с какого процента начался шаг.
_phase1_timing: dict[str, tuple[str, float, float]] = {}


def _phase1_eta(project_id: str, step: str, percent: float | None) -> int | None:
    if percent is None:
        return None
    now = time.time()
    started = _phase1_timing.get(project_id)
    if not started or started[0] != step or percent < started[2]:
        _phase1_timing[project_id] = (step, now, percent)
        return None
    _, t0, p0 = started
    if percent - p0 < 0.5 or now - t0 < 5:
        return None
    return round((100 - percent) * (now - t0) / (percent - p0))


@app.get("/api/activity")
def activity():
    """Что сейчас идёт: скачивание/обработка видео и очереди Anki — с процентом и временем."""
    items = []
    for item in library.list_projects(DATA_DIR):
        if item["state"] == "processing":
            items.append({
                "kind": "phase1", "id": item["id"], "title": item["title"], "label": item["status"],
                "percent": item.get("percent"), "eta_seconds": _phase1_eta(item["id"], item["status"], item.get("percent")),
            })
        elif item["state"] == "ready":
            q = _stage3_status(project(item["id"]))
            if q["notes_left"]:
                done = item["notes_in_anki"]
                total = done + q["notes_left"]
                items.append({
                    "kind": "anki", "id": item["id"], "title": item["title"],
                    "label": "ждёт Anki (откройте Anki)" if q["state"] == "waiting_anki" else "выгрузка в Anki",
                    "percent": round(100 * done / total, 1) if total else None, "eta_seconds": q["eta_seconds"],
                })
    return items


# -- этап 3: очередь Anki -----------------------------------------------------------
#
# Кнопка "Anki" в редакторе помечает фрагменты exported (дальше только
# просмотр), а обработку (клипы + карточки) делает отдельный процесс
# phase3_export.worker — он переживает перезапуск редактора и обслуживает
# все видео по очереди.


def _spawn_worker() -> None:
    """Запускает фоновую очередь (второй экземпляр сам завершится, если первый уже работает)."""
    log = open(DATA_DIR / "stage3_worker.log", "a", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, "-m", "phase3_export.worker", "--data-dir", str(DATA_DIR)],
        cwd=str(REPO_DIR),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
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
    from phase3_export.worker import DEFAULT_SECONDS_PER_FRAME, STATUS_FILE, pending_fragments

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
    through_fragment_id: str


@app.post("/api/p/{project_id}/stage3/queue")
def queue_stage3(project_id: str, body: QueueRequest):
    from phase3_export.worker import default_deck

    p = project(project_id)
    try:
        manifest, queued = p.store.queue_for_stage3(body.through_fragment_id, default_deck(p.dir))
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error))
    _spawn_worker()
    return {"manifest": _public(manifest), "queued": queued, "stage3": _stage3_status(p, fresh=True)}


@app.get("/api/anki/overview")
def anki_overview():
    """Раздел Anki: по каждому готовому видео — сколько карточек и что в очереди."""
    result = []
    for item in library.list_projects(DATA_DIR):
        if item["state"] != "ready":
            continue
        item["stage3"] = _stage3_status(project(item["id"]))
        result.append(item)
    return result


@app.post("/api/anki/check")
def anki_check():
    """Карточки приложения (тип media-study) с любым флагом — кандидаты на доработку."""
    from phase3_export import anki

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


@app.post("/api/anki/return")
def anki_return(body: ReturnRequest):
    """Вернуть помеченные карточки на правку: их фрагменты снова редактируются в редакторе."""
    returned: dict[str, list[str]] = {}
    for item in body.items:
        returned.setdefault(item.project, []).append(item.fragment_id)
    for project_id, fragment_ids in returned.items():
        project(project_id).store.return_from_stage3(fragment_ids)
    return {"returned": {k: len(v) for k, v in returned.items()}}


# -- редактор одного видео ------------------------------------------------------------


class UpdateFragmentRequest(BaseModel):
    algo_start_frame: int | None = None
    algo_end_frame: int | None = None
    text: str | None = None
    needs_review: bool | None = None
    review_note: str | None = None


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
    return _public(p.store.load())


@app.patch("/api/p/{project_id}/fragments/{fragment_id}")
def update_fragment(project_id: str, fragment_id: str, body: UpdateFragmentRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.update_fragment(fragment_id, **body.model_dump()))
    return manifest.by_id(fragment_id).to_dict()


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
def soft_delete_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.soft_delete(fragment_id)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/restore")
def restore_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.restore(fragment_id)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/delete_final")
def hard_delete_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, nearest_left_id = _call(lambda: store.hard_delete(fragment_id))
    return {"manifest": _public(manifest), "nearest_left_fragment_id": nearest_left_id}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/merge")
def merge_fragment(project_id: str, fragment_id: str, body: MergeRequest):
    store = project(project_id).store
    manifest, merged_id = _call(lambda: store.merge(fragment_id, body.direction))
    return {"manifest": _public(manifest), "merged_fragment_id": merged_id}


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
app.mount("/media", StaticFiles(directory=str(DATA_DIR)), name="media")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
