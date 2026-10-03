# -*- coding: utf-8 -*-
"""
Хранилища видео: основная папка data/ (на системном SSD) и дополнительные
папки на других дисках (например, внешний жёсткий диск), настройка "storages".

Как устроено: папка видео целиком лежит в выбранном хранилище, а в data/
вместо неё – ссылка-переход (NTFS junction) data/<код> -> <хранилище>/<код>.
Поэтому весь остальной код (редактор, обработка, Anki, перевод) работает с
data/<код> как раньше и ничего не знает о других дисках.

Диск отключён – ссылка "висит": видео в списке показывается как "Диск не
подключён" (название и автор – из data/storage_index.json, его пишет
перенос), открыть его нельзя, пока диск не вернётся.

Перенос (кнопка в окне видео): копия папки в новое место с ходом в "Сейчас
идёт", затем ссылка переставляется, и старая копия удаляется. Пока идёт
копирование, видео остаётся на старом месте целиком – если что-то сорвалось,
ничего не теряется (недокопированное удаляется).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

INDEX_FILE = "storage_index.json"  # код -> {title, group, storage}: для показа при отключённом диске

# Идущие переносы: код видео -> {"done", "total", "dest", "error", "finished"}.
MOVES: dict[str, dict] = {}
_lock = threading.Lock()


def _norm(path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def _target(link: Path) -> Path | None:
    """Куда ведёт ссылка data/<код> (None – это обычная папка)."""
    if not os.path.isjunction(link) and not os.path.islink(link):
        return None
    target = os.readlink(link)
    for prefix in ("\\\\?\\", "\\??\\"):
        if target.startswith(prefix):
            target = target[len(prefix):]
    return Path(target)


def _make_junction(link: Path, target: Path) -> None:
    """Ссылка-переход (прав администратора не нужно, работает между локальными дисками NTFS)."""
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                            capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0 or not os.path.isjunction(link):
        raise OSError(f"не удалось создать ссылку {link} -> {target}: {result.stdout or result.stderr}")


def _drive_label(path: Path) -> str:
    """Подпись диска: "D: TOSHIBA EXT" (метка тома, если есть)."""
    import ctypes

    drive = os.path.splitdrive(os.path.abspath(str(path)))[0] + "\\"
    name = ctypes.create_unicode_buffer(261)
    ok = ctypes.windll.kernel32.GetVolumeInformationW(drive, name, 261, None, None, None, None, 0)
    return f"{drive[:2]} {name.value}".strip() if ok and name.value else drive[:2]


def configured(data_dir: Path) -> list[str]:
    from .library import app_settings

    return [p for p in app_settings(data_dir).get("storages", []) if str(p).strip()]


def storages(data_dir: Path) -> list[dict]:
    """Все хранилища: основное (data/) и дополнительные – с местом на диске."""
    result = []
    for k, path in enumerate([str(Path(data_dir).resolve())] + configured(data_dir)):
        item = {"path": path, "main": k == 0, "label": _drive_label(Path(path)), "online": Path(path).exists()}
        if not item["online"]:
            # Папки ещё нет, но диск подключён – создадим при первом переносе.
            drive = os.path.splitdrive(os.path.abspath(path))[0] + "\\"
            item["online"] = Path(drive).exists()
        if item["online"]:
            probe = path if Path(path).exists() else os.path.splitdrive(os.path.abspath(path))[0] + "\\"
            usage = shutil.disk_usage(probe)
            item.update(free=usage.free, total=usage.total)
        result.append(item)
    return result


def location(data_dir: Path, project_id: str) -> dict:
    """Где лежит видео: {"path", "label", "main", "online"}."""
    link = Path(data_dir) / project_id
    target = _target(link)
    if target is None:
        return {"path": str(Path(data_dir).resolve()), "label": _drive_label(Path(data_dir)), "main": True, "online": True}
    root = target.parent
    return {"path": str(root), "label": _drive_label(root), "main": False, "online": target.exists()}


def offline_projects(data_dir: Path) -> list[dict]:
    """Видео на отключённых дисках (ссылка есть, а папки за ней нет)."""
    index = _load_index(data_dir)
    result = []
    for link in Path(data_dir).iterdir():
        target = _target(link)
        if target is None or target.exists():
            continue
        meta = index.get(link.name, {})
        result.append({"id": link.name, "title": meta.get("title") or link.name, "group": meta.get("group") or "Без автора",
                       "state": "offline", "storage": _drive_label(target.parent), "duration": meta.get("duration")})
    return result


def _load_index(data_dir: Path) -> dict:
    try:
        return json.loads((Path(data_dir) / INDEX_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remember(data_dir: Path, project_id: str) -> None:
    """Запомнить название и автора видео – чтобы показать его и при отключённом диске."""
    from .library import group_of, title_of, video_info

    project_dir = Path(data_dir) / project_id
    index = _load_index(data_dir)
    index[project_id] = {"title": title_of(project_dir), "group": group_of(project_dir),
                         "duration": video_info(project_dir).get("duration")}
    (Path(data_dir) / INDEX_FILE).write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def new_project_dir(data_dir: Path, project_id: str) -> Path:
    """
    Папка для нового видео: в хранилище "для новых видео" (настройка
    new_video_storage; пусто – основное). Возвращает data/<код> (ссылку или папку).
    """
    from .library import app_settings

    link = Path(data_dir) / project_id
    if link.exists() or os.path.isjunction(link):
        return link
    dest_root = (app_settings(data_dir).get("new_video_storage") or "").strip()
    if dest_root and _norm(dest_root) != _norm(Path(data_dir).resolve()) and dest_root in configured(data_dir):
        try:
            target = Path(dest_root) / project_id
            target.mkdir(parents=True, exist_ok=True)
            _make_junction(link, target)
            return link
        except OSError:
            pass  # диск не подключён – новое видео ляжет в основное хранилище
    link.mkdir(parents=True, exist_ok=True)
    return link


def _files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


def _rmtree(path: Path) -> bool:
    """Удалить папку (с повторами: файл мог быть ещё открыт). False – что-то осталось."""
    for _ in range(20):
        try:
            shutil.rmtree(path)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(0.5)
    return not path.exists()


def move(data_dir: Path, project_id: str, dest_root: str) -> None:
    """Перенести видео в хранилище dest_root (путь из storages). Ход – в MOVES[project_id]."""
    data_dir = Path(data_dir).resolve()
    link = data_dir / project_id
    state = {"done": 0, "total": 0, "dest": _drive_label(Path(dest_root)), "error": "", "finished": False,
             "started": time.time()}
    with _lock:
        MOVES[project_id] = state
    try:
        remember(data_dir, project_id)
        target_now = _target(link)
        source = target_now or link
        to_main = _norm(dest_root) == _norm(data_dir)
        if to_main and target_now is None or (target_now is not None and _norm(target_now.parent) == _norm(dest_root)):
            raise ValueError("Видео уже здесь")
        files = _files(source)
        state["total"] = sum(f.stat().st_size for f in files)
        # 1. Копия в новое место (старое не трогаем, пока копия не готова).
        # Временные папки – рядом с data/, а не в ней (иначе видео на время
        # переноса появилось бы в списке дважды).
        spare = data_dir.parent / "data.__moving"
        spare.mkdir(exist_ok=True)
        staging = (spare / f"{project_id}.new") if to_main else Path(dest_root) / project_id
        if staging.exists():
            _rmtree(staging)
        try:
            for f in files:
                dest = staging / f.relative_to(source)
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(f, "rb") as src, open(dest, "wb") as out:
                    while True:
                        chunk = src.read(8 * 1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        state["done"] += len(chunk)
                shutil.copystat(f, dest)
            for d in (p for p in source.rglob("*") if p.is_dir()):
                (staging / d.relative_to(source)).mkdir(parents=True, exist_ok=True)
        except BaseException:
            _rmtree(staging)
            raise
        # 2. Переставить: data/<код> – на новое место.
        if target_now is None:
            old = spare / f"{project_id}.old"
            try:
                link.rename(old)  # не выйдет, если файлы видео открыты (редактор)
            except OSError:
                _rmtree(staging)
                raise OSError("Файлы видео заняты – закройте его в редакторе и повторите")
        else:
            os.rmdir(link)  # убирает только ссылку, папка за ней остаётся
            old = target_now
        if to_main:
            staging.rename(link)
        else:
            _make_junction(link, staging)
        # 3. Старая копия больше не нужна.
        if not _rmtree(old):
            state["error"] = f"Перенесено, но старую папку удалить не удалось: {old}"
    except Exception as error:  # показать в окне видео
        state["error"] = str(error)
    finally:
        try:
            (data_dir.parent / "data.__moving").rmdir()  # пустая временная папка не нужна
        except OSError:
            pass
        state["finished"] = True
        state["finished_at"] = time.time()


def start_move(data_dir: Path, project_id: str, dest_root: str) -> None:
    current = MOVES.get(project_id)
    if current and not current["finished"]:
        raise ValueError("Перенос уже идёт")
    threading.Thread(target=move, args=(data_dir, project_id, dest_root), daemon=True).start()


def activity() -> list[dict]:
    """Переносы для "Сейчас идёт" (идущие и только что закончившиеся с ошибкой)."""
    items = []
    for project_id, st in list(MOVES.items()):
        if st["finished"]:
            continue
        gb = lambda n: f"{n / 2**30:.1f}"
        items.append({"kind": "move", "id": project_id, "title": project_id, "label": f"Перенос на {st['dest']}",
                      "detail": f"{gb(st['done'])}/{gb(st['total'])} ГБ" if st["total"] else "",
                      "percent": round(100 * st["done"] / st["total"], 1) if st["total"] else None, "eta_seconds": None})
    return items
