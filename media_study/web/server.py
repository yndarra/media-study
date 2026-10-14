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
import os
import threading

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from media_study.core.audio import build_audio_track
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


# -- маршруты API – по разделам в media_study/web/api/ -----------------------------
#
# Каждый раздел регистрирует свои маршруты на этот же app. Порядок –
# по зависимостям между разделами. Сервер перезагрузили (importlib.reload,
# так делают тесты с другой папкой data) – разделы тоже перечитываются,
# чтобы их маршруты встали на новый app и видели новый DATA_DIR.
import importlib  # noqa: E402

API_MODULES = ['ingest', 'stage3', 'system', 'settings', 'anki', 'media', 'stats', 'agent', 'editor']
for _name in API_MODULES:
    _module = importlib.import_module(f"media_study.web.api.{_name}")
    if getattr(_module, "app", None) is not app:
        importlib.reload(_module)

from media_study.web.api.stage3 import _load_anki_cache, _spawn_worker, _stage3_status  # noqa: E402
from media_study.web.api.agent import _ensure_batch_poller  # noqa: E402


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
