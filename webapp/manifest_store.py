# -*- coding: utf-8 -*-
"""
Операции веб-редактора над манифестом: точечная правка границ/текста,
мягкое/окончательное удаление с каскадом восстановления merge-ингредиентов,
merge (всегда по исходным границам — гарантия бесшовности) и split.

Кадры везде в полуинтервалах [start, end): последний кадр отрезка — end-1.
Контекст фрагмента задаётся при его создании и дальше не меняется
(кроме смены запаса в settings манифеста).

Отмена/возврат — у каждого фрагмента своя история. Каждое действие
запоминает состояние только тех фрагментов, которые оно затронуло (до и
после), и попадает в историю каждого из них: правка текста — в историю
одного фрагмента, объединение — в историю обоих исходников и результата.
"Назад" на фрагменте отменяет последнее действие, которое его касалось, и
только если затронутые им фрагменты с тех пор больше не менялись — иначе
отмена перетёрла бы более поздние правки соседа (тогда сначала нужно
отменить их на том фрагменте). История живёт в памяти процесса сервера —
после перезапуска редактора она начинается заново.
"""
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
import re
import threading

from common.context_bounds import context_for
from common.frame_time import frames_for_seconds
from common.text_clean import clean_text
from common.manifest_schema import Fragment, Manifest, STATUS_ACTIVE, STATUS_DELETED, carry_ranges, replace_file, shift_ranges

_FRAG_ID_RE = re.compile(r"frag_(\d+)$")
# Шаг кнопок запаса ±3 с и минимальный запас, до которого их можно уменьшить.
PADDING_STEP_SECONDS = 3.0
HISTORY_LIMIT = 200


@dataclass
class HistoryStep:
    # Состояние затронутых фрагментов (как в manifest.json) до и после
    # действия; None — фрагмента в этот момент не было в списке.
    before: dict
    after: dict
    # Порядок всех фрагментов до и после — чтобы вернуть восстановленный
    # фрагмент на его место в списке.
    order_before: list
    order_after: list
    # Непустой ключ склеивает подряд идущие сохранения набираемого текста в
    # один шаг — каждое сохранение не должно становиться отдельным "назад".
    coalesce_key: str | None = None


def _locked(method):
    """
    Операции над манифестом выполняются по одной: запросы редактора идут
    параллельно (пул потоков сервера), а "прочитать — изменить — записать"
    двух запросов вперемешку потеряло бы одну из правок.
    """
    @wraps(method)
    def wrapper(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return wrapper


LOCKED_MESSAGE = "фрагмент уже передан в Anki — его можно только просматривать"


class ManifestStore:
    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)
        self.manifest_path = self.project_dir / "manifest.json"
        self.undo_stacks: dict[str, list[HistoryStep]] = {}
        self.redo_stacks: dict[str, list[HistoryStep]] = {}
        self.lock = threading.RLock()

    # -- история -----------------------------------------------------------------

    def _begin(self) -> tuple[Manifest, dict]:
        """Загружает манифест и запоминает его состояние "до" правки."""
        manifest = self.load()
        return manifest, manifest.to_dict()

    def _commit(self, manifest: Manifest, before: dict, fragment_id: str, coalesce_key: str | None = None) -> None:
        """Сохраняет правку и записывает её в историю затронутых фрагментов."""
        after = manifest.to_dict()
        self.save(manifest)
        old = {f["id"]: f for f in before["fragments"]}
        new = {f["id"]: f for f in after["fragments"]}
        touched = [i for i in [*old, *[i for i in new if i not in old]] if old.get(i) != new.get(i)]
        if not touched:
            return
        stack = self.undo_stacks.get(fragment_id) or []
        if (
            coalesce_key
            and touched == [fragment_id]
            and stack
            and stack[-1].coalesce_key == coalesce_key
            and not self.redo_stacks.get(fragment_id)
        ):
            # Продолжение той же правки текста — шаг только обновляется.
            stack[-1].after[fragment_id] = new[fragment_id]
            stack[-1].order_after = [f["id"] for f in after["fragments"]]
            return
        step = HistoryStep(
            before={i: old.get(i) for i in touched},
            after={i: new.get(i) for i in touched},
            order_before=[f["id"] for f in before["fragments"]],
            order_after=[f["id"] for f in after["fragments"]],
            coalesce_key=coalesce_key,
        )
        for i in touched:
            self._drop_redo(i)
            history = self.undo_stacks.setdefault(i, [])
            history.append(step)
            del history[:-HISTORY_LIMIT]

    def _drop_redo(self, fragment_id: str) -> None:
        """Новое действие на фрагменте отменяет возможность "вперёд" для него (и для связанных шагов)."""
        for step in self.redo_stacks.pop(fragment_id, []):
            for other in step.after:
                stack = self.redo_stacks.get(other)
                if stack and step in stack:
                    stack.remove(step)

    def can_undo(self, fragment_id: str) -> bool:
        return bool(self.undo_stacks.get(fragment_id))

    def can_redo(self, fragment_id: str) -> bool:
        return bool(self.redo_stacks.get(fragment_id))

    def _apply_states(self, manifest: Manifest, expected: dict, target: dict, target_order: list) -> None:
        """
        Переводит затронутые фрагменты из состояния expected в target.
        Если какой-то из них сейчас не в состоянии expected — его с тех пор
        меняли, и переход перетёр бы эти правки: ValueError.
        """
        current = {f.id: f for f in manifest.fragments}
        for fragment_id, state in expected.items():
            now = current[fragment_id].to_dict() if fragment_id in current else None
            if now != state:
                raise ValueError(f"фрагмент {fragment_id} с тех пор менялся — сначала отмените действия на нём")
        ids = [f.id for f in manifest.fragments if not (f.id in target and target[f.id] is None)]
        # Фрагменты, которых сейчас нет, встают сразу за своим прежним левым соседом.
        for position, fragment_id in enumerate(target_order):
            if target.get(fragment_id) is None or fragment_id in ids:
                continue
            insert_at = 0
            for previous in reversed(target_order[:position]):
                if previous in ids:
                    insert_at = ids.index(previous) + 1
                    break
            ids.insert(insert_at, fragment_id)
        manifest.fragments = [
            Fragment.from_dict(target[i]) if i in target else current[i]
            for i in ids
        ]

    def _step_from(self, stacks: dict, fragment_id: str, empty_message: str) -> HistoryStep:
        stack = stacks.get(fragment_id)
        if not stack:
            raise ValueError(empty_message)
        step = stack[-1]
        for other in step.after:
            if other != fragment_id and not (stacks.get(other) and stacks[other][-1] is step):
                raise ValueError(f"сначала отмените более поздние действия на фрагменте {other}")
        return step

    @staticmethod
    def _ensure_unlocked(manifest: Manifest, step: HistoryStep) -> None:
        if any(f.exported and f.id in step.after for f in manifest.fragments):
            raise ValueError(LOCKED_MESSAGE)

    @staticmethod
    def _focus(manifest: Manifest, fragment_id: str, state: dict) -> str:
        """Остаёмся на текущем фрагменте; если его больше нет — открываем затронутый действием."""
        ids = [f.id for f in manifest.fragments if not f.exported]
        if fragment_id in ids:
            return fragment_id
        return next((i for i in state if state[i] is not None and i in ids), ids[0] if ids else None)

    @_locked
    def undo(self, fragment_id: str) -> tuple[Manifest, str | None]:
        step = self._step_from(self.undo_stacks, fragment_id, "у этого фрагмента нечего отменять")
        manifest = self.load()
        self._ensure_unlocked(manifest, step)
        self._apply_states(manifest, step.after, step.before, step.order_before)
        self.save(manifest)
        for i in step.after:
            self.undo_stacks[i].remove(step)
            self.redo_stacks.setdefault(i, []).append(step)
        step.coalesce_key = None
        return manifest, self._focus(manifest, fragment_id, step.before)

    @_locked
    def redo(self, fragment_id: str) -> tuple[Manifest, str | None]:
        step = self._step_from(self.redo_stacks, fragment_id, "у этого фрагмента нечего возвращать")
        manifest = self.load()
        self._ensure_unlocked(manifest, step)
        self._apply_states(manifest, step.before, step.after, step.order_after)
        self.save(manifest)
        for i in step.after:
            self.redo_stacks[i].remove(step)
            self.undo_stacks.setdefault(i, []).append(step)
        return manifest, self._focus(manifest, fragment_id, step.after)

    def load(self) -> Manifest:
        manifest = Manifest.load(self.manifest_path)
        if manifest.applied_context_padding_seconds != manifest.settings["context_padding_seconds"]:
            self._apply_context_padding(manifest)
            self.save(manifest)
        return manifest

    @_locked
    def set_anki_deck(self, deck: str) -> None:
        """Колоду видео в Anki переименовали (phase3_export.decks) — запомнить новую."""
        manifest = Manifest.load(self.manifest_path)
        manifest.settings["anki_deck"] = deck
        self.save(manifest)

    @_locked
    def mark_finished(self) -> Manifest:
        """Кнопка "Финиш" на последнем фрагменте: всё видео считается отредактированным."""
        manifest = Manifest.load(self.manifest_path)
        manifest.settings["finished"] = True
        self.save(manifest)
        return manifest

    @_locked
    def set_default_padding(self, seconds: float) -> None:
        """Общий запас до/после отрезка поменяли в настройках приложения."""
        manifest = Manifest.load(self.manifest_path)
        if manifest.settings.get("context_padding_seconds") == seconds:
            return
        manifest.settings["context_padding_seconds"] = seconds
        self._apply_context_padding(manifest)
        self.save(manifest)

    def _apply_context_padding(self, manifest: Manifest) -> None:
        """
        Пользователь поменял settings.context_padding_seconds — пересчитываем
        запас фрагментов от их исходных границ. Уже просмотренные (до скрытой
        метки — последнего изменённого фрагмента) не трогаются, как и запас,
        заданный вручную. Если отрезок выходит за новый запас — запас
        расширяется до него.
        """
        touched = [i for i, f in enumerate(manifest.fragments)
                   if f.exported or f.status != STATUS_ACTIVE or f.edited or f.context_custom or f.merged_from or f.split_from]
        reviewed = max(touched, default=-1)
        if manifest.settings.get("finished"):
            reviewed = len(manifest.fragments) - 1  # "Финиш": просмотрено всё видео
        for index, fragment in enumerate(manifest.fragments):
            if index <= reviewed:
                continue
            if not fragment.context_custom:
                fragment.context_start_frame, fragment.context_end_frame = self._default_context(manifest, fragment)
        manifest.applied_context_padding_seconds = manifest.settings["context_padding_seconds"]

    def _default_context(self, manifest: Manifest, fragment: Fragment) -> tuple[int, int]:
        """Общий запас от исходных границ; если отрезок уже вылез за него — запас расширяется до отрезка."""
        start, end = context_for(
            fragment.original_algo_start_frame, fragment.original_algo_end_frame,
            manifest.video.total_frames, manifest.video.fps,
            manifest.settings["context_padding_seconds"],
        )
        return min(start, fragment.algo_start_frame), max(end, fragment.algo_end_frame)

    def save(self, manifest: Manifest) -> None:
        manifest.save(self.manifest_path)

    # -- внутренние помощники -------------------------------------------------

    def _new_fragment_ids(self, manifest: Manifest, count: int) -> list[str]:
        existing_numbers = [
            int(match.group(1))
            for fragment in manifest.fragments
            if (match := _FRAG_ID_RE.match(fragment.id))
        ]
        start = (max(existing_numbers) + 1) if existing_numbers else 0
        return [f"frag_{start + offset:04d}" for offset in range(count)]

    def _nearest_live_neighbor_index(self, manifest: Manifest, index: int, direction: str) -> int | None:
        step = 1 if direction == "next" else -1
        cursor = index + step
        while 0 <= cursor < len(manifest.fragments):
            # Вынесенные на этап 3 для редактора не существуют — с ними не объединяем.
            candidate = manifest.fragments[cursor]
            if candidate.status == STATUS_ACTIVE and not candidate.exported:
                return cursor
            cursor += step
        return None

    def _next_fragment_id(self, manifest: Manifest, fragment_id: str) -> str | None:
        index = manifest.index_of(fragment_id)
        if index + 1 < len(manifest.fragments):
            return manifest.fragments[index + 1].id
        return None

    def _restore_merge_ingredients(self, manifest: Manifest, fragment: Fragment) -> None:
        """Удаление merge-результата (любое) возвращает оба исходника в active."""
        if not fragment.merged_from:
            return
        for ingredient_id in fragment.merged_from:
            ingredient = manifest.by_id(ingredient_id)
            ingredient.status = STATUS_ACTIVE
            ingredient.absorbed_into = None

    def _undelete(self, manifest: Manifest, fragment: Fragment) -> None:
        """
        Возвращает удалённый фрагмент в active, аккуратно распутывая связи:
        результат объединения снова поглощает свои исходники; разделённый
        фрагмент — его части убираются; исходник объединения — убирается
        результат объединения, и оба исходника снова живые. Если связанный
        фрагмент уже разделён или объединён дальше — ValueError (такую
        цепочку надо разматывать кнопкой «назад»).
        """
        def ensure_free(other: Fragment) -> None:
            if other.split_into or other.absorbed_into:
                raise ValueError(f"фрагмент {other.id} уже разделён или объединён дальше — сначала отмените это")

        if fragment.absorbed_into:
            merged = next((f for f in manifest.fragments if f.id == fragment.absorbed_into), None)
            if merged is not None:
                ensure_free(merged)
                manifest.fragments.remove(merged)
                self._restore_merge_ingredients(manifest, merged)
            fragment.absorbed_into = None
        if fragment.split_into:
            parts = [f for f in manifest.fragments if f.id in fragment.split_into]
            for part in parts:
                ensure_free(part)
            for part in parts:
                manifest.fragments.remove(part)
            fragment.split_into = None
        if fragment.merged_from:
            ingredients = [manifest.by_id(i) for i in fragment.merged_from]
            if any(i.status != STATUS_ACTIVE for i in ingredients):
                raise ValueError("исходники этого объединения уже заняты — верните его кнопкой «назад»")
            for ingredient in ingredients:
                ingredient.status = STATUS_DELETED
                ingredient.absorbed_into = fragment.id
        fragment.status = STATUS_ACTIVE

    @staticmethod
    def _editable(manifest: Manifest, fragment_id: str) -> Fragment:
        fragment = manifest.by_id(fragment_id)
        if fragment.exported:
            raise ValueError(LOCKED_MESSAGE)
        return fragment

    # -- публичные операции -----------------------------------------------------

    @_locked
    def update_fragment(
        self,
        fragment_id: str,
        algo_start_frame: int | None = None,
        algo_end_frame: int | None = None,
        text: str | None = None,
        needs_review: bool | None = None,
        review_note: str | None = None,
        text_marks: str | None = None,
        link: bool = False,
    ) -> Manifest:
        """
        Правка фрагмента. link – режим "связанные границы": граница, стоявшая
        вплотную к соседу (ближайшему живому, не переданному в Anki),
        двигается вместе с его границей – склейка всех фрагментов остаётся
        покадрово равной исходному видео. Сосед правится тем же шагом истории
        (Ctrl+Z отменяет обе правки); его запас при нужде расширяется.
        Изменённые соседи – в self.last_linked.
        """
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        old_start, old_end = fragment.algo_start_frame, fragment.algo_end_frame
        self.last_linked = []
        # Правка только текста склеивается с предыдущей правкой текста
        # этого же фрагмента; любые границы — всегда отдельный шаг.
        only_text = text is not None and algo_start_frame is None and algo_end_frame is None
        if algo_start_frame is not None:
            fragment.algo_start_frame = algo_start_frame
        if algo_end_frame is not None:
            fragment.algo_end_frame = algo_end_frame
        if not (
            fragment.context_start_frame
            <= fragment.algo_start_frame
            < fragment.algo_end_frame
            <= fragment.context_end_frame
        ):
            raise ValueError("границы отрезка должны лежать внутри фрагмента и start < end")
        if link:
            index = manifest.index_of(fragment_id)
            for side, old, new in (("start", old_start, fragment.algo_start_frame), ("end", old_end, fragment.algo_end_frame)):
                if old == new:
                    continue
                direction = "prev" if side == "start" else "next"
                k = self._nearest_live_neighbor_index(manifest, index, direction)
                neighbor = manifest.fragments[k] if k is not None else None
                if neighbor is None or neighbor.exported:
                    continue
                if side == "start" and neighbor.algo_end_frame == old:
                    if new <= neighbor.algo_start_frame:
                        raise ValueError("соседний фрагмент стал бы пустым")
                    neighbor.algo_end_frame = new
                    neighbor.context_end_frame = max(neighbor.context_end_frame, new)
                elif side == "end" and neighbor.algo_start_frame == old:
                    if new >= neighbor.algo_end_frame:
                        raise ValueError("соседний фрагмент стал бы пустым")
                    neighbor.algo_start_frame = new
                    neighbor.context_start_frame = min(neighbor.context_start_frame, new)
                else:
                    continue  # не стояли вплотную – соседа не трогаем
                neighbor.context_custom = (neighbor.context_start_frame, neighbor.context_end_frame) != self._default_context(manifest, neighbor)
                self.last_linked.append(neighbor.id)
        if text is not None:
            fragment.text = clean_text(text)
            # Разметка правки приходит вместе с текстом; без неё — старая
            # уже не про этот текст.
            fragment.text_marks = text_marks or ""
        if needs_review is not None:
            fragment.needs_review = needs_review
        if review_note is not None:
            fragment.review_note = review_note
        self._commit(manifest, before, fragment_id, f"text:{fragment_id}" if only_text else None)
        return manifest

    @_locked
    def set_unvoiced(self, fragment_id: str, value: bool) -> Manifest:
        """Кнопка "не озвучено" в редакторе (отменяется Ctrl+Z, как любая правка)."""
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        fragment.unvoiced = bool(value)
        self._commit(manifest, before, fragment_id)
        return manifest

    @_locked
    def mark_heard(self, fragment_id: str, heard_ranges: list[list[int]], rebase: bool = False) -> Manifest:
        """
        Отметить участки текста, записанные на слух (голубые в редакторе).
        rebase — текущий текст становится исходным (original_text): так правку,
        сделанную алгоритмом (например, retext_from_source), редактор не
        показывает зелёным/красным как ручную. Диапазоны — в символах
        original_text (после rebase — текущего текста). Отменяется "назад".
        """
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        if rebase:
            fragment.original_text = fragment.text
            fragment.text_marks = ""
        limit = len(fragment.original_text)
        fragment.heard_ranges = [[max(0, a), min(limit, b)] for a, b in heard_ranges if a < b and a < limit]
        self._commit(manifest, before, fragment_id)
        return manifest

    @_locked
    def reset(self, fragment_id: str) -> Manifest:
        """
        Возвращает границы, текст и запас слева/справа к состоянию на момент
        создания фрагмента (запас — к общему из settings) и снимает пометку
        удаления (с распутыванием объединений/разделений, см. _undelete).
        """
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        if fragment.status != STATUS_ACTIVE:
            self._undelete(manifest, fragment)
        fragment.algo_start_frame = fragment.original_algo_start_frame
        fragment.algo_end_frame = fragment.original_algo_end_frame
        fragment.text = fragment.original_text
        fragment.text_marks = ""  # исходный текст — без зелёного и красного
        # Запас слева и справа — тоже к общему значению из settings.
        fragment.context_start_frame, fragment.context_end_frame = self._default_context(manifest, fragment)
        fragment.context_custom = False
        self._commit(manifest, before, fragment_id)
        return manifest

    @_locked
    def restore(self, fragment_id: str, link: bool = False) -> Manifest:
        """
        Снимает пометку удаления (повторное нажатие кнопки «удалить»).
        link – обратное к soft_delete: если следующий живой фрагмент
        начинается вплотную к предыдущему живому, захватывая место
        возвращаемого, его левая граница возвращается на конец возвращаемого.
        """
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        if fragment.status == STATUS_ACTIVE:
            raise ValueError("фрагмент не удалён")
        if link and not fragment.split_into and not fragment.absorbed_into:
            prev, nxt = self._live_around(manifest, manifest.index_of(fragment_id))
            if (nxt and nxt.algo_start_frame < fragment.algo_end_frame < nxt.algo_end_frame
                    and nxt.algo_start_frame <= fragment.algo_start_frame
                    and (prev is None or prev.algo_end_frame == nxt.algo_start_frame)):
                self._shift_start(manifest, nxt, fragment.algo_end_frame)
        self._undelete(manifest, fragment)
        self._commit(manifest, before, fragment_id)
        return manifest

    @_locked
    def change_side_padding(self, fragment_id: str, side: str, direction: int) -> Manifest:
        """
        Увеличивает (direction=+1) или уменьшает (-1) запас с одной стороны
        фрагмента на PADDING_STEP_SECONDS.

        Увеличение упирается в край видео: если до края осталось меньше шага,
        добавляется сколько есть. Уменьшение не опускает запас ниже
        PADDING_STEP_SECONDS от исходной границы и никогда не обрезает сам
        отрезок (если его границу вынесли за запас). Если сдвигать некуда —
        ValueError (в редакторе такая кнопка уже серая).
        """
        if side not in ("left", "right") or direction not in (1, -1):
            raise ValueError("side должен быть 'left' или 'right', direction — 1 или -1")
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        step = frames_for_seconds(PADDING_STEP_SECONDS, manifest.video.fps)
        total = manifest.video.total_frames
        start, end = fragment.context_start_frame, fragment.context_end_frame
        if side == "left" and direction > 0:
            start = max(0, start - step)
        elif side == "left":
            start = min(start + step, fragment.original_algo_start_frame - step, fragment.algo_start_frame)
            start = max(start, fragment.context_start_frame)
        elif direction > 0:
            end = min(total, end + step)
        else:
            end = max(end - step, fragment.original_algo_end_frame + step, fragment.algo_end_frame)
            end = min(end, fragment.context_end_frame)
        if (start, end) == (fragment.context_start_frame, fragment.context_end_frame):
            raise ValueError("запас с этой стороны менять уже некуда")
        fragment.context_start_frame, fragment.context_end_frame = start, end
        # Вернулись ровно к общему запасу — снова следуем общей настройке.
        fragment.context_custom = (start, end) != self._default_context(manifest, fragment)
        self._commit(manifest, before, fragment_id)
        return manifest

    def _live_around(self, manifest: Manifest, index: int):
        """Ближайшие живые соседи слева и справа (не переданные в Anki) или None."""
        k_prev = self._nearest_live_neighbor_index(manifest, index, "prev")
        k_next = self._nearest_live_neighbor_index(manifest, index, "next")
        prev = manifest.fragments[k_prev] if k_prev is not None else None
        nxt = manifest.fragments[k_next] if k_next is not None else None
        return prev, nxt

    def _seamless_through(self, manifest: Manifest, prev: Fragment, nxt: Fragment, also: Fragment | None = None) -> bool:
        """
        Между живыми prev и nxt – только удалённые фрагменты, и вся цепочка
        шла встык (конец каждого = начало следующего): звук между ними был
        покадрово сплошным.
        """
        a, b = manifest.index_of(prev.id), manifest.index_of(nxt.id)
        chain = [f for f in manifest.fragments[a:b + 1]
                 if f is prev or f is nxt or f is also or (f.status != STATUS_ACTIVE and not f.split_into and not f.absorbed_into)]
        return all(x.algo_end_frame == y.algo_start_frame for x, y in zip(chain, chain[1:]))

    def _shift_start(self, manifest: Manifest, fragment: Fragment, new_start: int) -> None:
        """Левая граница фрагмента -> new_start (запас при нужде расширяется)."""
        fragment.algo_start_frame = new_start
        fragment.context_start_frame = min(fragment.context_start_frame, new_start)
        fragment.context_custom = (fragment.context_start_frame, fragment.context_end_frame) != self._default_context(manifest, fragment)

    @_locked
    def soft_delete(self, fragment_id: str, link: bool = False) -> Manifest:
        """
        Помечает status=deleted; редактор остаётся на этом же фрагменте.

        link – режим "связанные границы": если удалённый стоял встык с обоими
        живыми соседями, левая граница следующего живого сдвигается до правой
        границы предыдущего живого – склейка остаётся сплошной, а связь
        границ идёт сквозь удалённый. Если соседи и так стоят встык (части
        разделённого фрагмента – исходник лежит между ними), ничего не
        сдвигается: связь и так проходит сквозь удалённый.
        """
        manifest, before = self._begin()
        fragment = self._editable(manifest, fragment_id)
        index = manifest.index_of(fragment_id)
        prev, nxt = self._live_around(manifest, index)
        chained = bool(link and prev and nxt and prev.algo_end_frame <= fragment.algo_start_frame
                       and fragment.algo_end_frame <= nxt.algo_start_frame
                       and self._seamless_through(manifest, prev, nxt, also=fragment))
        fragment.status = STATUS_DELETED
        self._restore_merge_ingredients(manifest, fragment)
        if chained and prev.algo_end_frame < nxt.algo_start_frame < nxt.algo_end_frame:
            self._shift_start(manifest, nxt, prev.algo_end_frame)
        self._commit(manifest, before, fragment_id)
        return manifest

    @_locked
    def hard_delete(self, fragment_id: str) -> tuple[Manifest, str | None]:
        """
        Физически убирает фрагмент из массива. Разрешено только для
        результатов merge/split. Возвращает id ближайшего левого фрагмента.
        """
        manifest, before = self._begin()
        index = manifest.index_of(fragment_id)
        fragment = self._editable(manifest, fragment_id)
        if not fragment.hard_deletable:
            raise ValueError("окончательно удалить сразу можно только объединённый фрагмент или часть разделённого")
        self._restore_merge_ingredients(manifest, fragment)
        del manifest.fragments[index]
        if not manifest.fragments:
            nearest_left_id = None
        else:
            visible = [f for f in manifest.fragments if not f.exported]
            left = [f for f in manifest.fragments[:index] if not f.exported]
            nearest_left_id = left[-1].id if left else (visible[0].id if visible else None)
        self._commit(manifest, before, fragment_id)
        return manifest, nearest_left_id

    @_locked
    def merge(self, fragment_id: str, direction: str) -> tuple[Manifest, str]:
        """
        Объединяет с ближайшим живым соседом. Правки переходят в новый
        фрагмент: внешние границы – как их поправили (левая граница левого,
        правая – правого), исходные – original_* тех же фрагментов, поэтому
        разница видна на дорожке и Reset возвращает исходное; внутренние
        границы (стык) исчезают. Текст – текущие тексты подряд, исходный –
        исходные тексты подряд (правки текста тоже видны и откатываются).
        Реплики одного говорящего на стыке сливаются в одну строку
        ("A: x" + "A: y" -> "A: x y"). Где стык – self.last_junction
        (позиция в новом тексте, для подсветки в редакторе).
        Исходники остаются в массиве как deleted, новый встаёт между ними.
        """
        if direction not in ("next", "prev"):
            raise ValueError("direction должен быть 'next' или 'prev'")
        manifest, before = self._begin()
        self._editable(manifest, fragment_id)
        index = manifest.index_of(fragment_id)
        neighbor_index = self._nearest_live_neighbor_index(manifest, index, direction)
        if neighbor_index is None:
            raise ValueError(f"нет живого соседа в направлении {direction!r}")

        first_index, second_index = sorted((index, neighbor_index))
        first, second = manifest.fragments[first_index], manifest.fragments[second_index]

        merged_id = self._new_fragment_ids(manifest, 1)[0]
        text, junction, _, _ = join_texts(first.text, second.text)
        original_text, original_junction, offset, dropped = join_texts(first.original_text, second.original_text)
        # Отметки "на слух" (по исходному тексту) второго сдвигаются на его место
        # в склеенном; убранное имя говорящего отметку теряет.
        heard = [*first.heard_ranges, *shift_ranges(clip_ranges(second.heard_ranges, dropped), offset - dropped)]
        self.last_junction = junction
        merged = Fragment(
            id=merged_id,
            status=STATUS_ACTIVE,
            algo_start_frame=first.algo_start_frame,
            algo_end_frame=second.algo_end_frame,
            context_start_frame=first.context_start_frame,
            context_end_frame=second.context_end_frame,
            original_algo_start_frame=first.original_algo_start_frame,
            original_algo_end_frame=second.original_algo_end_frame,
            text=text,
            original_text=original_text,
            source_text="\n".join(t for t in (first.source_text, second.source_text) if t),
            needs_review=first.needs_review or second.needs_review,
            review_note=" / ".join(n for n in (first.review_note, second.review_note) if n),
            source_segment_ids=[*first.source_segment_ids, *second.source_segment_ids],
            merged_from=[first.id, second.id],
            junction=original_junction if first.original_text and second.original_text else None,
            # Между частями – удалённый фрагмент или зазор: он входит в отрезок
            # (без разрыва), но подсвечивается на дорожке.
            merged_gap=[first.algo_end_frame, second.algo_start_frame] if second.algo_start_frame > first.algo_end_frame else None,
            context_custom=first.context_custom or second.context_custom,
            heard_ranges=heard,
        )
        for ingredient in (first, second):
            ingredient.status = STATUS_DELETED
            ingredient.absorbed_into = merged_id
        manifest.fragments.insert(first_index + 1, merged)
        self._commit(manifest, before, fragment_id)
        return manifest, merged_id

    @_locked
    def split(self, fragment_id: str, current_frame: int) -> tuple[Manifest, str, str]:
        """
        Делит фрагмент по текущему кадру. Сам current_frame не дублируется и
        не теряется: он становится последним кадром ЛЕВОЙ части, правая
        начинается со следующего. Делить можно только строго внутри отрезка —
        не в запасе и не по первому/последнему кадру отрезка (иначе одна из
        частей вышла бы пустой или из одного кадра). Исходник помечается
        deleted (split_into) и остаётся открытым в редакторе; части встают
        слева и справа от него.

        Правки переходят в части: поправленная левая граница – в левую часть,
        правая – в правую (исходные – original_* исходника: разница видна,
        Reset возвращает). Текст из двух и больше предложений делится: первое
        предложение – левой части, остальное – правой (одно предложение –
        обеим целиком, как раньше); у исходника остаётся весь текст.
        """
        manifest, before = self._begin()
        index = manifest.index_of(fragment_id)
        original = self._editable(manifest, fragment_id)
        if not (original.algo_start_frame < current_frame < original.algo_end_frame - 1):
            raise ValueError("делить можно только внутри отрезка, не на его крайних кадрах")

        boundary = current_frame + 1
        total_frames = manifest.video.total_frames
        padding = frames_for_seconds(manifest.settings["context_padding_seconds"], manifest.video.fps)

        left_start = original.algo_start_frame
        right_end = original.algo_end_frame

        left_id, right_id = self._new_fragment_ids(manifest, 2)
        parts = split_texts(original.original_text, original.text, original.heard_ranges)
        common = dict(
            status=STATUS_ACTIVE,
            source_text=original.source_text,
            needs_review=original.needs_review,
            review_note=original.review_note,
            source_segment_ids=list(original.source_segment_ids),
            split_from=original.id,
            context_custom=original.context_custom,
        )
        left = Fragment(
            id=left_id,
            algo_start_frame=left_start,
            algo_end_frame=boundary,
            context_start_frame=original.context_start_frame,
            context_end_frame=min(total_frames, boundary + padding),
            original_algo_start_frame=original.original_algo_start_frame,
            original_algo_end_frame=boundary,
            **parts["left"],
            **common,
        )
        right = Fragment(
            id=right_id,
            algo_start_frame=boundary,
            algo_end_frame=right_end,
            context_start_frame=max(0, boundary - padding),
            context_end_frame=original.context_end_frame,
            original_algo_start_frame=boundary,
            original_algo_end_frame=original.original_algo_end_frame,
            **parts["right"],
            **common,
        )
        original.status = STATUS_DELETED
        original.split_into = [left_id, right_id]
        # Порядок как на видео: левая часть перед исходником, правая — после.
        manifest.fragments[index:index + 1] = [left, original, right]
        self._commit(manifest, before, fragment_id)
        return manifest, left_id, right_id

    # -- этап 3 -------------------------------------------------------------------

    @_locked
    def queue_for_stage3(self, through_fragment_id: str, default_deck: str) -> tuple[Manifest, list[str]]:
        """
        Передаёт на этап 3 все ещё не переданные фрагменты от начала видео до
        through_fragment_id включительно (кнопка "добавить в Anki"). Дальше
        их обрабатывает фоновый процесс phase3_export.worker; в редакторе их
        можно только просматривать, история правок по ним сбрасывается.
        Путь колоды Anki записывается в settings манифеста при первой передаче.
        """
        manifest = self.load()
        index = manifest.index_of(through_fragment_id)
        queued = []
        for fragment in manifest.fragments[: index + 1]:
            if not fragment.exported:
                fragment.exported = True
                queued.append(fragment.id)
                self.undo_stacks.pop(fragment.id, None)
                self.redo_stacks.pop(fragment.id, None)
        manifest.settings.setdefault("anki_deck", default_deck)
        self.save(manifest)
        return manifest, queued

    @_locked
    def unqueue_stage3(self, keep_ids: set[str]) -> tuple[Manifest, list[str]]:
        """
        Остановить передачу в Anki: фрагменты, переданные, но ещё не ставшие
        клипом/карточкой, снова редактируются. keep_ids — уже обработанные (или
        обрабатываемые прямо сейчас) — остаются переданными.
        """
        manifest = self.load()
        returned = []
        for fragment in manifest.fragments:
            if fragment.exported and fragment.id not in keep_ids:
                fragment.exported = False
                returned.append(fragment.id)
        self.save(manifest)
        return manifest, returned

    @_locked
    def return_from_stage3(self, fragment_ids: list[str]) -> Manifest:
        """
        Возвращает фрагменты из Anki на доработку (их карточки помечены
        флагом): они снова редактируются, в списке редактора видны как
        "помечены в Anki". Их запись в export/index.json отмечается redo —
        при следующей передаче в Anki клип переделается под тем же именем и
        обновится та же карточка, а не появится новая.
        """
        import json

        manifest = self.load()
        wanted = set(fragment_ids)
        for fragment in manifest.fragments:
            if fragment.id in wanted:
                fragment.exported = False
                fragment.anki_flagged = True
        self.save(manifest)
        index_path = self.project_dir / "export" / "index.json"
        if index_path.exists():
            index = json.loads(index_path.read_text(encoding="utf-8"))
            for entry in index:
                if entry["fragment_id"] in wanted:
                    entry["redo"] = True
            tmp_path = index_path.with_suffix(".json.tmp")
            tmp_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
            replace_file(tmp_path, index_path)
        return manifest


# -- текст при объединении и разделении ------------------------------------------------

import re as _re

# Говорящий в начале строки: до первого ":" не больше 3 слов (как в редакторе).
_SPEAKER_RE = _re.compile(r"^([^:\n]{1,40}?):\s*")
# Конец предложения: . ! ? … (и закрывающие кавычки/скобки), дальше – новое
# предложение с заглавной буквы (или кавычки) – "Well... if" не делится.
_SENTENCE_END_RE = _re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+(?=[\"'“‘(\[]?[A-ZА-ЯЁ0-9])")


def _speaker(line: str) -> str | None:
    match = _SPEAKER_RE.match(line)
    if not match or len(match.group(1).split()) > 3:
        return None
    return match.group(1).strip()


def join_texts(a: str, b: str) -> tuple[str, int, int, int]:
    """
    Тексты подряд для объединения. Последняя реплика первого и первая
    второго у одного говорящего – одна строка через пробел (имя второй
    реплики убирается), иначе – перенос строки. Возвращает (текст, стык –
    позиция пробела/переноса между фразами, с какой позиции в тексте идёт
    второй текст, сколько символов в начале второго текста убрано).
    """
    if not a:
        return b, 0, 0, 0
    if not b:
        return a, len(a), len(a), 0
    first_line = b.split("\n", 1)[0]
    speaker = _speaker(a.split("\n")[-1])
    if speaker and speaker == _speaker(first_line):
        dropped = _SPEAKER_RE.match(first_line).end()
        return f"{a} {b[dropped:]}", len(a), len(a) + 1, dropped
    return f"{a}\n{b}", len(a), len(a) + 1, 0


def clip_ranges(ranges: list[list[int]], start: int, end: int | None = None) -> list[list[int]]:
    """Части диапазонов внутри [start, end) (end=None – до конца)."""
    result = []
    for a, b in ranges:
        a, b = max(a, start), b if end is None else min(b, end)
        if a < b:
            result.append([a, b])
    return result


def _split_one(text: str) -> tuple[str, str, int, int] | None:
    """
    Делит текст после первого предложения: (левая часть, правая часть, с
    какой позиции текста начинается правая, длина повторённого в правой
    части имени говорящего). Одно предложение – None.
    """
    lines = text.split("\n")
    first = lines[0]
    match = _SPEAKER_RE.match(first)
    prefix = first[: match.end()] if match and _speaker(first) else ""
    body = first[len(prefix):]
    cut = _SENTENCE_END_RE.search(body)
    if cut:
        left = (prefix + body[: cut.start()]).rstrip()
        rest = body[cut.end():]
        right = "\n".join([prefix + rest, *lines[1:]])
        return left, right, len(prefix) + cut.end(), len(prefix)
    if len(lines) > 1:
        return first, "\n".join(lines[1:]), len(first) + 1, 0
    return None


def split_texts(original_text: str, text: str, heard: list[list[int]]) -> dict:
    """
    Тексты частей при разделении: {"left": {...}, "right": {...}} с text,
    original_text и heard_ranges. Исходный текст делится так же, как текущий
    (правки остаются видны); не делится одинаково – исходным частям берутся
    текущие (правки текста до разделения тогда не подсвечиваются).
    """
    cur = _split_one(text)
    if cur is None:
        carried = carry_ranges(original_text, text, heard)
        same = {"text": text, "original_text": text, "heard_ranges": carried}
        return {"left": dict(same), "right": {**same, "heard_ranges": list(carried)}}
    orig = _split_one(original_text) if original_text != text else cur
    if orig is not None:
        base, base_heard = orig, heard
    else:
        base, base_heard = cur, carry_ranges(original_text, text, heard)
    left_heard = clip_ranges(base_heard, 0, len(base[0]))
    right_heard = shift_ranges(clip_ranges(base_heard, base[2]), base[3] - base[2])
    return {
        "left": {"text": cur[0], "original_text": base[0], "heard_ranges": left_heard},
        "right": {"text": cur[1], "original_text": base[1], "heard_ranges": right_heard},
    }
