# -*- coding: utf-8 -*-
"""
Распознавание речи через ElevenLabs Speech-to-Text (модель Scribe) – второй
движок вместо локального faster-whisper (настройка "asr_engine").

Что делается:
  1. из копии для редактора вынимается только звук (моно Opus 64 кбит/с –
     в разы меньше видео, качество для распознавания то же) – его и
     отправляем, а не гигабайты видео;
  2. POST https://api.elevenlabs.io/v1/speech-to-text (заголовок xi-api-key)
     с model_id (по умолчанию scribe_v2 – самая точная), пословными
     таймкодами, разметкой говорящих и – по желанию – keyterms: имена и
     термины из словаря группы (data/glossary/<автор>.json), их модель
     узнаёт точнее (ElevenLabs берёт за это +20% к цене);
  3. ответ (слова с start/end) приводится к тому же виду, что у whisper
     (whisper_transcript.json: сегменты со словами), – дальше конвейер не
     знает, каким движком распознано.

ElevenLabs недоступен из некоторых стран (запрос уводит на страницу об
ограничениях) – тогда нужен VPN или прокси (настройка "elevenlabs_proxy":
http://… или socks5://…). Ключ – secrets/elevenlabs_key.txt в корне проекта
(вписывается в "Настройках").
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

API_URL = "https://api.elevenlabs.io/v1/speech-to-text"
CHECK_URL = "https://api.elevenlabs.io/v1/user"
DEFAULT_MODEL = "scribe_v2"
from media_study.core.secrets import ELEVENLABS_KEY as KEY_PATH
# Новая фраза (сегмент) – после конца предложения или паузы дольше этого.
SEGMENT_GAP = 0.8
MAX_KEYTERMS = 100  # больше 100 – у ElevenLabs минимальная оплата 20 с на запрос


class ElevenLabsError(RuntimeError):
    pass


def settings(data_dir: Path) -> dict:
    from media_study.web.library import app_settings

    return app_settings(Path(data_dir))


def api_key(data_dir: Path | None = None) -> str:
    from media_study.core.secrets import read

    return read(KEY_PATH)


def _proxies(data_dir: Path) -> dict | None:
    proxy = (settings(data_dir).get("elevenlabs_proxy") or "").strip()
    return {"http": proxy, "https": proxy} if proxy else None


def _blocked(response) -> bool:
    """Запрос увели на страницу "сервис недоступен в вашей стране"."""
    location = response.headers.get("location", "")
    return response.status_code in (301, 302, 303, 307) and "help.elevenlabs.io" in location


def check(data_dir: Path) -> dict:
    """Проверка ключа и доступа (кнопка в настройках): {"ok", "message"}."""
    import requests

    key = api_key(data_dir)
    if not key:
        return {"ok": False, "message": "Ключ не задан"}
    try:
        r = requests.get(CHECK_URL, headers={"xi-api-key": key}, proxies=_proxies(data_dir), timeout=20, allow_redirects=False)
    except requests.RequestException as error:
        return {"ok": False, "message": f"Нет связи: {error}"[:300]}
    if _blocked(r):
        return {"ok": False, "message": "ElevenLabs недоступен из вашей страны – включите VPN или укажите прокси"}
    if r.status_code == 401:
        return {"ok": False, "message": "Ключ не подходит (401)"}
    if r.status_code != 200:
        return {"ok": False, "message": f"Ответ {r.status_code}: {r.text[:200]}"}
    data = r.json()
    sub = data.get("subscription") or {}
    left = None
    if sub.get("character_limit") is not None and sub.get("character_count") is not None:
        left = sub["character_limit"] - sub["character_count"]
    tier = sub.get("tier") or "?"
    return {"ok": True, "message": f"Работает: тариф {tier}" + (f", осталось кредитов {left:,}".replace(",", " ") if left is not None else "")}


def _extract_audio(video_path: Path, out_path: Path) -> None:
    from imageio_ffmpeg import get_ffmpeg_exe

    subprocess.run([get_ffmpeg_exe(), "-v", "error", "-y", "-i", str(video_path), "-vn", "-ac", "1",
                    "-c:a", "libopus", "-b:a", "64k", str(out_path)], check=True)


def _keyterms(project_dir: Path) -> list[str]:
    """Имена и термины из словаря группы (до MAX_KEYTERMS), в виде, который примет ElevenLabs."""
    import re

    from media_study.export.translator import load_glossary

    terms = []
    for term in load_glossary(Path(project_dir).parent, Path(project_dir)):
        term = re.sub(r"[<>{}\[\]\\]", "", str(term)).strip()
        if term and len(term) < 50 and len(term.split()) <= 5 and term not in terms:
            terms.append(term)
    return terms[:MAX_KEYTERMS]


def _to_whisper_format(reply: dict) -> dict:
    """Ответ ElevenLabs -> {"duration", "language", "segments": [{start, end, text, words}]}."""
    words = [w for w in reply.get("words", []) if w.get("type", "word") == "word" and (w.get("text") or "").strip()]
    segments, current = [], []

    def flush():
        if current:
            segments.append({
                "index": len(segments) + 1,
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "text": " ".join(w["word"] for w in current),
                "words": list(current),
            })
            current.clear()

    previous_end = None
    for w in words:
        word = {"start": float(w.get("start") or 0.0), "end": float(w.get("end") or w.get("start") or 0.0),
                "word": w["text"].strip()}
        if w.get("speaker_id"):
            word["speaker_id"] = w["speaker_id"]
        if current and (word["start"] - previous_end > SEGMENT_GAP or current[-1]["word"][-1:] in ".?!…"):
            flush()
        current.append(word)
        previous_end = word["end"]
    flush()
    duration = reply.get("audio_duration_secs") or (segments[-1]["end"] if segments else 0.0)
    return {"duration": float(duration), "language": reply.get("language_code") or "", "segments": segments,
            "engine": "elevenlabs", "model": reply.get("_model")}


def transcribe(video_path: Path, log=print) -> dict:
    """Распознать звук видео через ElevenLabs. Ошибки – ElevenLabsError."""
    import requests

    from media_study.core.progress import report

    video_path = Path(video_path)
    project_dir = video_path.parent
    data_dir = project_dir.parent
    cfg = settings(data_dir)
    key = api_key(data_dir)
    if not key:
        raise ElevenLabsError("ключ ElevenLabs не задан (Настройки → Распознавание речи)")
    model = (cfg.get("elevenlabs_model") or DEFAULT_MODEL).strip()
    report(project_dir, "transcribe", None, force=True)
    with tempfile.TemporaryDirectory() as tmp:
        audio = Path(tmp) / "audio.ogg"
        _extract_audio(video_path, audio)
        fields = [("model_id", model), ("timestamps_granularity", "word"), ("diarize", "true"),
                  ("tag_audio_events", "false")]
        language = (cfg.get("elevenlabs_language") or "").strip()
        if language:
            fields.append(("language_code", language))
        if cfg.get("elevenlabs_keyterms", True):
            terms = _keyterms(project_dir)
            fields += [("keyterms", t) for t in terms]
            if terms:
                log(f"ElevenLabs: подсказка терминов – {len(terms)}")
        size = audio.stat().st_size / 2**20
        log(f"ElevenLabs ({model}): отправляю звук {size:.1f} МБ…")
        try:
            with open(audio, "rb") as f:
                r = requests.post(API_URL, headers={"xi-api-key": key}, data=fields,
                                  files={"file": ("audio.ogg", f, "audio/ogg")},
                                  proxies=_proxies(data_dir), timeout=3600, allow_redirects=False)
        except requests.RequestException as error:
            raise ElevenLabsError(f"нет связи с ElevenLabs: {error}")
    if _blocked(r):
        raise ElevenLabsError("ElevenLabs недоступен из вашей страны – нужен VPN или прокси (Настройки)")
    if r.status_code != 200:
        raise ElevenLabsError(f"ElevenLabs ответил {r.status_code}: {r.text[:300]}")
    reply = r.json()
    reply["_model"] = model
    result = _to_whisper_format(reply)
    log(f"ElevenLabs: распознано {len(result['segments'])} фраз, {sum(len(s['words']) for s in result['segments'])} слов, "
        f"{round(result['duration'] / 60, 1)} мин звука")
    return result
