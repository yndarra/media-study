# -*- coding: utf-8 -*-
"""
Этап 3, первый шаг: готовые фрагменты -> папка с клипами и текстами.

Берутся первые N фрагментов редактора (в том порядке и с той нумерацией,
что видна в редакторе; уже вынесенные на этап 3 не считаются). Каждый живой
фрагмент с текстом превращается в клип, вырезанный из мастер-файла
(максимальное исходное качество) строго по его границам:
  - видео — ровно кадры [algo_start_frame, algo_end_frame);
  - звук — ровно по сэмплам тех же моментов (как слышно в редакторе).
Вырезать точно до кадра без перекодирования нельзя, поэтому клип сразу
кодируется в итоговый формат: H.265 (libx265, CRF 18 — без видимой потери
качества) в исходном разрешении (если клип вышел больше лимита Anki в 100 МБ
— в 2K, затем в Full HD) + AAC, контейнер MP4 (метка hvc1 — чтобы
играло и на устройствах Apple). Рядом кладётся текст фрагмента (.txt) и
пополняется общий список export/index.json.

Все первые N фрагментов (и удалённые, и тишина) помечаются exported — в
редакторе их больше нет, а пересборка этапа 1 их не трогает.

Использование:
  py -3.12 -m phase3_export.export_clips --project-dir data/<id> --through N
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from common.manifest_schema import Manifest, STATUS_ACTIVE, replace_file

# H.265 на видеокарте (NVENC): в ~3.5 раза быстрее x265 на процессоре. cq 30
# подобран на клипе Act 1 в 2K: SSIM 0.99904 против 0.99877 у прежнего
# x265 CRF 18 (то есть не хуже), файл примерно вдвое больше (~0.3 МБ/с).
VIDEO_ARGS = ["-c:v", "hevc_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "30", "-b:v", "0",
              "-spatial-aq", "1", "-temporal-aq", "1", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
# Если видеокарта недоступна (занята, драйвер) — прежнее кодирование на процессоре.
VIDEO_ARGS_CPU = ["-c:v", "libx265", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
                  "-x265-params", "log-level=error"]
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k"]
PREROLL_SECONDS = 2.0  # быстрый переход чуть раньше начала, дальше — точная обрезка фильтрами
# Клипы — не выше 2K (1440p); исходник ниже 2K не увеличивается. AnkiWeb не
# синхронизирует медиафайлы больше 100 МБ: клип, который вышел больше (с
# небольшим запасом), перекодируется в Full HD. Высоты кадра по порядку.
ANKI_FILE_LIMIT_BYTES = 95 * 1024 * 1024
FALLBACK_HEIGHTS = [1440, 1080]


def cut_clip(
    master: Path, audio_pcm: Path, out_path: Path, start_frame: int, end_frame: int, fps: float,
    height: int | None = None,
) -> None:
    """
    Точная вырезка [start_frame, end_frame).

    Видео: время в фильтре абсолютное (-copyts), берутся кадры, чьё время
    попадает в [start - полкадра, end - полкадра) — ровно нужные кадры без
    риска округления.

    Звук: не из мастера через перемотку (при перемотке внутрь Opus ffmpeg
    сдвигал его на ~7 мс), а готовым куском из audio.pcm — той самой
    дорожки, что звучит в редакторе, — вырезанным по сэмплам тех же границ.
    AAC дополняет последний блок тишиной до своего размера (несколько
    миллисекунд после границы) — чужого звука там нет.
    """
    import tempfile

    import imageio_ffmpeg

    from common.audio_track import sample_for_frame, wav_slice

    start = start_frame / fps
    end = end_frame / fps
    half = 0.5 / fps
    seek = max(0.0, start - PREROLL_SECONDS)
    # Уменьшение до height (если кадр выше) — с сохранением пропорций, ширина чётная.
    scale = f",scale=-2:'min({height},ih)':flags=lanczos" if height else ""
    wav, _ = wav_slice(audio_pcm, sample_for_frame(start_frame, fps), sample_for_frame(end_frame, fps))
    tmp_path = out_path.with_suffix(".tmp.mp4")
    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = Path(tmp_dir) / "audio.wav"
        wav_path.write_bytes(wav)
        def encode(video_args):
            subprocess.run(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y",
                    "-ss", f"{seek:.6f}", "-copyts", "-i", str(master),
                    "-i", str(wav_path),
                    "-filter_complex",
                    f"[0:v:0]trim=start={start - half:.6f}:end={end - half:.6f},setpts=PTS-STARTPTS{scale}[v]",
                    "-map", "[v]", "-map", "1:a:0",
                    "-r", f"{fps:.6f}", *video_args, *AUDIO_ARGS,
                    "-movflags", "+faststart", str(tmp_path),
                ],
                check=True,
            )

        try:
            encode(VIDEO_ARGS)
        except subprocess.CalledProcessError:
            print(f"    {out_path.name}: видеокарта не закодировала — кодирую на процессоре", flush=True)
            encode(VIDEO_ARGS_CPU)
    replace_file(tmp_path, out_path)


def cut_audio_clip(audio_pcm: Path, out_path: Path, start_frame: int, end_frame: int, fps: float) -> None:
    """Звуковой клип (для аудио без видео): те же сэмплы, что в редакторе, -> AAC в .m4a."""
    import tempfile

    import imageio_ffmpeg

    from common.audio_track import sample_for_frame, wav_slice

    wav, _ = wav_slice(audio_pcm, sample_for_frame(start_frame, fps), sample_for_frame(end_frame, fps))
    tmp_path = out_path.with_suffix(".tmp.m4a")
    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = Path(tmp_dir) / "audio.wav"
        wav_path.write_bytes(wav)
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-i", str(wav_path), *AUDIO_ARGS,
             "-movflags", "+faststart", str(tmp_path)],
            check=True,
        )
    replace_file(tmp_path, out_path)


def render_clip(master: Path, audio_pcm: Path, clip_path: Path, start_frame: int, end_frame: int, fps: float,
                audio_only: bool = False) -> int | None:
    """
    Клип не выше 2K; если он вышел больше лимита Anki — в Full HD.
    Возвращает предельную высоту кадра. Для аудио — звуковой клип (.m4a).
    """
    if audio_only:
        cut_audio_clip(audio_pcm, clip_path, start_frame, end_frame, fps)
        return None
    for height in FALLBACK_HEIGHTS:
        cut_clip(master, audio_pcm, clip_path, start_frame, end_frame, fps, height)
        if clip_path.stat().st_size <= ANKI_FILE_LIMIT_BYTES:
            return height
        print(f"    {clip_path.name}: {clip_path.stat().st_size / 2**20:.0f} МБ — больше лимита Anki, уменьшаю разрешение", flush=True)
    return height


def export(project_dir: Path, through: int) -> None:
    """
    Передаёт первые N фрагментов редактора на этап 3 и сразу обрабатывает
    очередь проекта (клипы + карточки Anki) — то же, что кнопка "добавить в
    Anki" в редакторе, только синхронно. Редактор при этом должен быть закрыт.
    """
    from .worker import Worker, default_deck

    project_dir = Path(project_dir)
    manifest_path = project_dir / "manifest.json"
    manifest = Manifest.load(manifest_path)
    pending = [f for f in manifest.fragments if not f.exported][:through]
    for fragment in pending:
        fragment.exported = True
    manifest.settings.setdefault("anki_deck", default_deck(project_dir))
    manifest.save(manifest_path)
    print(f"Передано на этап 3: {len(pending)} фрагментов. Колода: {manifest.settings['anki_deck']}", flush=True)
    Worker(project_dir.parent, project_dir).run()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Выносит первые N фрагментов редактора на этап 3 (клипы + тексты).")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--through", type=int, required=True, help="До какого фрагмента (номер в редакторе) включительно")
    args = parser.parse_args()
    export(Path(args.project_dir), args.through)
    print(f"Готово: клипы и тексты — в {Path(args.project_dir) / 'export'}")


if __name__ == "__main__":
    main()
