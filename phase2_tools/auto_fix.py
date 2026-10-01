# -*- coding: utf-8 -*-
"""
Доводка текста только что собранного видео — все вспомогательные алгоритмы
этапа 2 по порядку (каждый — через сервер редактора, правки алгоритма
становятся исходным текстом, а не "ручными"):

1. retext_from_source — строки на слух (без "Имя: ") заменить репликами из
   источника (Notion), иначе — говорящий по контексту и имена из источника;
2. --fill-missing — прозвучавшие, но пропавшие из текста слова (голубым);
3. separate_speaker — реплики Rover на краях фрагментов — в соседние пустые;
4. --polish — заглавные, точка в конце, парные кавычки.

  py -3.12 -m phase2_tools.auto_fix --project EtVj-LuPFl4 [--from 1] [--server http://127.0.0.1:8000]
"""
import argparse
import subprocess
import sys


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Доводка текста видео всеми алгоритмами этапа 2.")
    parser.add_argument("--project", required=True)
    parser.add_argument("--from", dest="start", default="1")
    parser.add_argument("--speaker", default="Rover", help="Чьи реплики разносить по пустым соседям")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    common = ["--project", args.project, "--from", args.start, "--server", args.server]
    steps = [
        ("тексты на слух -> источник", ["phase2_tools.retext_from_source", *common, "--apply"]),
        ("пропавшие слова", ["phase2_tools.retext_from_source", *common, "--fill-missing", "--apply"]),
        (f"реплики {args.speaker}", ["phase2_tools.separate_speaker", *common, "--speaker", args.speaker, "--apply"]),
        ("оформление", ["phase2_tools.retext_from_source", *common, "--polish", "--apply"]),
    ]
    for title, command in steps:
        print(f"== {title}", flush=True)
        result = subprocess.run([sys.executable, "-m", *command], capture_output=True, text=True, encoding="utf-8")
        # Подробный список правок шагов не нужен — только итоговые строки.
        tail = [line for line in result.stdout.splitlines() if not line.startswith("№")][-3:]
        print("\n".join(tail), flush=True)
        if result.returncode:
            print(result.stderr[-2000:], flush=True)
            sys.exit(f"шаг «{title}» упал")
    print("Готово.")


if __name__ == "__main__":
    main()
