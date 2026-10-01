# -*- coding: utf-8 -*-
"""
Парсинг субтитров YouTube в единый список "реплик" {start, end, text}
(секунды), без сторонних библиотек — только json3 (собственный формат
YouTube) и WebVTT, которые yt-dlp может отдать напрямую по URL.
"""
from pathlib import Path
import json
import re

from common.text_clean import clean_text


_VTT_TIME_RE = re.compile(
    r"(\d+):(\d{2}):(\d{2}\.\d+)\s*-->\s*(\d+):(\d{2}):(\d{2}\.\d+)"
)
_VTT_TAG_RE = re.compile(r"<[^>]+>")


def _vtt_timestamp_to_seconds(hours: str, minutes: str, seconds: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_json3(path: Path) -> list[dict]:
    """Парсит собственный JSON-формат субтитров YouTube (обычно у авто-субтитров)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cues = []
    for event in data.get("events", []):
        segs = event.get("segs")
        if not segs or "tStartMs" not in event:
            continue
        text = clean_text("".join(seg.get("utf8", "") for seg in segs))
        if not text:
            continue
        start = event["tStartMs"] / 1000.0
        duration = event.get("dDurationMs", 0) / 1000.0
        cues.append({"start": start, "end": start + duration, "text": text})
    return cues


def parse_vtt(path: Path) -> list[dict]:
    """Парсит стандартный WebVTT (обычно у ручных субтитров)."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    cues = []
    index = 0
    while index < len(lines):
        match = _VTT_TIME_RE.search(lines[index])
        if not match:
            index += 1
            continue
        start = _vtt_timestamp_to_seconds(*match.groups()[:3])
        end = _vtt_timestamp_to_seconds(*match.groups()[3:])
        index += 1
        text_lines = []
        while index < len(lines) and lines[index].strip():
            text_lines.append(_VTT_TAG_RE.sub("", lines[index]).strip())
            index += 1
        # Переносы строк сохраняются — по ним потом ставится перенос в тексте.
        text = clean_text("\n".join(line for line in text_lines if line))
        if text:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def load_subtitle_cues(path: Path) -> list[dict]:
    """
    Определяет формат по расширению и возвращает реплики как есть. Повторы
    "накопительных" реплик YouTube убираются уже на уровне слов в
    source_text.words_from_cues.
    """
    suffix = Path(path).suffix.lower()
    if suffix == ".json3":
        return parse_json3(path)
    if suffix == ".vtt":
        return parse_vtt(path)
    raise ValueError(f"неизвестный формат субтитров: {path}")
