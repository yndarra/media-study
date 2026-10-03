# -*- coding: utf-8 -*-
"""
Ключи сервисов – в папке secrets/ в корне проекта (в git не попадает, см.
.gitignore): secrets/openrouter_key.txt и secrets/elevenlabs_key.txt.
Вписываются в "Настройках" приложения или вручную (один ключ в файле).
"""
from __future__ import annotations

from pathlib import Path

SECRETS_DIR = Path(__file__).resolve().parent.parent / "secrets"
OPENROUTER_KEY = SECRETS_DIR / "openrouter_key.txt"
ELEVENLABS_KEY = SECRETS_DIR / "elevenlabs_key.txt"

README = """Здесь лежат ключи сервисов (в git не попадают):
  openrouter_key.txt  – ключ OpenRouter (перевод, поиск источников, ИИ-доводка);
  elevenlabs_key.txt  – ключ ElevenLabs (распознавание речи Scribe).
Один ключ в файле. Проще всего вписывать их в приложении: Настройки.
"""


def read(path: Path) -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write(path: Path, value: str) -> None:
    SECRETS_DIR.mkdir(exist_ok=True)
    readme = SECRETS_DIR / "README.txt"
    if not readme.exists():
        readme.write_text(README, encoding="utf-8")
    Path(path).write_text(value.strip(), encoding="utf-8")
