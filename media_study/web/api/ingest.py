# -*- coding: utf-8 -*-
"""Добавить и обработать (этап 1): скачивание, свой файл, наборы, источники, запуск.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import json
import os
import subprocess
import sys

from fastapi import HTTPException, Request
from pathlib import Path
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, REPO_DIR, app, project


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
    from .. import storage

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
    from .. import storage

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
    from .. import storage

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
