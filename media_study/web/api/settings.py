# -*- coding: utf-8 -*-
"""Настройки приложения, модели, распознавание речи, счётчики меню, «Сейчас идёт».

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import json
import os
import threading
import time

from fastapi import HTTPException
from pathlib import Path
from pydantic import BaseModel

from media_study.web import library
from ..server import DATA_DIR, _recolor, app, project
from .stage3 import _stage3_status


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
    from .. import storage

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
