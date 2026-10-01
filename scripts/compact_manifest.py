# -*- coding: utf-8 -*-
"""
Поздний проход по манифесту: физически убирает все status=="deleted"
фрагменты (пометки от soft-delete/merge/split), которые редактор
намеренно оставляет в массиве вместо мгновенного удаления. Сам редактор
этого не делает — только явный отдельный запуск этого скрипта.

Использование:
  py -3.12 -m scripts.compact_manifest --project-dir data/<video_id>
"""
import argparse
from pathlib import Path

from common.manifest_schema import Manifest, STATUS_ACTIVE


def compact(project_dir: Path) -> tuple[int, int]:
    manifest_path = Path(project_dir) / "manifest.json"
    manifest = Manifest.load(manifest_path)
    before = len(manifest.fragments)
    manifest.fragments = [f for f in manifest.fragments if f.status == STATUS_ACTIVE]
    manifest.save(manifest_path)
    return before, len(manifest.fragments)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", required=True)
    args = parser.parse_args()

    before, after = compact(Path(args.project_dir))
    print(f"Было фрагментов: {before}, осталось: {after}, удалено окончательно: {before - after}")


if __name__ == "__main__":
    main()
