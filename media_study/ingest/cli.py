# -*- coding: utf-8 -*-
"""
CLI-точка входа Фазы 1.

Использование:
  py -3.12 -m media_study.ingest.cli <url> [--project-dir data/<id>] [--transcript file.txt]

Папка проекта по умолчанию — data/<код видео>. Повторный запуск продолжает с
места обрыва: скачанный мастер, копия для редактора и распознавание не
переделываются.
"""
import argparse
import json
import sys
from pathlib import Path

from .build_manifest import _extract_video_id, process_project


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Этап 1: добавить видео (по ссылке или своим файлом) и обработать его."
    )
    parser.add_argument("url", nargs="?", help="URL видео (всё, что поддерживает yt-dlp)")
    parser.add_argument("--project-dir", help="Папка проекта (по умолчанию data/<код видео>)")
    parser.add_argument("--file", help="Свой файл (видео или аудио) вместо ссылки")
    parser.add_argument("--only-add", action="store_true", help="Только добавить (скачать/принять), без обработки")
    parser.add_argument("--process", action="store_true", help="Только обработать уже добавленный проект --project-dir")
    parser.add_argument("--max-height", type=int, default=None, help="Скачивать не выше этой высоты кадра (1440 = 2K)")
    parser.add_argument(
        "--transcript",
        help="Путь к пользовательскому текстовому транскрипту без таймкодов (например, вики по игре); "
             "если указан, он используется вместо субтитров YouTube как источник канонического текста",
    )
    args = parser.parse_args()
    transcript_path = Path(args.transcript) if args.transcript else None

    if args.file:
        from .acquire import import_file, slug_for_file

        source = Path(args.file)
        project_dir = Path(args.project_dir) if args.project_dir else Path("data") / slug_for_file(source.name, source.stat().st_size)
        import_file(source, project_dir, source.name)
    elif args.process:
        if not args.project_dir:
            parser.error("--process требует --project-dir")
        project_dir = Path(args.project_dir)
    else:
        if not args.url:
            parser.error("нужна ссылка, --file или --process")
        project_dir = Path(args.project_dir) if args.project_dir else Path("data") / _extract_video_id(args.url)
        from .acquire import acquire_url, master_path

        # Уже скачанное (например, после обрыва) повторно не качается.
        if master_path(project_dir) is None or not (project_dir / "video_info.json").exists():
            acquire_url(args.url, project_dir, args.max_height or None)
    if args.only_add:
        print(f"Добавлено: {project_dir}")
        return

    manifest = process_project(project_dir, transcript_path)
    # Последнее обработанное видео — его по умолчанию открывают start.bat и др.
    (project_dir.parent / "current_project.txt").write_text(project_dir.name, encoding="utf-8")

    print(f"Готово: {len(manifest.fragments)} фрагментов")
    print(f"fps={manifest.video.fps}, total_frames={manifest.video.total_frames}")
    print(f"Источник текста: {manifest.video.subtitle_source}")
    flagged = sum(1 for f in manifest.fragments if f.needs_review)
    if flagged:
        print(f"Помечено needs_review: {flagged}")


def run() -> None:
    """main() + отметка ошибки в phase1_status.json: приложение покажет, что
    скачивание/обработка не получились, и их можно запустить снова."""
    try:
        main()
    except SystemExit:
        raise
    except BaseException as error:
        project_dir = _project_dir_from_args()
        if project_dir is not None:
            from media_study.core.progress import report

            status_path = project_dir / "phase1_status.json"
            step = (json.loads(status_path.read_text(encoding="utf-8")).get("step") if status_path.exists() else None) or ""
            what = "Не скачалось" if step in ("download", "") else "Не обработалось"
            report(project_dir, "failed", None, force=True)
            data = json.loads(status_path.read_text(encoding="utf-8"))
            data["label"] = f"{what} – запустите «Обработать» ещё раз"
            data["error"] = str(error)[:300]
            status_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        raise


def _project_dir_from_args() -> Path | None:
    args = sys.argv[1:]
    if "--project-dir" in args and args.index("--project-dir") + 1 < len(args):
        return Path(args[args.index("--project-dir") + 1])
    return None


if __name__ == "__main__":
    run()
