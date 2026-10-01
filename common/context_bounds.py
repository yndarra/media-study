# -*- coding: utf-8 -*-
"""
Границы контекста (запаса) фрагмента.

Фрагмент = запас до исходного отрезка + сам отрезок + запас после. Запас
намеренно захватывает соседние фразы — именно для того, чтобы при правке
границ было слышно и видно, что стоит по обе стороны. Обрезается запас
только краями самого видео (у первого и последнего фрагмента минуты
просто неоткуда взять — тогда берётся максимум доступного).

Контекст считается один раз при создании фрагмента от его исходных
границ и дальше не меняется: окно дорожки в редакторе не должно "ездить"
от того, что пользователь двигает маркеры внутри него.
"""
from common.frame_time import frames_for_seconds

CONTEXT_PADDING_SECONDS = 3.0  # значение по умолчанию; проектное — в settings манифеста


def context_for(
    start_frame: int,
    end_frame: int,
    total_frames: int,
    fps: float,
    padding_seconds: float = CONTEXT_PADDING_SECONDS,
) -> tuple[int, int]:
    """Возвращает (context_start_frame, context_end_frame) для отрезка [start, end)."""
    padding = frames_for_seconds(padding_seconds, fps)
    return max(0, start_frame - padding), min(total_frames, end_frame + padding)
