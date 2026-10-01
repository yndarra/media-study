# -*- coding: utf-8 -*-
"""
Схема манифеста проекта (JSON) и его валидация.

Манифест — единственный источник истины про фрагменты одного видео: границы,
текст, статус (активен/помечен на удаление) и происхождение (merge/split).
Хранится в data/<video_id>/manifest.json. Само видео не режется физически —
все границы это номера кадров внутри одного файла source.mp4.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional
import json

from common.text_clean import clean_text

SCHEMA_VERSION = 1

STATUS_ACTIVE = "active"
STATUS_DELETED = "deleted"

KIND_PHRASE = "phrase"
KIND_FILLER = "filler"


# Реплика молчащего героя (в игре не озвучена): "Rover: ..." в начале строки.
UNVOICED_SPEAKERS = ("Rover",)
UNVOICED_LINE = re.compile(rf"^\s*(?:{'|'.join(UNVOICED_SPEAKERS)})\s*:", re.M)


@dataclass
class Fragment:
    id: str
    status: str
    algo_start_frame: int
    algo_end_frame: int
    context_start_frame: int
    context_end_frame: int
    original_algo_start_frame: int
    original_algo_end_frame: int
    text: str = ""
    # Текст на момент создания фрагмента — нужен, чтобы правка текста тоже
    # считалась редактированием и чтобы Reset мог вернуть его обратно.
    original_text: Optional[str] = None
    # Текст внешнего источника (субтитры/транскрипт), пословно выровненный
    # ровно на этот отрезок — показывается в редакторе как подсказка.
    source_text: str = ""
    needs_review: bool = False
    review_note: str = ""
    source_segment_ids: list[str] = field(default_factory=list)
    merged_from: Optional[list[str]] = None
    absorbed_into: Optional[str] = None
    split_from: Optional[str] = None
    split_into: Optional[list[str]] = None
    # Запас слева/справа этого фрагмента изменён вручную (кнопки ±5 с в
    # редакторе) — тогда смена общего settings.context_padding_seconds его не
    # пересчитывает. Правкой отрезка не считается (статус "изменён" не
    # ставит), но Reset возвращает и его к общему значению.
    context_custom: bool = False
    # Фрагмент вынесен на этап 3 (phase3_export): в редакторе его больше нет,
    # пересборка этапа 1 его не трогает.
    exported: bool = False
    # Фрагмент вернулся из Anki на доработку (карточку пометили флагом). При
    # следующей передаче в Anki обновится та же карточка, а не создастся новая.
    anki_flagged: bool = False
    # Участки original_text, записанные НА СЛУХ (распознаванием, а не взятые из
    # источника вроде Notion): [[начало, конец), ...] в символах. В редакторе
    # они голубые — на них стоит обратить внимание.
    heard_ranges: list[list[int]] = field(default_factory=list)
    # Разметка правки текста в редакторе — по символу на каждый показанный
    # символ: "o" исходный (белый), "i" набранный (зелёный), "d" удалённый
    # (красный). Нужна, когда набранное совпадает с удалённым: посимвольное
    # сравнение исходного и текущего текста тогда показало бы всё белым.
    # Пусто — разметка выводится сравнением (редактор проверяет, что она
    # сходится с original_text и text, иначе тоже сравнивает заново).
    text_marks: str = ""
    # Реплика не озвучена (Rover в игре молчит — выбор ответа): в карточку Anki
    # не идёт видео, только текст с подписью "Rover:". None — по умолчанию:
    # отмечены фрагменты с репликой Rover; True/False — задано кнопкой.
    unvoiced: bool | None = None

    def __post_init__(self) -> None:
        # Любой текст фрагмента хранится очищенным от лишних и невидимых
        # пробелов (см. common/text_clean.py) — и новый, и загруженный из
        # старого манифеста.
        self.text = clean_text(self.text)
        self.source_text = clean_text(self.source_text)
        self.original_text = self.text if self.original_text is None else clean_text(self.original_text)

    @property
    def is_unvoiced(self) -> bool:
        """Отметка "не озвучено": заданная кнопкой или по умолчанию (есть реплика Rover)."""
        if self.unvoiced is not None:
            return self.unvoiced
        return bool(UNVOICED_LINE.search(self.text or ""))

    @property
    def kind(self) -> str:
        """Тип фрагмента всегда выводится из текста, а не хранится независимо."""
        return KIND_PHRASE if self.text.strip() else KIND_FILLER

    @property
    def edited(self) -> bool:
        """True, если изменены границы отрезка или текст относительно исходных."""
        return (
            self.algo_start_frame != self.original_algo_start_frame
            or self.algo_end_frame != self.original_algo_end_frame
            or self.text != self.original_text
        )

    @property
    def restorable(self) -> bool:
        """
        Пометку удаления можно снять (Reset или повторное «удалить») с любого
        удалённого фрагмента; связи объединения/разделения при этом
        распутываются на сервере (ManifestStore._undelete).
        """
        return self.status == STATUS_DELETED

    @property
    def hard_deletable(self) -> bool:
        """Окончательно удалять сразу можно только результаты merge/split."""
        return bool(self.merged_from) or bool(self.split_from)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["kind"] = self.kind
        data["is_unvoiced"] = self.is_unvoiced
        data["edited"] = self.edited
        data["hard_deletable"] = self.hard_deletable
        data["restorable"] = self.restorable
        return data

    @staticmethod
    def from_dict(data: dict) -> "Fragment":
        # kind/edited не читаются обратно — это всегда производные значения.
        known_fields = {f for f in Fragment.__dataclass_fields__}
        clean = {k: v for k, v in data.items() if k in known_fields}
        # Старый формат: личный запас хранился числом context_padding_seconds.
        if data.get("context_padding_seconds") is not None:
            clean["context_custom"] = True
        return Fragment(**clean)


@dataclass
class VideoInfo:
    youtube_url: str
    video_id: str
    title: str
    fps: float
    total_frames: int
    source_file: str
    # Мастер-копия в максимальном качестве (для экспорта в Фазе 3);
    # source_file — облегчённая копия только для редактора.
    master_file: str = ""
    subtitle_source: str = "none"
    asr_model: str = "faster-whisper medium.en (CPU int8)"

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict) -> "VideoInfo":
        known_fields = {f for f in VideoInfo.__dataclass_fields__}
        clean = {k: v for k, v in data.items() if k in known_fields}
        return VideoInfo(**clean)


# Настройки проекта, которые можно менять прямо в manifest.json (блок "settings"):
#   context_padding_seconds — запас до и после отрезка на дорожке; применяется
#     сразу при следующем открытии редактора, пересборка не нужна;
#   min_filler_seconds — с какой длины тишина/музыка становится отдельным
#     фрагментом; влияет на нарезку, поэтому применяется при пересборке
#     (phase1_ingest.rebuild).
DEFAULT_SETTINGS = {
    "context_padding_seconds": 3.0,
    "min_filler_seconds": 1.0,
}
LEGACY_CONTEXT_PADDING_SECONDS = 60.0


@dataclass
class Manifest:
    video: VideoInfo
    fragments: list[Fragment]
    schema_version: int = SCHEMA_VERSION
    settings: dict = field(default_factory=lambda: dict(DEFAULT_SETTINGS))
    # С каким запасом посчитан контекст фрагментов сейчас — если пользователь
    # поменял settings.context_padding_seconds, контекст пересчитывается.
    applied_context_padding_seconds: Optional[float] = None

    def __post_init__(self) -> None:
        self.settings = {**DEFAULT_SETTINGS, **(self.settings or {})}
        if self.applied_context_padding_seconds is None:
            self.applied_context_padding_seconds = self.settings["context_padding_seconds"]

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "settings": self.settings,
            "applied_context_padding_seconds": self.applied_context_padding_seconds,
            "video": self.video.to_dict(),
            "fragments": [f.to_dict() for f in self.fragments],
        }

    @staticmethod
    def from_dict(data: dict) -> "Manifest":
        return Manifest(
            schema_version=data.get("schema_version", SCHEMA_VERSION),
            video=VideoInfo.from_dict(data["video"]),
            fragments=[Fragment.from_dict(f) for f in data["fragments"]],
            settings=data.get("settings"),
            # Манифесты, сохранённые до появления настроек, собраны с запасом 60 с.
            applied_context_padding_seconds=data.get("applied_context_padding_seconds", LEGACY_CONTEXT_PADDING_SECONDS),
        )

    def save(self, path: Path) -> None:
        """Атомарная запись: пишем во временный файл и заменяем оригинал."""
        path = Path(path)
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        replace_file(tmp_path, path)

    @staticmethod
    def load(path: Path) -> "Manifest":
        data = json.loads(retry_windows_lock(lambda: Path(path).read_text(encoding="utf-8")))
        return Manifest.from_dict(data)

    def by_id(self, fragment_id: str) -> Fragment:
        for fragment in self.fragments:
            if fragment.id == fragment_id:
                return fragment
        raise KeyError(f"фрагмент не найден: {fragment_id}")

    def index_of(self, fragment_id: str) -> int:
        for index, fragment in enumerate(self.fragments):
            if fragment.id == fragment_id:
                return index
        raise KeyError(f"фрагмент не найден: {fragment_id}")


def validate_full_coverage(fragments: list[Fragment], total_frames: int) -> None:
    """
    Проверяет, что свежесозданное (ещё не редактированное) разбиение Фазы 1
    покрывает весь таймлайн без дыр и наложений — это гарантирует, что любые
    два соседних фрагмента можно бесшовно склеить обратно через merge.
    """
    if not fragments:
        raise ValueError("пустой список фрагментов")
    if fragments[0].algo_start_frame != 0:
        raise ValueError(
            f"первый фрагмент должен начинаться с кадра 0, "
            f"получено {fragments[0].algo_start_frame}"
        )
    if fragments[-1].algo_end_frame != total_frames:
        raise ValueError(
            f"последний фрагмент должен заканчиваться на {total_frames}, "
            f"получено {fragments[-1].algo_end_frame}"
        )
    for previous, current in zip(fragments, fragments[1:]):
        if previous.algo_end_frame != current.algo_start_frame:
            raise ValueError(
                f"разрыв или наложение между {previous.id} (конец "
                f"{previous.algo_end_frame}) и {current.id} (начало "
                f"{current.algo_start_frame})"
            )
    for fragment in fragments:
        if fragment.algo_start_frame >= fragment.algo_end_frame:
            raise ValueError(
                f"некорректные границы у {fragment.id}: "
                f"{fragment.algo_start_frame}..{fragment.algo_end_frame}"
            )


def shift_ranges(ranges: list[list[int]], offset: int) -> list[list[int]]:
    """Диапазоны символов, сдвинутые на offset (текст приклеен после другого)."""
    return [[start + offset, end + offset] for start, end in ranges]


def carry_ranges(old: str, new: str, ranges: list[list[int]]) -> list[list[int]]:
    """
    Перенос отмеченных участков из текста old в текст new: отмеченными
    остаются символы new, совпавшие с отмеченными символами old (посимвольное
    сравнение); изменённые символы отметку теряют.
    """
    from difflib import SequenceMatcher

    if not ranges:
        return []
    marked = [False] * len(old)
    for start, end in ranges:
        for i in range(max(0, start), min(len(old), end)):
            marked[i] = True
    result: list[list[int]] = []
    for block in SequenceMatcher(None, old, new, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            if marked[block.a + k]:
                j = block.b + k
                if result and result[-1][1] == j:
                    result[-1][1] = j + 1
                else:
                    result.append([j, j + 1])
    return result


def retry_windows_lock(action, attempts: int = 40, delay: float = 0.05):
    """
    Windows не даёт заменить или прочитать файл, пока другой процесс держит
    его открытым (фоновый обработчик этапа 3, опрос статистики, антивирус):
    PermissionError. Это длится миллисекунды — повторяем, а не падаем с 500.
    """
    import time

    for attempt in range(attempts):
        try:
            return action()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def replace_file(tmp_path: Path, path: Path) -> None:
    """Атомарная замена path файлом tmp_path (с повторами, см. retry_windows_lock)."""
    retry_windows_lock(lambda: Path(tmp_path).replace(path))
