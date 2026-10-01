# -*- coding: utf-8 -*-
"""Юнит-тесты операций редактора: update/reset/soft-delete/hard-delete/merge/split."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.context_bounds import context_for
from common.manifest_schema import Fragment, Manifest, VideoInfo, STATUS_ACTIVE, STATUS_DELETED
from webapp.manifest_store import ManifestStore

FPS = 30.0
TOTAL_FRAMES = 300  # 10 секунд при 30 fps


def make_fixture_manifest() -> Manifest:
    """filler(0-30) "hello"(30-90) "world"(90-150) filler(150-180) "again"(180-300)."""
    raw = [
        ("frag_0000", 0, 30, ""),
        ("frag_0001", 30, 90, "hello"),
        ("frag_0002", 90, 150, "world"),
        ("frag_0003", 150, 180, ""),
        ("frag_0004", 180, 300, "again"),
    ]
    fragments = []
    for fid, start, end, text in raw:
        context_start, context_end = context_for(start, end, TOTAL_FRAMES, FPS, 5.0)
        fragments.append(Fragment(
            id=fid, status=STATUS_ACTIVE,
            algo_start_frame=start, algo_end_frame=end,
            context_start_frame=context_start, context_end_frame=context_end,
            original_algo_start_frame=start, original_algo_end_frame=end,
            text=text, source_text=text.upper(),
        ))
    video = VideoInfo(
        youtube_url="https://example.invalid/video", video_id="fixture", title="fixture",
        fps=FPS, total_frames=TOTAL_FRAMES, source_file="source.mp4",
    )
    return Manifest(video=video, fragments=fragments, settings={"context_padding_seconds": 5.0})


class ManifestStoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.project_dir = Path(self._tmp.name)
        make_fixture_manifest().save(self.project_dir / "manifest.json")
        self.store = ManifestStore(self.project_dir)

    def tearDown(self):
        self._tmp.cleanup()


class TestMerge(ManifestStoreTestCase):
    def test_merge_next_uses_original_bounds_and_inserts_between(self):
        manifest, merged_id = self.store.merge("frag_0001", "next")
        first, second, merged = (manifest.by_id(i) for i in ("frag_0001", "frag_0002", merged_id))
        self.assertEqual((first.status, first.absorbed_into), (STATUS_DELETED, merged_id))
        self.assertEqual((second.status, second.absorbed_into), (STATUS_DELETED, merged_id))
        self.assertEqual((merged.algo_start_frame, merged.algo_end_frame), (30, 150))
        self.assertEqual(merged.merged_from, ["frag_0001", "frag_0002"])
        self.assertTrue(merged.hard_deletable)
        ids = [f.id for f in manifest.fragments]
        self.assertLess(ids.index("frag_0001"), ids.index(merged_id))
        self.assertLess(ids.index(merged_id), ids.index("frag_0002"))

    def test_merge_ignores_prior_edits_of_bounds_and_text(self):
        self.store.update_fragment("frag_0001", algo_start_frame=40, algo_end_frame=80, text="edited")
        self.store.update_fragment("frag_0002", algo_start_frame=100, algo_end_frame=140)
        manifest, merged_id = self.store.merge("frag_0001", "next")
        merged = manifest.by_id(merged_id)
        self.assertEqual((merged.algo_start_frame, merged.algo_end_frame), (30, 150))
        self.assertEqual(merged.text, "hello\nworld")
        self.assertFalse(merged.edited)

    def test_soft_delete_of_merge_result_restores_ingredients(self):
        _, merged_id = self.store.merge("frag_0001", "next")
        manifest = self.store.soft_delete(merged_id)
        for ingredient_id in ("frag_0001", "frag_0002"):
            ingredient = manifest.by_id(ingredient_id)
            self.assertEqual(ingredient.status, STATUS_ACTIVE)
            self.assertIsNone(ingredient.absorbed_into)
        self.assertEqual(manifest.by_id(merged_id).status, STATUS_DELETED)

    def test_hard_delete_of_merge_result_restores_ingredients_and_moves_to_nearest_left(self):
        _, merged_id = self.store.merge("frag_0001", "next")
        manifest, nearest_left_id = self.store.hard_delete(merged_id)
        self.assertNotIn(merged_id, [f.id for f in manifest.fragments])
        self.assertEqual(manifest.by_id("frag_0001").status, STATUS_ACTIVE)
        self.assertEqual(manifest.by_id("frag_0002").status, STATUS_ACTIVE)
        self.assertEqual(nearest_left_id, "frag_0001")

    def test_hard_delete_of_regular_fragment_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.hard_delete("frag_0001")


class TestSplit(ManifestStoreTestCase):
    def test_current_frame_goes_to_left_part(self):
        manifest, left_id, right_id = self.store.split("frag_0004", 240)
        original, left, right = (manifest.by_id(i) for i in ("frag_0004", left_id, right_id))
        self.assertEqual(original.status, STATUS_DELETED)
        self.assertEqual(original.split_into, [left_id, right_id])
        # Кадр 240 — последний кадр левой части, правая начинается с 241.
        self.assertEqual((left.algo_start_frame, left.algo_end_frame), (180, 241))
        self.assertEqual((right.algo_start_frame, right.algo_end_frame), (241, 300))
        self.assertTrue(left.hard_deletable and right.hard_deletable)
        # Порядок как на видео: левая часть — перед исходником, правая — после.
        ids = [f.id for f in manifest.fragments]
        position = ids.index("frag_0004")
        self.assertEqual(ids[position - 1:position + 2], [left_id, "frag_0004", right_id])

    def test_split_only_strictly_inside_segment(self):
        # frag_0004 — отрезок 180..300: нельзя в запасе и на кадрах 180 и 299.
        for frame in (100, 179, 180, 299):
            with self.assertRaises(ValueError):
                self.store.split("frag_0004", frame)
        self.store.split("frag_0004", 181)
    def test_merge_of_split_children_reconstructs_original_range(self):
        _, left_id, _ = self.store.split("frag_0004", 240)
        manifest, merged_id = self.store.merge(left_id, "next")
        merged = manifest.by_id(merged_id)
        self.assertEqual((merged.algo_start_frame, merged.algo_end_frame), (180, 300))


class TestUpdateAndReset(ManifestStoreTestCase):
    def test_text_edit_marks_fragment_edited_and_reset_restores_it(self):
        manifest = self.store.update_fragment("frag_0001", text="hel")
        self.assertTrue(manifest.by_id("frag_0001").edited)
        fragment = self.store.reset("frag_0001").by_id("frag_0001")
        self.assertFalse(fragment.edited)
        self.assertEqual(fragment.text, "hello")

    def test_reset_restores_original_bounds_after_edit(self):
        self.store.update_fragment("frag_0001", algo_start_frame=40, algo_end_frame=80)
        fragment = self.store.reset("frag_0001").by_id("frag_0001")
        self.assertEqual((fragment.algo_start_frame, fragment.algo_end_frame), (30, 90))

    def test_update_rejects_inverted_bounds(self):
        with self.assertRaises(ValueError):
            self.store.update_fragment("frag_0001", algo_start_frame=100, algo_end_frame=50)

    def test_changing_padding_in_settings_recomputes_context_on_load(self):
        manifest = self.store.load()
        manifest.settings["context_padding_seconds"] = 1.0  # 30 кадров
        manifest.save(self.project_dir / "manifest.json")
        fragment = self.store.load().by_id("frag_0002")  # исходно 90..150
        self.assertEqual((fragment.context_start_frame, fragment.context_end_frame), (60, 180))

    def test_context_does_not_move_when_bounds_are_edited(self):
        before = self.store.load().by_id("frag_0002")
        after = self.store.update_fragment("frag_0002", algo_start_frame=95).by_id("frag_0002")
        self.assertEqual(
            (before.context_start_frame, before.context_end_frame),
            (after.context_start_frame, after.context_end_frame),
        )


class TestResetRestoresDeleted(ManifestStoreTestCase):
    def test_reset_removes_delete_mark(self):
        self.store.soft_delete("frag_0001")
        self.store.update_fragment("frag_0001", algo_start_frame=40)
        fragment = self.store.reset("frag_0001").by_id("frag_0001")
        self.assertEqual(fragment.status, STATUS_ACTIVE)
        self.assertEqual(fragment.algo_start_frame, 30)

    def test_reset_of_deleted_merge_result_reabsorbs_ingredients(self):
        _, merged_id = self.store.merge("frag_0001", "next")
        self.store.soft_delete(merged_id)
        manifest = self.store.reset(merged_id)
        self.assertEqual(manifest.by_id(merged_id).status, STATUS_ACTIVE)
        for ingredient_id in ("frag_0001", "frag_0002"):
            self.assertEqual(manifest.by_id(ingredient_id).absorbed_into, merged_id)

    def test_reset_of_split_source_removes_its_parts(self):
        _, left_id, right_id = self.store.split("frag_0004", 240)
        manifest = self.store.reset("frag_0004")
        ids = [f.id for f in manifest.fragments]
        self.assertNotIn(left_id, ids)
        self.assertNotIn(right_id, ids)
        fragment = manifest.by_id("frag_0004")
        self.assertEqual((fragment.status, fragment.split_into), (STATUS_ACTIVE, None))

    def test_reset_of_merge_ingredient_undoes_the_merge(self):
        _, merged_id = self.store.merge("frag_0001", "next")
        manifest = self.store.reset("frag_0002")
        self.assertNotIn(merged_id, [f.id for f in manifest.fragments])
        for ingredient_id in ("frag_0001", "frag_0002"):
            self.assertEqual(manifest.by_id(ingredient_id).status, STATUS_ACTIVE)
class TestSidePadding(ManifestStoreTestCase):
    """Запас 5 с = 150 кадров; видео 300 кадров. frag_0002 исходно 90..150, контекст 0..300."""

    def setUp(self):
        super().setUp()
        # Общий запас 1 с (30 кадров), чтобы было куда расти: frag_0002 -> 60..180.
        manifest = self.store.load()
        manifest.settings["context_padding_seconds"] = 1.0
        manifest.save(self.project_dir / "manifest.json")

    def test_plus_takes_what_is_left_up_to_video_edge_then_blocks(self):
        # Слева от 60 до края видео 60 кадров (<150) — берётся сколько есть.
        fragment = self.store.change_side_padding("frag_0002", "left", 1).by_id("frag_0002")
        self.assertEqual((fragment.context_start_frame, fragment.context_end_frame), (0, 180))
        self.assertTrue(fragment.context_custom)
        self.assertFalse(fragment.edited)
        with self.assertRaises(ValueError):
            self.store.change_side_padding("frag_0002", "left", 1)

    def test_minus_never_goes_below_three_seconds_from_original_bound(self):
        # Шаг 3 с = 90 кадров. Справа: 180 -> 270 -> 300 (край видео),
        # вниз: 300 -> 240 (= исходный конец 150 + 90), дальше нельзя.
        self.store.change_side_padding("frag_0002", "right", 1)
        fragment = self.store.change_side_padding("frag_0002", "right", 1).by_id("frag_0002")
        self.assertEqual(fragment.context_end_frame, 300)
        fragment = self.store.change_side_padding("frag_0002", "right", -1).by_id("frag_0002")
        self.assertEqual(fragment.context_end_frame, 240)
        with self.assertRaises(ValueError):
            self.store.change_side_padding("frag_0002", "right", -1)

    def test_minus_blocked_when_side_is_already_short(self):
        # Слева всего 30 кадров (1 с) — уменьшать нельзя.
        with self.assertRaises(ValueError):
            self.store.change_side_padding("frag_0002", "left", -1)

    def test_custom_padding_survives_global_setting_change(self):
        self.store.change_side_padding("frag_0002", "left", 1)  # 0..180
        manifest = self.store.load()
        manifest.settings["context_padding_seconds"] = 2.0
        manifest.save(self.project_dir / "manifest.json")
        fragment = self.store.load().by_id("frag_0002")
        self.assertEqual((fragment.context_start_frame, fragment.context_end_frame), (0, 180))
        # Фрагмент без ручного запаса пересчитан по новому общему (2 с = 60 кадров).
        other = self.store.load().by_id("frag_0003")  # 150..180
        self.assertEqual((other.context_start_frame, other.context_end_frame), (90, 240))

    def test_reset_returns_padding_to_global_value(self):
        self.store.change_side_padding("frag_0002", "left", 1)
        fragment = self.store.reset("frag_0002").by_id("frag_0002")
        self.assertEqual((fragment.context_start_frame, fragment.context_end_frame), (60, 180))
        self.assertFalse(fragment.context_custom)


class TestPerFragmentHistory(ManifestStoreTestCase):
    def test_undo_touches_only_own_fragment(self):
        self.store.update_fragment("frag_0001", text="one")
        self.store.update_fragment("frag_0002", text="two")
        manifest, focus = self.store.undo("frag_0001")
        self.assertEqual(focus, "frag_0001")
        self.assertEqual(manifest.by_id("frag_0001").text, "hello")
        self.assertEqual(manifest.by_id("frag_0002").text, "two")
        self.assertFalse(self.store.can_undo("frag_0001"))
        self.assertTrue(self.store.can_redo("frag_0001"))
        manifest, _ = self.store.redo("frag_0001")
        self.assertEqual(manifest.by_id("frag_0001").text, "one")

    def test_consecutive_text_saves_are_one_undo_step(self):
        for text in ("he", "hel", "help"):
            self.store.update_fragment("frag_0001", text=text)
        manifest, _ = self.store.undo("frag_0001")
        self.assertEqual(manifest.by_id("frag_0001").text, "hello")
        self.assertFalse(self.store.can_undo("frag_0001"))

    def test_undo_merge_from_result_restores_exact_fragments_and_order(self):
        before = self.store.load().to_dict()
        _, merged_id = self.store.merge("frag_0001", "next")
        self.assertTrue(self.store.can_undo("frag_0002"))
        manifest, focus = self.store.undo(merged_id)
        self.assertEqual(manifest.to_dict()["fragments"], before["fragments"])
        self.assertEqual(focus, "frag_0001")  # результата больше нет — открываем исходник
        manifest, focus = self.store.redo("frag_0001")
        self.assertEqual(focus, "frag_0001")
        self.assertEqual([f.id for f in manifest.fragments][1:4], ["frag_0001", merged_id, "frag_0002"])

    def test_undo_split_puts_parts_away_and_keeps_order(self):
        before = self.store.load().to_dict()
        _, left_id, _ = self.store.split("frag_0004", 240)
        manifest, focus = self.store.undo("frag_0004")
        self.assertEqual(manifest.to_dict()["fragments"], before["fragments"])
        self.assertEqual(focus, "frag_0004")

    def test_undo_blocked_when_touched_neighbor_changed_later(self):
        _, left_id, _ = self.store.split("frag_0004", 240)
        self.store.update_fragment(left_id, text="changed")
        with self.assertRaises(ValueError):
            self.store.undo("frag_0004")
        self.store.undo(left_id)
        self.store.undo("frag_0004")

    def test_new_edit_clears_redo_and_failed_operation_leaves_no_history(self):
        self.store.update_fragment("frag_0001", algo_start_frame=31)
        self.store.undo("frag_0001")
        self.store.update_fragment("frag_0001", algo_start_frame=32)
        self.assertFalse(self.store.can_redo("frag_0001"))
        with self.assertRaises(ValueError):
            self.store.hard_delete("frag_0002")
        self.assertFalse(self.store.can_undo("frag_0002"))
        with self.assertRaises(ValueError):
            self.store.undo("frag_0002")


class TestStage3Queue(ManifestStoreTestCase):
    def test_queue_locks_fragments_and_return_unlocks_them(self):
        import json

        manifest, queued = self.store.queue_for_stage3("frag_0002", "Deck")
        self.assertEqual(queued, ["frag_0000", "frag_0001", "frag_0002"])
        self.assertEqual(manifest.settings["anki_deck"], "Deck")
        with self.assertRaises(ValueError):
            self.store.update_fragment("frag_0001", text="x")
        # Клип уже выгружен — после возврата его запись помечается на переделку.
        export_dir = self.project_dir / "export"
        export_dir.mkdir()
        (export_dir / "index.json").write_text(json.dumps([{"fragment_id": "frag_0001", "clip": "0001.mp4"}]), encoding="utf-8")
        manifest = self.store.return_from_stage3(["frag_0001"])
        fragment = manifest.by_id("frag_0001")
        self.assertEqual((fragment.exported, fragment.anki_flagged), (False, True))
        self.assertTrue(json.loads((export_dir / "index.json").read_text(encoding="utf-8"))[0]["redo"])
        self.store.update_fragment("frag_0001", text="fixed")
        self.assertTrue(self.store.load().by_id("frag_0002").exported)



class TestTextMarks(ManifestStoreTestCase):
    """Разметка правки текста (красное/зелёное) хранится вместе с текстом."""

    def test_marks_saved_with_text(self):
        # Удалили "hello" и набрали его же: текст тот же, но разметка – красное + зелёное.
        manifest = self.store.update_fragment("frag_0001", text="hello", text_marks="dddddiiiii")
        self.assertEqual(manifest.by_id("frag_0001").text_marks, "dddddiiiii")
        self.assertEqual(self.store.load().by_id("frag_0001").text_marks, "dddddiiiii")

    def test_text_without_marks_clears_them(self):
        self.store.update_fragment("frag_0001", text="hello", text_marks="dddddiiiii")
        manifest = self.store.update_fragment("frag_0001", text="hello!")
        self.assertEqual(manifest.by_id("frag_0001").text_marks, "")

    def test_reset_clears_marks(self):
        self.store.update_fragment("frag_0001", text="hello", text_marks="dddddiiiii")
        manifest = self.store.reset("frag_0001")
        self.assertEqual(manifest.by_id("frag_0001").text_marks, "")


if __name__ == "__main__":
    unittest.main()
