# -*- coding: utf-8 -*-
"""
Доводка конца фразы на стыке двух фраз без паузы.

Когда по распознаванию (faster-whisper) следующая фраза начинается вплотную к
концу предыдущей (паузы между словами нет или они "наезжают"), граница
ставится по концу последнего слова – а он у whisper обычно обрезан: по
правкам пользователя на таких стыках граница в 19% случаев сдвигалась, почти
всегда вправо (191 раз вправо против 16 влево, медиана +0,3 с). На стыках с
паузой правок мало и в обе стороны – их не трогаем.

Что делается: на таком стыке смотрим громкость звука (audio.pcm) от границы
до +REFINE_SECONDS. Если на самой границе звучит речь (громче тихой ложбины
дальше хотя бы в GATE раз), граница переезжает в начало этой ложбины –
естественную паузу между фразами. Если граница уже в тишине – не трогаем.
Дальше начала второго слова следующей фразы граница не уходит (чтобы не
отрезать ей начало).

Проверено на правках пользователя (1076 стыков без паузы, 207 поправленных):
стало точнее 111, хуже 7; медианная ошибка 0,32 с -> 0,21 с.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from media_study.core.audio import AUDIO_CHANNELS, AUDIO_RATE
from media_study.core.context_bounds import context_for

REFINE_SECONDS = 0.4  # насколько далеко вправо искать паузу
GATE = 2.0  # граница "на звуке": громче минимума окна во столько раз
NEAR_MIN = 0.5  # начало ложбины: первая точка не громче минимума * (1 + NEAR_MIN)
HOP = 0.01  # шаг громкости, с


def _loudness(pcm: np.ndarray, t0: float, t1: float) -> np.ndarray:
    """Громкость (RMS) по 10 мс от t0 до t1, сглаженная по 30 мс."""
    a, b = max(0, int(t0 * AUDIO_RATE)), min(len(pcm), int(t1 * AUDIO_RATE))
    n = int(HOP * AUDIO_RATE)
    x = pcm[a:b].astype(np.float32)
    k = len(x) // n
    if k < 5:
        return np.array([])
    rms = np.sqrt((x[: k * n].reshape(k, n) ** 2).mean(axis=1) + 1e-9)
    return np.convolve(rms, np.ones(3) / 3, mode="same")


def refine_touching_ends(manifest, audio_path: Path, words: dict, log=print) -> int:
    """
    Сдвигает общие границы фраз на стыках без паузы (см. описание модуля).
    words – слова распознавания по id ({"start", "end"}). Возвращает число сдвигов.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        return 0
    raw = np.memmap(audio_path, dtype=np.int16, mode="r")
    pcm = raw[: len(raw) // AUDIO_CHANNELS * AUDIO_CHANNELS].reshape(-1, AUDIO_CHANNELS).mean(axis=1)
    fps = manifest.video.fps
    total = manifest.video.total_frames
    padding = float(manifest.settings.get("context_padding_seconds", 3.0))
    frags = manifest.fragments
    moved = 0
    for a, b in zip(frags, frags[1:]):
        if not a.text.strip() or not b.text.strip() or a.algo_end_frame != b.algo_start_frame:
            continue
        wa = [words[i] for i in a.source_segment_ids if i in words]
        wb = sorted((words[i] for i in b.source_segment_ids if i in words), key=lambda w: w["start"])
        if not wa or not wb or wb[0]["start"] - max(w["end"] for w in wa) > 0:
            continue  # между фразами есть пауза – граница и так в ней
        edge = a.algo_end_frame / fps
        curve = _loudness(pcm, edge - 0.03, edge + REFINE_SECONDS)
        if not len(curve):
            continue
        low = curve.min()
        if curve[3] < GATE * low:
            continue  # граница уже в тишине
        idx = int(np.argmax(curve <= low * (1 + NEAR_MIN) + 1e-9))
        new_time = edge - 0.03 + idx * HOP + HOP / 2
        # Не дальше начала второго слова следующей фразы (и не дальше её конца).
        limit = wb[1]["start"] if len(wb) > 1 else b.algo_end_frame / fps
        new_frame = min(int(round(new_time * fps)), int(limit * fps), b.algo_end_frame - 1)
        if new_frame <= a.algo_end_frame:
            continue
        a.algo_end_frame = a.original_algo_end_frame = new_frame
        b.algo_start_frame = b.original_algo_start_frame = new_frame
        for f in (a, b):
            f.context_start_frame, f.context_end_frame = context_for(
                f.algo_start_frame, f.algo_end_frame, total, fps, padding)
        moved += 1
    log(f"Конец фраз на стыках без паузы: сдвинуто {moved}")
    return moved
