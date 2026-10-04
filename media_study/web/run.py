# -*- coding: utf-8 -*-
"""
CLI-запуск веб-приложения (библиотека видео, редактор, Anki, скачивание).

Использование:
  py -3.12 -m media_study.web.run [--data-dir data] [--port 8000]
  (старый вариант --project-dir data/<id> тоже работает: берётся его папка data)
"""
import argparse
import logging
import os
from pathlib import Path


POLLING = ("/api/heartbeat", "/api/clients", "/api/activity", "/api/logs", "/edit_state", "/api/anki/overview",
           "/api/projects ", "/api/agent/state", "/disk ")


class _QuietPolling(logging.Filter):
    """Не пишет в журнал служебные опросы открытой вкладки (раз в секунду)."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # И остальные частые опросы страницы ("Сейчас идёт", журнал, списки) –
        # иначе в журнале сервера за ними не видно ничего полезного.
        # Файлы самого интерфейса (страница, js, css, значок) – тоже шум.
        if any(f'{ext} HTTP' in message for ext in (".js", ".css", ".svg")) or '"GET / HTTP' in message:
            return False
        return not any(path in message for path in POLLING)


def main() -> None:
    parser = argparse.ArgumentParser(description="Запускает локальный веб-редактор фрагментов видео.")
    parser.add_argument("--data-dir", default="data", help="Папка со всеми видео (data)")
    parser.add_argument("--project-dir", help="Совместимость: папка одного видео — берётся её родитель")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--log-file", help="Писать журнал сервера в файл (запуск без окна, pyw)")
    args = parser.parse_args()

    import sys

    if args.log_file:
        # Запуск без окна консоли (start.bat -> pyw): весь вывод – в файл,
        # его показывает окошко "Журнал" в приложении. Больше 5 МБ – прежний
        # журнал откладывается в .old, новый начинается с нуля.
        log_path = Path(args.log_file).resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if log_path.exists() and log_path.stat().st_size > 5 * 2**20:
            log_path.replace(log_path.with_suffix(".old.log"))
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = stream
        # Фоновые процессы (обработка, Anki, перевод) запускаются через
        # sys.executable – под pythonw это был бы pythonw.exe; им нужен обычный
        # python.exe (окон у них и так нет: CREATE_NO_WINDOW).
        console = Path(sys.executable).with_name("python.exe")
        if Path(sys.executable).name.lower() == "pythonw.exe" and console.exists():
            sys.executable = str(console)

    data_dir = Path(args.project_dir).resolve().parent if args.project_dir else Path(args.data_dir).resolve()
    os.environ["MEDIA_STUDY_DATA_DIR"] = str(data_dir)

    import uvicorn

    # Config настраивает журналы uvicorn — фильтр ставится после этого.
    config = uvicorn.Config("media_study.web.server:app", host=args.host, port=args.port, reload=False)
    logging.getLogger("uvicorn.access").addFilter(_QuietPolling())
    uvicorn.Server(config).run()


if __name__ == "__main__":
    main()
