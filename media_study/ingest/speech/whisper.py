# -*- coding: utf-8 -*-
"""
Распознавание слов через faster-whisper с пословными таймкодами.

Настройки повторяют то, что раньше сработало на песнях (карточки FRIENDS,
сделанные до этого проекта):
vad_filter=False — VAD оказался слишком агрессивным и вырезал часть
контента; вместо него используются пороги no_speech/log_prob/compression,
чтобы не терять тихие или невнятные фразы.
"""
from pathlib import Path
import json

from faster_whisper import WhisperModel


def transcribe(video_path: Path, model_size: str = "medium.en") -> dict:
    """
    Возвращает {"duration": float, "language": str, "segments": [...]}, где
    каждый segment содержит "start", "end", "text" и список "words" с их
    собственными "start"/"end" в секундах (конвертация в номера кадров —
    отдельным шагом, после того как известен точный fps пере-энкодированного
    источника).
    """
    from media_study.web.library import app_settings

    from .whisper_models import load_model

    # Модель и устройство (процессор / видеокарта, бережно) – из настроек
    # (speech/whisper_models.py); на процессоре – не на всех ядрах.
    from media_study.core.lang import speech_lang

    settings = dict(app_settings(Path(video_path).parent.parent))
    settings.setdefault("whisper_model", model_size)
    language = speech_lang(Path(video_path).parent)
    if language != "en" and (settings["whisper_model"].endswith(".en") or settings["whisper_model"].startswith("distil")):
        print(f"Модель {settings['whisper_model']} – только английский; для языка {language} – large-v3", flush=True)
        settings["whisper_model"] = "large-v3"
    model, device, duty = load_model(settings, log=lambda m: print(m, flush=True))
    segments_iter, info = model.transcribe(
        str(video_path),
        language=language,
        beam_size=5,
        vad_filter=False,
        word_timestamps=True,
        condition_on_previous_text=False,
        no_speech_threshold=0.35,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.8,
    )

    from media_study.core.progress import report

    rows = []
    import time

    last = time.monotonic()
    for index, segment in enumerate(segments_iter, start=1):
        # Ограничение нагрузки на видеокарту: после куска – пауза, чтобы
        # видеокарта работала только долю duty времени (50% – пауза = работе).
        if duty < 1:
            worked = time.monotonic() - last
            time.sleep(min(10.0, worked * (1 / duty - 1)))
            last = time.monotonic()
        # Распознавание идёт по порядку — процент по концу последней фразы.
        if info.duration:
            report(Path(video_path).parent, "transcribe", 100.0 * segment.end / info.duration)
        words = [
            {"start": float(word.start), "end": float(word.end), "word": word.word.strip()}
            for word in (segment.words or [])
            if word.word.strip()
        ]
        rows.append({
            "index": index,
            "start": float(segment.start),
            "end": float(segment.end),
            "text": segment.text.strip(),
            "words": words,
        })

    return {"duration": float(info.duration), "language": info.language, "segments": rows}


def transcribe_and_save(video_path: Path, output_path: Path, model_size: str = "medium.en") -> dict:
    """
    Распознаёт видео и сохраняет сырой результат для аудита/переиспользования.
    Если результат уже сохранён (этап 1 перезапущен после обрыва) —
    распознавание, самый долгий шаг, не повторяется.
    """
    if output_path.exists():
        print("Распознавание уже сделано — беру готовый результат.", flush=True)
        return json.loads(output_path.read_text(encoding="utf-8"))
    result = None
    # Движок – из настроек: "whisper" (локально, по умолчанию) или
    # "elevenlabs" (Scribe по API, точнее). ElevenLabs не сработал (нет
    # ключа/сети/доступа) – не падаем, распознаём локально.
    from .elevenlabs import ElevenLabsError, settings, transcribe as transcribe_el

    if settings(Path(video_path).parent.parent).get("asr_engine") == "elevenlabs":
        try:
            result = transcribe_el(Path(video_path), log=lambda m: print(m, flush=True))
        except (ElevenLabsError, OSError) as error:
            print(f"ElevenLabs не смог: {error} — распознаю локально (whisper).", flush=True)
    if result is None:
        result = transcribe(video_path, model_size=model_size)
    tmp_path = output_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(output_path)
    return result
