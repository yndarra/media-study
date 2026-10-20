# -*- coding: utf-8 -*-
"""
Переименование колоды видео: карточки переезжают, пустая старая колода и
пустые родители удаляются, непустые и чужие (с подколодами) — никогда.

Карточки без колоды (вернулись в удалённую колоду после синхронизации с
другим устройством) возвращаются в колоду видео; карточки в существующих
колодах не трогаются.
"""
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from media_study.core.manifest import Manifest, VideoInfo
from media_study.export import anki, decks


class FakeAnki:
    def __init__(self, decks_cards: dict[str, list[int]], tagged, lost: list[int] = ()):
        self.cards = {name: list(ids) for name, ids in decks_cards.items()}  # колода -> карточки
        # Метки: видео -> его карточки (список — одно видео "p").
        self.tagged = tagged if isinstance(tagged, dict) else {"p": list(tagged)}
        self.lost = set(lost)  # карточки, чьей колоды нет (did удалённой колоды)
        self.deleted = []
        self.calls = []

    def ids(self):
        return {name: k + 1 for k, name in enumerate(self.cards)}

    def _find(self, q):
        if q.startswith("did:"):
            deck_id = int(q.split(":")[1])
            name = next(n for n, i in self.ids().items() if i == deck_id)
            return list(self.cards[name])
        # ("tag:media-study::<видео>::*" OR "tag:media-study-rev::<видео>::*") [-did:1,2,…]
        pids = set(re.findall(r'"tag:media-study(?:-rev)?::([^:"]+)::\*"', q))
        assert pids, q
        found = [c for pid in sorted(pids) for c in self.tagged.get(pid, [])]
        if " -did:" in q:
            listed = {int(x) for x in q.split(" -did:")[1].split(",")}
            inside = {c for name, i in self.ids().items() if i in listed for c in self.cards[name]}
            found = [c for c in found if c not in inside]
        return found

    def __call__(self, action, **params):
        self.calls.append(action)
        if action == "multi":
            return [{"result": self(a["action"], **a.get("params", {})), "error": None} for a in params["actions"]]
        if action == "findCards":
            return self._find(params["query"])
        if action == "createDeck":
            self.cards.setdefault(params["deck"], [])
            return 1
        if action == "changeDeck":
            for ids in self.cards.values():
                ids[:] = [c for c in ids if c not in params["cards"]]
            self.lost -= set(params["cards"])
            self.cards[params["deck"]] += params["cards"]
            return None
        if action == "deckNamesAndIds":
            return self.ids()
        if action == "deleteDecks":
            for name in params["decks"]:
                assert not self.cards[name], f"удаляется непустая колода {name}"
                del self.cards[name]
                self.deleted.append(name)
            return None
        raise AssertionError(action)


class TestMoveProject(unittest.TestCase):
    def test_rename_author_moves_cards_and_removes_empty_old(self):
        fake = FakeAnki({
            "Claude": [], "Claude::2. VIDEOS": [], "Claude::2. VIDEOS::MrBeast": [],
            "Claude::2. VIDEOS::MrBeast::Video": [1, 2, 3],
            "Claude::2. VIDEOS::Other": [], "Claude::2. VIDEOS::Other::Clip": [9],
        }, tagged=[1, 2, 3])
        with mock.patch.object(anki, "invoke", fake):
            moved = decks.move_project("p", "Claude::2. VIDEOS::MrBeast::Video", "Claude::2. VIDEOS::Mr Beast::Video")
        self.assertEqual(moved, 3)
        self.assertEqual(fake.cards["Claude::2. VIDEOS::Mr Beast::Video"], [1, 2, 3])
        # Старая колода и пустой автор удалены; общий корень и чужие — нет.
        self.assertEqual(fake.deleted, ["Claude::2. VIDEOS::MrBeast::Video", "Claude::2. VIDEOS::MrBeast"])
        self.assertIn("Claude::2. VIDEOS::Other::Clip", fake.cards)
        self.assertIn("Claude::2. VIDEOS", fake.cards)

    def test_parent_with_other_videos_is_kept(self):
        fake = FakeAnki({
            "Claude": [], "Claude::V": [], "Claude::V::A": [],
            "Claude::V::A::One": [1], "Claude::V::A::Two": [2],
        }, tagged=[1])
        with mock.patch.object(anki, "invoke", fake):
            decks.move_project("p", "Claude::V::A::One", "Claude::V::A::One renamed")
        self.assertEqual(fake.deleted, ["Claude::V::A::One"])
        self.assertIn("Claude::V::A", fake.cards)

    def test_query_includes_reverse_cards(self):
        # Обратные карточки (своя метка media-study-rev) переезжают вместе с прямыми.
        self.assertIn('"tag:media-study::p::*"', decks._tags_query("p"))
        self.assertIn('"tag:media-study-rev::p::*"', decks._tags_query("p"))


def save_manifest(project_dir: Path, anki_deck: str | None) -> None:
    project_dir.mkdir(parents=True)
    video = VideoInfo(youtube_url="https://example.invalid/v", video_id=project_dir.name, title=project_dir.name,
                      fps=30.0, total_frames=300, source_file="source.mp4")
    settings = {"anki_deck": anki_deck} if anki_deck else {}
    Manifest(video=video, fragments=[], settings=settings).save(project_dir / "manifest.json")


class TestRepair(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        save_manifest(self.data / "a", "V::A")
        save_manifest(self.data / "b", "V::B")
        save_manifest(self.data / "new", None)  # в Anki ещё не передавали

    def tearDown(self):
        self.tmp.cleanup()

    def test_video_decks_from_manifests(self):
        self.assertEqual(decks._video_decks(self.data), {"a": "V::A", "b": "V::B"})
        self.assertEqual(decks._video_decks(self.data / "missing"), {})

    def test_lost_cards_return_to_video_deck(self):
        # 3 и 4 — без колоды; 5 пользователь перенёс в другую колоду сам.
        fake = FakeAnki({"V": [], "V::A": [1, 2], "V::B": [6], "Мои": [5]},
                        tagged={"a": [1, 2, 3, 4, 5], "b": [6]}, lost=[3, 4])
        with mock.patch.object(anki, "invoke", fake):
            repaired = decks.repair(self.data)
        self.assertEqual(repaired, [{"project": "a", "to": "V::A", "cards": 2}])
        self.assertEqual(fake.cards["V::A"], [1, 2, 3, 4])
        self.assertEqual(fake.cards["Мои"], [5])
        self.assertEqual(fake.cards["V::B"], [6])

    def test_video_deck_deleted_too(self):
        # Колоды видео самой нет (удалили вручную) — создаётся заново.
        fake = FakeAnki({"V": [], "V::A": [1]}, tagged={"a": [1], "b": [7]}, lost=[7])
        with mock.patch.object(anki, "invoke", fake):
            repaired = decks.repair(self.data)
        self.assertEqual(repaired, [{"project": "b", "to": "V::B", "cards": 1}])
        self.assertEqual(fake.cards["V::B"], [7])

    def test_nothing_lost_is_two_requests(self):
        fake = FakeAnki({"V": [], "V::A": [1, 2], "V::B": [6]}, tagged={"a": [1, 2], "b": [6]})
        with mock.patch.object(anki, "invoke", fake):
            self.assertEqual(decks.repair(self.data), [])
        self.assertEqual(fake.calls, ["deckNamesAndIds", "findCards"])

    def test_multi_error_is_raised(self):
        with mock.patch.object(anki, "invoke", lambda action, **p: [{"result": None, "error": "boom"}]):
            with self.assertRaises(RuntimeError):
                decks._multi([{"action": "findCards", "params": {"query": "x"}}])


if __name__ == "__main__":
    unittest.main()
