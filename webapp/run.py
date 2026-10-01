# -*- coding: utf-8 -*-
"""
CLI-запуск веб-приложения (библиотека видео, редактор, Anki, скачивание).

Использование:
  py -3.12 -m webapp.run [--data-dir data] [--port 8000]
  (старый вариант --project-dir data/<id> тоже работает: берётся его папка data)
"""
import argparse
import logging
import os


class _QuietPolling(logging.Filter):
    """Не пишет в журнал служебные опросы открытой вкладки (раз в секунду)."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return "/api/heartbeat" not in message and "/api/clients" not in message


def main() -> None:
    parser = argparse.ArgumentParser(description="Запускает локальный веб-редактор фрагментов видео.")
    parser.add_argument("--data-dir", default="data", help="Папка со всеми видео (data)")
    parser.add_argument("--project-dir", help="Совместимость: папка одного видео — берётся её родитель")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    from pathlib import Path

    data_dir = Path(args.project_dir).resolve().parent if args.project_dir else Path(args.data_dir).resolve()
    os.environ["MEDIA_STUDY_DATA_DIR"] = str(data_dir)

    import uvicorn

    # Config настраивает журналы uvicorn — фильтр ставится после этого.
    config = uvicorn.Config("webapp.server:app", host=args.host, port=args.port, reload=False)
    logging.getLogger("uvicorn.access").addFilter(_QuietPolling())
    uvicorn.Server(config).run()


if __name__ == "__main__":
    main()
