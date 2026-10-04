# -*- coding: utf-8 -*-
"""
Звуковая волна для дорожки редактора: один байт (0..255) на каждый кадр
видео — пиковая громкость звука внутри этого кадра. Разрешение "по кадру"
совпадает с шагом редактора, поэтому на дорожке видно, где именно
начинается и заканчивается речь относительно маркеров.

Файл waveform.bin лежит рядом с source.mp4 и отдаётся браузеру как есть.
"""
from pathlib import Path
import subprocess

import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe

SAMPLE_RATE = 8000


def build_waveform(media_path: Path, out_path: Path, fps: float, total_frames: int) -> None:
    ffmpeg = get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(media_path),
         "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        capture_output=True,
    )
    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.int32)
    peaks = np.zeros(total_frames, dtype=np.float64)

    # У видео без звуковой дорожки ffmpeg ничего не отдаёт — волна остаётся нулевой.
    if samples.size:
        samples = np.abs(samples)
        edges = np.round(np.arange(total_frames + 1) * SAMPLE_RATE / fps).astype(np.int64)
        edges = np.clip(edges, 0, samples.size)
        # Кадры, целиком выходящие за конец аудио, пропускаются (остаются нулями).
        valid = edges[:-1] < edges[1:]
        starts = edges[:-1][valid]
        peaks[valid] = np.maximum.reduceat(samples, starts)[: valid.sum()] if starts.size else 0

    # Нормируем по 99.5-му перцентилю, а не по абсолютному максимуму, чтобы
    # один громкий хлопок не сделал всю остальную волну плоской.
    reference = np.percentile(peaks[peaks > 0], 99.5) if np.any(peaks > 0) else 1.0
    scaled = np.clip(peaks / max(reference, 1.0), 0.0, 1.0)
    Path(out_path).write_bytes((scaled * 255).astype(np.uint8).tobytes())
