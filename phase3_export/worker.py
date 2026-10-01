# -*- coding: utf-8 -*-
"""
Фоновая очередь этапа 3: переданные фрагменты -> клипы -> карточки Anki.

Кнопка "добавить в Anki" в редакторе только помечает фрагменты exported
(мгновенно) и запускает этот процесс. Он живёт отдельно от редактора: его
не останавливает ни перезапуск редактора, ни переключение на другое видео,
а повторное нажатие кнопки просто добавляет фрагменты в хвост очереди —
процесс перечитывает манифесты по кругу, пока есть работа. Одновременно
работает только один такой процесс (блокировка файла data/.stage3_worker.lock).

Для каждого проекта в data/ (папка с manifest.json):
  1. каждый переданный живой фрагмент (и с текстом, и без — у пустых
     карточка с меткой без_текста), которого ещё нет в export/index.json,
     превращается в клип (phase3_export.export_clips.render_clip) и запись
     в index.json;
  2. для каждой записи без карточки создаётся карточка в Anki — или
     переиспользуется карточка фрагмента, из которого он получился
     (вернувшийся из Anki фрагмент объединили/разделили: его карточка
     остаётся на своём месте с новым клипом). Карточки фрагментов, которые
     удалили, удаляются из Anki;
  3. после изменений новые карточки всех видео выстраиваются по порядку
     фрагментов (anki.resequence): вставка в середину сдвигает последующие.
  Если Anki закрыт, клипы продолжают резаться, а карточки создаются, как
  только он откроется (повтор раз в ANKI_RETRY_SECONDS).
Манифест процесс только читает; пишет он index.json и файл состояния
export/stage3_status.json (редактор берёт из него скорость кодирования,
чтобы показать оставшееся время).

Запуск вручную: py -3.12 -m phase3_export.worker --data-dir data
"""
import argparse
import json
import msvcrt
import sys
import time
from datetime import datetime
from pathlib import Path

from common.manifest_schema import Manifest, STATUS_ACTIVE, replace_file, retry_windows_lock

from . import anki, rover_flags
from .export_clips import render_clip

DEFAULT_SECONDS_PER_FRAME = 0.16  # ~13 с на 3-секундный клип 4K (замер на RTX 5070 + CPU libx265)
ANKI_RETRY_SECONDS = 30
STATUS_FILE = "stage3_status.json"


def default_deck(project_dir: Path) -> str:
    """Claude::2. VIDEOS::<автор>::<видео>; автор — заданный в приложении или канал."""
    from webapp.library import app_settings, group_of, title_of

    def clean(name: str) -> str:
        return " ".join(name.replace("::", " ").replace('"', "").split()) or Path(project_dir).name

    group = clean(group_of(project_dir))
    title = clean(title_of(project_dir))
    deck_root = app_settings(Path(project_dir).parent)["anki_deck_root"].strip(":") or "Claude::2. VIDEOS"
    return f"{deck_root}::{group}::{title}"


def read_json(path: Path, default):
    try:
        return json.loads(retry_windows_lock(lambda: path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    # Windows: файл могут в этот момент читать (сервер редактора) — с повторами.
    replace_file(tmp_path, path)


def known_speakers(project: Path, manifest: Manifest) -> set[str]:
    """
    Говорящие этого видео: из источника текста (transcript.txt, строки
    "Имя: реплика") и из начал строк фрагментов — чтобы при записи в Anki
    отличать имя персонажа от обычного текста с двоеточием.
    """
    from phase1_ingest.sources.notion import dialogue_line

    names = set()
    transcript = project / "transcript.txt"
    if transcript.exists():
        for line in transcript.read_text(encoding="utf-8").splitlines():
            parsed = dialogue_line(line)
            if parsed:
                names.add(parsed[0])
    return names


def active_successors(manifest: Manifest, fragment_id: str) -> list:
    """
    Живые фрагменты, в которые превратился удалённый фрагмент (объединение —
    absorbed_into, разделение — split_into, по цепочке). Пусто — его просто удалили.
    """
    by_id = {f.id: f for f in manifest.fragments}
    result, queue, seen = [], [fragment_id], set()
    while queue:
        fid = queue.pop(0)
        if fid in seen or fid not in by_id:
            continue
        seen.add(fid)
        f = by_id[fid]
        if f.status == STATUS_ACTIVE:
            result.append(f)
        else:
            queue += [f.absorbed_into] if f.absorbed_into else []
            queue += list(f.split_into or [])
    order = {f.id: k for k, f in enumerate(manifest.fragments)}
    return sorted(result, key=lambda f: order[f.id])


def pending_fragments(manifest: Manifest, index: list[dict]) -> list:
    """
    Переданные фрагменты, по которым клипа ещё нет или его надо переделать
    (вернулся из Anki). Пустые (без текста) — тоже: у них карточка без_текста.
    """
    done = {entry["fragment_id"] for entry in index if not entry.get("redo")}
    return [
        f for f in manifest.fragments
        if f.exported and f.status == STATUS_ACTIVE and f.id not in done
    ]


class Worker:
    def __init__(self, data_dir: Path, only_project: Path | None = None):
        self.data_dir = Path(data_dir)
        self.only_project = Path(only_project) if only_project else None
        self.anki_ready = False
        self.speakers: dict[str, set[str]] = {}  # говорящие по видео (для меток Anki)
        self.anki_down_until = 0.0
        self.reorder_needed = False  # создавались/удалялись карточки — выровнять порядок

    def projects(self) -> list[Path]:
        if self.only_project:
            return [self.only_project]
        return sorted(d for d in self.data_dir.iterdir() if (d / "manifest.json").exists())

    def status(self, project: Path, state: str, message: str = "", **extra) -> None:
        out_dir = project / "export"
        out_dir.mkdir(exist_ok=True)
        previous = read_json(out_dir / STATUS_FILE, {})
        write_json(out_dir / STATUS_FILE, {
            "state": state,
            "message": message,
            "seconds_per_frame": extra.get("seconds_per_frame", previous.get("seconds_per_frame", DEFAULT_SECONDS_PER_FRAME)),
            "updated": time.time(),
        })

    def _anki_available(self) -> bool:
        return time.time() >= self.anki_down_until

    def _make_note(self, project: Path, deck: str, entry: dict) -> bool:
        """Создаёт карточку для записи index.json. False — Anki сейчас недоступен."""
        if not self._anki_available():
            return False
        try:
            if not self.anki_ready:
                anki.ensure_model()
                self.anki_ready = True
            anki.ensure_deck(deck)
            # Перевод, сделанный заранее (фрагмент перевели до передачи в Anki), —
            # сразу на оборот, если текст фрагмента с тех пор не менялся.
            from .translator import stored_translation

            back = stored_translation(project, entry["fragment_id"], entry["text"])
            try:
                entry["anki_note_id"] = anki.add_clip_note(
                    deck,
                    project / "export" / entry["clip"],
                    f"{project.name}_{entry['clip']}",
                    entry["text"],
                    project.name,
                    entry["fragment_id"],
                    entry["clip"],
                    self.speakers.get(project.name, set()),
                    back=back,
                    extra_tags=["агент_перевод"] if back else None,
                )
            except RuntimeError as error:
                # Карточка уже создана прошлым запуском, который упал, не успев
                # записать её номер в index.json, — находим её по тегу фрагмента.
                if "duplicate" not in str(error):
                    raise
                found = anki.invoke("findNotes", query=f'"tag:media-study::{project.name}::{entry["fragment_id"]}"')
                if not found:
                    raise
                entry["anki_note_id"] = found[0]
                print(f"{project.name}: {entry['clip']} — карточка уже была в Anki, привязал её", flush=True)
            entry["anki_deck"] = deck
            return True
        except anki.AnkiUnavailable as error:
            print(f"Anki недоступен: {error} — карточки создадутся позже", flush=True)
            self.anki_down_until = time.time() + ANKI_RETRY_SECONDS
            return False

    def _adopt_note(self, manifest: Manifest, index: list[dict], entry: dict):
        """
        Карточка для нового фрагмента от удалённого предшественника: первый
        по порядку преемник объединения/разделения забирает карточку
        предшественника (её место в колоде и история повторений сохраняются).
        """
        by_id = {f.id: f for f in manifest.fragments}
        for old in index:
            fragment = by_id.get(old["fragment_id"])
            if old is entry or not old.get("anki_note_id") or fragment is None or fragment.status == STATUS_ACTIVE:
                continue
            successors = active_successors(manifest, old["fragment_id"])
            if successors and successors[0].id == entry["fragment_id"]:
                note = (old["anki_note_id"], old.get("anki_deck"))
                old["anki_note_id"] = None  # карточка передана преемнику
                old["orphan"] = True
                return note
        return None

    def _drop_orphans(self, project: Path, manifest: Manifest, index: list[dict], index_path: Path) -> bool:
        """Записи удалённых фрагментов: карточку (если осталась) — из Anki, запись и клип — прочь."""
        by_id = {f.id: f for f in manifest.fragments}
        keep, drop = [], []
        for entry in index:
            fragment = by_id.get(entry["fragment_id"])
            gone = fragment is None or fragment.status != STATUS_ACTIVE
            # Пока преемник ещё правится (не передан в Anki снова) — ждём:
            # его карточка займёт место предшественника.
            waiting = gone and any(not s.exported for s in active_successors(manifest, entry["fragment_id"]))
            (drop if gone and not waiting else keep).append(entry)
        if not drop:
            return False
        try:
            anki.delete_notes([e["anki_note_id"] for e in drop if e.get("anki_note_id")])
        except anki.AnkiUnavailable:
            return False
        for entry in drop:
            for name in (entry.get("clip"), entry.get("text_file")):
                if name and not any(k.get("clip") == name or k.get("text_file") == name for k in keep):
                    (project / "export" / name).unlink(missing_ok=True)
            print(f"{project.name}: {entry['fragment_id']} удалён — его карточка убрана из Anki", flush=True)
        index[:] = keep
        write_json(index_path, index)
        self.reorder_needed = True
        return True

    def reorder(self) -> None:
        """
        Новые карточки всех видео — по порядку: видео в порядке их первых
        карточек в Anki, внутри видео — по порядку фрагментов на шкале времени.
        """
        projects = []
        for project in self.projects():
            manifest = Manifest.load(project / "manifest.json")
            index = read_json(project / "export" / "index.json", [])
            start = {f.id: f.algo_start_frame for f in manifest.fragments}
            notes = sorted(
                (e for e in index if e.get("anki_note_id")),
                key=lambda e: (start.get(e["fragment_id"], e.get("start_frame", 0)), e["clip"]),
            )
            if notes:
                projects.append([e["anki_note_id"] for e in notes])
        if not projects:
            return
        # Порядок видео — по наименьшему id карточки (кто раньше попал в Anki).
        projects.sort(key=min)
        moved = anki.resequence([n for notes in projects for n in notes])
        if moved:
            print(f"Порядок карточек в Anki обновлён: переставлено {moved}", flush=True)

    def _update_note(self, project: Path, entry: dict) -> bool:
        """Обновляет существующую карточку переделанным клипом и текстом. False — Anki недоступен."""
        if not self._anki_available():
            return False
        try:
            anki.update_clip_note(
                entry["anki_note_id"], project / "export" / entry["clip"], f"{project.name}_{entry['clip']}", entry["text"],
                project.name, entry["fragment_id"], self.speakers.get(project.name, set()),
            )
            entry.pop("anki_update_pending", None)
            return True
        except anki.AnkiUnavailable as error:
            print(f"Anki недоступен: {error} — карточка обновится позже", flush=True)
            self.anki_down_until = time.time() + ANKI_RETRY_SECONDS
            return False

    def process_project(self, project: Path) -> tuple[bool, bool]:
        """Один проход по проекту. Возвращает (что-то сделано, остались карточки без Anki)."""
        manifest = Manifest.load(project / "manifest.json")
        self.speakers[project.name] = known_speakers(project, manifest)
        out_dir = project / "export"
        out_dir.mkdir(exist_ok=True)
        index_path = out_dir / "index.json"
        index = read_json(index_path, [])
        deck = manifest.settings.get("anki_deck") or default_deck(project)
        fps = manifest.video.fps
        master = project / (manifest.video.master_file or manifest.video.source_file)
        spf = read_json(out_dir / STATUS_FILE, {}).get("seconds_per_frame", DEFAULT_SECONDS_PER_FRAME)
        # Аудио без видео -> звуковые клипы .m4a.
        audio_only = bool(read_json(project / "video_info.json", {}).get("audio_only"))
        ext = ".m4a" if audio_only else ".mp4"
        did = False

        for fragment in pending_fragments(manifest, index):
            self.status(project, "encoding", f"кодирую {fragment.id}", seconds_per_frame=spf)
            # Вернувшийся из Anki фрагмент переделывается под тем же именем клипа
            # (и обновляет ту же карточку), новый — получает следующий номер.
            redo = next((e for e in index if e["fragment_id"] == fragment.id and e.get("redo")), None)
            number = int(redo["clip"].split(".")[0]) if redo else max((int(e["clip"].split(".")[0]) for e in index), default=0) + 1
            name = f"{number:04d}"
            clip_path = out_dir / f"{name}{ext}"
            frames = fragment.algo_end_frame - fragment.algo_start_frame
            started = time.time()
            height = render_clip(master, project / "audio.pcm", clip_path, fragment.algo_start_frame, fragment.algo_end_frame, fps, audio_only)
            # Скорость кодирования — скользящее среднее, по ней редактор считает оставшееся время.
            spf = 0.7 * spf + 0.3 * (time.time() - started) / max(frames, 1)
            (out_dir / f"{name}.txt").write_text(fragment.text + "\n", encoding="utf-8")
            entry = {
                "clip": f"{name}{ext}",
                "text_file": f"{name}.txt",
                "text": fragment.text,
                "fragment_id": fragment.id,
                "start_frame": fragment.algo_start_frame,
                "end_frame": fragment.algo_end_frame,
                "start_seconds": round(fragment.algo_start_frame / fps, 6),
                "end_seconds": round(fragment.algo_end_frame / fps, 6),
                "frames": frames,
                "fps": fps,
                "height": height or "исходное",
                "size_bytes": clip_path.stat().st_size,
                "exported_at": datetime.now().isoformat(timespec="seconds"),
            }
            if redo:
                entry["anki_note_id"] = redo.get("anki_note_id")
                entry["anki_deck"] = redo.get("anki_deck")
                entry["redone_at"] = entry["exported_at"]
                index[index.index(redo)] = entry
            else:
                index.append(entry)
            write_json(index_path, index)
            first_line = fragment.text.splitlines()[0][:50] if fragment.text.strip() else "(без текста)"
            print(f"{project.name}: {name}{ext} ({frames} кадров, {clip_path.stat().st_size / 2**20:.1f} МБ) {first_line}", flush=True)
            if not redo:
                # Получился из вернувшегося фрагмента (объединение/разделение) —
                # берёт его карточку, она остаётся на своём месте.
                adopted = self._adopt_note(manifest, index, entry)
                if adopted:
                    entry["anki_note_id"], entry["anki_deck"] = adopted
            if entry.get("anki_note_id"):
                entry["anki_update_pending"] = True
                self._update_note(project, entry)
            else:
                self._make_note(project, deck, entry)
            write_json(index_path, index)
            did = True
            self.reorder_needed = True

        # Фрагменты, которые удалили (без живых преемников) или чьи преемники
        # уже получили свои карточки, — их карточки больше не нужны.
        if self._anki_available():
            did |= self._drop_orphans(project, manifest, index, index_path)

        for entry in [e for e in index if e.get("anki_update_pending")]:
            if not self._update_note(project, entry):
                break
            write_json(index_path, index)
            did = True
        without_note = [e for e in index if not e.get("anki_note_id") and not e.get("orphan")]
        for entry in without_note:
            self.status(project, "anki", "создаю карточки", seconds_per_frame=spf)
            if not self._make_note(project, deck, entry):
                break
            write_json(index_path, index)
            did = True
            self.reorder_needed = True
        waiting = any((not e.get("anki_note_id") and not e.get("orphan")) or e.get("anki_update_pending") for e in index)
        if did and not waiting:
            # Последние карточки переданы (с готовым переводом из хранилища) —
            # может, закончен этап 4: синие флаги Rover, один раз на видео.
            rover_flags.mark_if_finished(project, log=lambda m: print(m, flush=True))
        self.status(project, "waiting_anki" if waiting else "idle",
                    "жду Anki, чтобы создать карточки" if waiting else "", seconds_per_frame=spf)
        return did, waiting

    def run(self) -> None:
        while True:
            did_any = False
            waiting_any = False
            for project in self.projects():
                did, waiting = self.process_project(project)
                did_any |= did
                waiting_any |= waiting
            if did_any:
                continue
            if self.reorder_needed and self._anki_available():
                try:
                    self.reorder()
                    self.reorder_needed = False
                except anki.AnkiUnavailable:
                    self.anki_down_until = time.time() + ANKI_RETRY_SECONDS
            if waiting_any:
                time.sleep(ANKI_RETRY_SECONDS)
                continue
            return


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Фоновая очередь этапа 3: клипы и карточки Anki.")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--project-dir", help="Обработать только этот проект")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    lock = open(data_dir / ".stage3_worker.lock", "a+")
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        print("Очередь этапа 3 уже обрабатывается другим процессом.", flush=True)
        return
    Worker(data_dir, args.project_dir).run()
    print("Очередь этапа 3 пуста.", flush=True)


if __name__ == "__main__":
    main()
