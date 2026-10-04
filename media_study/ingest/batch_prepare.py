# -*- coding: utf-8 -*-
"""
Пакетная подготовка видео из плейлиста: по порядку скачать и перекодировать
в копию для редактора (самые долгие шаги этапа 1). Распознавание, сверка с
источником и нарезка — потом, обычной обработкой видео (когда к нему
прикреплены ссылки на текст, например Notion).

  py -3.12 -m media_study.ingest.batch_prepare <плейлист> [--match "Main Quest"] [--group "Wuthering Waves"]
      [--first 7] [--last 7] [--max-height 1440]

- берутся только видео, в названии которых есть --match (по умолчанию
  "Main Quest": без Companion Story, ивентов и побочных квестов);
- --first N / --last N — только первые / последние N из подходящих (можно
  вместе: сначала первые, потом последние);
- --max-height — качество скачиваемого мастера (1440 = 2K);
- уже подготовленные (есть source.mp4) пропускаются — запуск можно повторять;
- перед каждым видео проверяется место на диске: если после него останется
  меньше --reserve-gb, очередь останавливается (4K-исходник + копия для
  редактора — около --gb-per-hour ГБ на час видео).
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

from .acquire import acquire_url, master_path
from . import reencode as reencode_mod

ROOT = Path(__file__).resolve().parents[2]
ATTEMPTS = 3


class _Tee:
    """Вывод и в окно, и в журнал data/batch_prepare.log (ошибки видно потом)."""

    def __init__(self, stream, path: Path):
        self.stream = stream
        self.file = open(path, "a", encoding="utf-8")

    def write(self, text):
        self.stream.write(text)
        self.file.write(text)
        self.file.flush()

    def flush(self):
        self.stream.flush()


def playlist_entries(url: str) -> list[dict]:
    """Список видео плейлиста без скачивания: [{id, title, duration}]."""
    out = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--flat-playlist", "-J", url],
        capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    return [
        {"id": e["id"], "title": e.get("title") or "", "duration": e.get("duration") or 0}
        for e in json.loads(out).get("entries", []) if e
    ]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Скачать и перекодировать видео плейлиста по порядку.")
    parser.add_argument("playlist")
    parser.add_argument("--match", default="Main Quest", help="Брать видео, в названии которых есть это")
    parser.add_argument("--group", default=None, help="Группа (канал/игра) для библиотеки")
    parser.add_argument("--data-dir", default=str(ROOT / "data"))
    parser.add_argument("--reserve-gb", type=float, default=30.0)
    parser.add_argument("--gb-per-hour", type=float, default=12.5)
    parser.add_argument("--first", type=int, default=None, help="Только первые N подходящих видео")
    parser.add_argument("--last", type=int, default=None, help="Только последние N подходящих видео")
    parser.add_argument("--max-height", type=int, default=None, help="Не выше этой высоты кадра (1440 = 2K)")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    sys.stdout = sys.stderr = _Tee(sys.stdout, data_dir / "batch_prepare.log")
    print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} запуск ===", flush=True)

    entries = [e for e in playlist_entries(args.playlist) if args.match.lower() in e["title"].lower()]
    if args.first is not None or args.last is not None:
        chosen = entries[: args.first or 0]
        chosen += [e for e in entries[len(entries) - (args.last or 0):] if e not in chosen] if args.last else []
        entries = chosen
    print(f"Видео в очереди: {len(entries)} ({sum(e['duration'] for e in entries) / 3600:.1f} ч)", flush=True)
    for number, entry in enumerate(entries, 1):
        project_dir = data_dir / entry["id"]
        title = f"[{number}/{len(entries)}] {entry['title']}"
        if (project_dir / "source.mp4").exists() and (project_dir / "video_info.json").exists():
            print(f"{title}: уже готово", flush=True)
            continue
        need_gb = entry["duration"] / 3600 * args.gb_per_hour
        free_gb = shutil.disk_usage(data_dir).free / 1024 ** 3
        if free_gb - need_gb < args.reserve_gb:
            print(f"{title}: СТОП — места мало (свободно {free_gb:.0f} ГБ, нужно ~{need_gb:.0f} ГБ "
                  f"+ запас {args.reserve_gb:.0f} ГБ). Освободите место и запустите снова.", flush=True)
            return
        started = time.time()
        if args.group and not (project_dir / "project.json").exists():
            project_dir.mkdir(parents=True, exist_ok=True)
            (project_dir / "project.json").write_text(
                json.dumps({"group": args.group}, ensure_ascii=False, indent=2), encoding="utf-8")
        # Сбой (сеть, YouTube) не валит всю очередь: до ATTEMPTS попыток,
        # потом — к следующему видео (повторный запуск доделает пропущенное).
        for attempt in range(1, ATTEMPTS + 1):
            try:
                if master_path(project_dir) is None or not (project_dir / "video_info.json").exists():
                    print(f"{title}: скачиваю (~{need_gb:.0f} ГБ на диске после перекодирования)", flush=True)
                    acquire_url(f"https://www.youtube.com/watch?v={entry['id']}", project_dir, args.max_height)
                print(f"{title}: перекодирую в копию для редактора", flush=True)
                reencode_mod.ingest_source_video(master_path(project_dir), project_dir / "source.mp4")
                print(f"{title}: готово за {(time.time() - started) / 60:.0f} мин", flush=True)
                break
            except Exception:
                print(f"{title}: ОШИБКА (попытка {attempt}/{ATTEMPTS}):\n{traceback.format_exc()}", flush=True)
                if attempt < ATTEMPTS:
                    time.sleep(30)
        else:
            print(f"{title}: пропускаю после {ATTEMPTS} неудачных попыток", flush=True)
    print("Очередь пройдена.", flush=True)


if __name__ == "__main__":
    main()
