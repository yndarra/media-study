# -*- coding: utf-8 -*-
"""Агент перевода и доводки по флагам Anki.

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import subprocess
import sys
import threading
import time

from fastapi import HTTPException
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, REPO_DIR, app, project
from .ingest import _priority_flag, _worker_env
from .stage3 import _anki_flags_cache
from .settings import _pid_alive
from .anki import ReturnRequest


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
