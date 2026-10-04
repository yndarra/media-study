# -*- coding: utf-8 -*-
"""
Сколько ресурсов отдавать обработке, чтобы система не захлёбывалась.

Настройка "Свободные ядра процессора" (data/settings.json, reserve_cpu_cores):
столько ядер распознавание речи (faster-whisper на процессоре) и
перекодирование (ffmpeg) не занимают. Сервер передаёт её фоновым процессам
через переменную окружения MEDIA_STUDY_RESERVE_CORES; запущенные вручную
(.bat) читают data/settings.json.

Пониженный приоритет (low_priority) — фоновые процессы запускаются с
приоритетом "ниже среднего": система и редактор отзывчивы, а простаивающие
ядра обработка всё равно использует.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ENV_RESERVE = "MEDIA_STUDY_RESERVE_CORES"
DEFAULT_RESERVE = 2


def reserve_cores() -> int:
    value = os.environ.get(ENV_RESERVE)
    if value is None:
        try:
            value = json.loads(Path("data/settings.json").read_text(encoding="utf-8")).get("reserve_cpu_cores")
        except (OSError, ValueError):
            value = None
    try:
        return max(0, int(value if value is not None else DEFAULT_RESERVE))
    except (TypeError, ValueError):
        return DEFAULT_RESERVE


def cpu_threads() -> int:
    """Сколько потоков дать тяжёлой обработке (не меньше одного)."""
    return max(1, (os.cpu_count() or 4) - reserve_cores())
