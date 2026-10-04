# -*- coding: utf-8 -*-
"""
Пере-энкодинг скачанного видео в формат, удобный для точного покадрового
посика в браузере.

Обычный <video> в браузере не гарантирует точный переход на конкретный кадр
для видео с длинным GOP и B-кадрами: посик сначала находит ближайший
keyframe и лишь потом декодирует вперёд. Чтобы шаг "покадрово" в редакторе
всегда попадал именно на нужный кадр (и делал это быстро), исходник
пере-энкодируется в all-intra H.264 с постоянным fps: каждый кадр — это
самостоятельный keyframe, посик на любой кадр не требует декодирования
соседей. Плата за это — заметно больший размер файла, что для типичных
роликов (диалоги, катсцены) остаётся приемлемым.
"""
from pathlib import Path
import re
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe

from media_study.core.resources import cpu_threads


_FPS_RE = re.compile(r",\s*([\d.]+)\s*fps")
_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")
_FRAME_RE = re.compile(r"frame=\s*(\d+)")
_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
_SIZE_RE = re.compile(r"Video: .*?(\d{2,5})x(\d{2,5})")

# Копия для редактора не больше 720p: all-intra в 4K даёт ~70 Мбит/с, и
# браузер начинает захлёбываться при быстрой перемотке. Покадровая
# точность от разрешения не зависит, а мастер в полном качестве остаётся
# отдельным файлом для экспорта.
EDITOR_MAX_HEIGHT = 720


def probe_source(input_path: Path) -> dict:
    """
    Достаёт fps и длительность из stderr ffmpeg (ffprobe не входит в
    imageio-ffmpeg — используем сам ffmpeg с флагом информации о потоках).
    """
    ffmpeg = get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(input_path)],
        capture_output=True,
        text=True,
    )
    # ffmpeg всегда завершается с ненулевым кодом, если не указан выходной
    # файл — это ожидаемо, нужный нам вывод лежит в stderr.
    stderr = result.stderr
    fps_match = _FPS_RE.search(stderr)
    duration_match = _DURATION_RE.search(stderr)
    if not fps_match or not duration_match:
        raise RuntimeError(f"не удалось разобрать вывод ffmpeg -i:\n{stderr}")
    fps = float(fps_match.group(1))
    hours, minutes, seconds = duration_match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    size_match = _SIZE_RE.search(stderr)
    width, height = (int(size_match.group(1)), int(size_match.group(2))) if size_match else (0, 0)
    return {"fps": fps, "duration": duration, "width": width, "height": height}


def count_frames(path: Path) -> int:
    """Точное число кадров готового файла: демукс без декодирования — секунды."""
    ffmpeg = get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path), "-map", "0:v:0", "-c", "copy", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    frame_matches = _FRAME_RE.findall(result.stderr)
    if result.returncode != 0 or not frame_matches:
        raise RuntimeError(f"не удалось посчитать кадры {path}:\n{result.stderr[-2000:]}")
    return int(frame_matches[-1])


def make_editing_proxy(
    input_path: Path,
    output_path: Path,
    fps: float,
    crf: int = 20,
    preset: str = "veryfast",
    audio_only: bool = False,
) -> int:
    """
    Делает копию для редактора: постоянный fps, GOP=1 (all-intra), без
    B-кадров, высота не больше EDITOR_MAX_HEIGHT. Пишет во временный файл
    и подменяет результат только после успешного завершения ffmpeg.
    Возвращает точное число кадров по прогресс-выводу самого ffmpeg.
    """
    ffmpeg = get_ffmpeg_exe()
    output_path = Path(output_path)
    tmp_path = output_path.with_name(output_path.stem + ".tmp" + output_path.suffix)
    if audio_only:
        # У аудио нет картинки — для редактора делается видео с чёрным кадром
        # той же длины: так дорожка, покадровая перемотка и остановки работают
        # без отдельной ветки кода.
        source_args = ["-f", "lavfi", "-i", f"color=c=black:s=640x360:r={fps}", "-i", str(input_path),
                       "-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    else:
        source_args = ["-i", str(input_path), "-map", "0:v:0", "-map", "0:a:0?",
                       "-vf", f"scale=-2:'min({EDITOR_MAX_HEIGHT},ih)'"]
    command = [
        ffmpeg, "-y",
        *source_args,
        "-r", f"{fps}",
        "-fps_mode", "cfr",
        "-g", "1",
        "-bf", "0",
        "-x264-params", "keyint=1:min-keyint=1:scenecut=0",
        "-threads", str(cpu_threads()),  # не на всех ядрах (настройка "свободные ядра")
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        str(tmp_path),
    ]
    # ffmpeg читается по ходу работы: из строк "time=..." считается процент
    # для библиотеки (копия часового видео делается долго).
    from media_study.core.progress import report

    from .acquire import media_streams

    duration = media_streams(input_path)["duration"] or 0
    process = subprocess.Popen(command, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, errors="replace")
    tail = []
    buffer = ""
    while True:
        chunk = process.stderr.read(4096)
        if not chunk:
            break
        buffer += chunk
        parts = buffer.replace("\r", "\n").split("\n")
        buffer = parts.pop()
        for line in parts:
            tail.append(line)
            match = _TIME_RE.search(line)
            if match and duration:
                h, m, sec = match.groups()
                report(output_path.parent, "proxy", 100.0 * (int(h) * 3600 + int(m) * 60 + float(sec)) / duration)
        del tail[:-400]
    tail.append(buffer)
    stderr = "\n".join(tail)
    if process.wait() != 0:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg завершился с ошибкой:\n{stderr[-3000:]}")
    frame_matches = _FRAME_RE.findall(stderr)
    if not frame_matches:
        raise RuntimeError(f"не удалось определить число кадров результата:\n{stderr[-3000:]}")
    tmp_path.replace(output_path)
    return int(frame_matches[-1])


def ingest_source_video(master_path: Path, proxy_path: Path) -> dict:
    """
    Из мастер-файла (максимальное качество) делает копию для редактора и
    возвращает точные {fps, total_frames} этой копии для манифеста.
    """
    from .acquire import media_streams

    audio_only = not media_streams(master_path)["has_video"]
    # У аудио нет своей частоты кадров — берётся 30: это лишь шаг, с которым
    # редактор двигает границы (1/30 с).
    fps = 30.0 if audio_only else probe_source(master_path)["fps"]
    # Копия пишется через временный файл и переименовывается только готовой,
    # поэтому существующая копия — целая: при повторном запуске этапа 1
    # (например, после обрыва на распознавании) она не пересоздаётся.
    if Path(proxy_path).exists():
        print("Копия для редактора уже есть — пропускаю кодирование.", flush=True)
        return {"fps": fps, "total_frames": count_frames(proxy_path)}
    total_frames = make_editing_proxy(master_path, proxy_path, fps=fps, audio_only=audio_only)
    return {"fps": fps, "total_frames": total_frames}
