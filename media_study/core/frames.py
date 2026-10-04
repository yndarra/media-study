# -*- coding: utf-8 -*-
"""
Точная конвертация между номером кадра и временем.

Работает корректно только если видео пере-энкодировано в постоянный fps
(CFR) на этапе Фазы 1 (см. media_study/ingest/reencode.py). Для VFR-исходников
пересчёт по фиксированному fps даёт лишь приближение, поэтому весь конвейер
принудительно приводит источник к CFR перед тем, как считать номера кадров.
"""


def frames_for_seconds(seconds: float, fps: float) -> int:
    """Округляет секунды до ближайшего целого номера кадра при данном fps."""
    return round(seconds * fps)


def frame_to_seconds(frame: int, fps: float) -> float:
    """Возвращает время начала кадра в секундах."""
    return frame / fps


def clamp_frame(frame: int, low: int, high: int) -> int:
    """Ограничивает номер кадра диапазоном [low, high] включительно."""
    return max(low, min(frame, high))
