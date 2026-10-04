# -*- coding: utf-8 -*-
"""
Звуковая дорожка проекта для точного по сэмплу воспроизведения в редакторе.

Звук через обычный <video> в браузере нельзя остановить точно: после паузы
в звуковом выводе ещё остаются накопленные десятки миллисекунд, и сколько
именно — зависит от момента. Поэтому редактор играет звук сам (Web Audio),
а видео показывает без звука. Для этого звук один раз извлекается в
несжатый файл audio.pcm (16 бит, 48 кГц, стерео, без заголовка), а сервер
отдаёт из него кусок ровно на окно фрагмента в виде WAV — вырезать кусок
из несжатого звука можно мгновенно и с точностью до сэмпла.

Источник — мастер-файл (оригинальный звук), если он есть; иначе копия для
редактора.
"""
from pathlib import Path
import struct
import subprocess

AUDIO_RATE = 48000
AUDIO_CHANNELS = 2
SAMPLE_BYTES = 2  # 16 бит
FRAME_BYTES = AUDIO_CHANNELS * SAMPLE_BYTES  # байт на один сэмпл всех каналов


def build_audio_track(media_path: Path, out_path: Path) -> None:
    """Извлекает звук в audio.pcm (через временный файл — прерванная запись не оставит обрывок)."""
    import imageio_ffmpeg

    out_path = Path(out_path)
    tmp_path = out_path.with_suffix(".pcm.tmp")
    subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y",
            "-i", str(media_path),
            "-map", "0:a:0", "-vn",
            "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_RATE),
            "-f", "s16le", "-c:a", "pcm_s16le",
            str(tmp_path),
        ],
        check=True,
    )
    tmp_path.replace(out_path)


def total_samples(pcm_path: Path) -> int:
    return Path(pcm_path).stat().st_size // FRAME_BYTES


def sample_for_frame(frame: int, fps: float) -> int:
    """Сэмпл, с которого начинается кадр."""
    return round(frame / fps * AUDIO_RATE)


def wav_slice(pcm_path: Path, start_sample: int, end_sample: int) -> tuple[bytes, int]:
    """
    Кусок звука [start_sample, end_sample) в виде готового WAV-файла.
    Границы прижимаются к длине дорожки. Возвращает (wav, фактический
    начальный сэмпл).
    """
    total = total_samples(pcm_path)
    start_sample = max(0, min(start_sample, total))
    end_sample = max(start_sample, min(end_sample, total))
    with open(pcm_path, "rb") as source:
        source.seek(start_sample * FRAME_BYTES)
        data = source.read((end_sample - start_sample) * FRAME_BYTES)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(data), b"WAVE",
        b"fmt ", 16, 1, AUDIO_CHANNELS, AUDIO_RATE,
        AUDIO_RATE * FRAME_BYTES, FRAME_BYTES, SAMPLE_BYTES * 8,
        b"data", len(data),
    )
    return header + data, start_sample
