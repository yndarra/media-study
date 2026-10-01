# -*- coding: utf-8 -*-
"""
Проверяет, что backend отдаёт видео с поддержкой HTTP Range (206 Partial
Content) — от этого зависит перемотка в браузерном <video>.
"""
import importlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from imageio_ffmpeg import get_ffmpeg_exe

from common.manifest_schema import Fragment, Manifest, VideoInfo, STATUS_ACTIVE


def _make_tiny_video(path: Path) -> None:
    ffmpeg = get_ffmpeg_exe()
    subprocess.run(
        [
            ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10",
            "-pix_fmt", "yuv420p", str(path),
        ],
        check=True, capture_output=True,
    )


def _make_tiny_manifest(project_dir: Path) -> None:
    fragment = Fragment(
        id="frag_0000", status=STATUS_ACTIVE,
        algo_start_frame=0, algo_end_frame=10,
        context_start_frame=0, context_end_frame=10,
        original_algo_start_frame=0, original_algo_end_frame=10,
        text="",
    )
    video = VideoInfo(
        youtube_url="https://example.invalid", video_id="tiny", title="tiny",
        fps=10.0, total_frames=10, source_file="source.mp4",
    )
    Manifest(video=video, fragments=[fragment]).save(project_dir / "manifest.json")


class TestVideoRangeServing(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.project_dir = Path(self._tmp.name) / "tiny"
        self.project_dir.mkdir()
        _make_tiny_video(self.project_dir / "source.mp4")
        _make_tiny_manifest(self.project_dir)

        os.environ["MEDIA_STUDY_DATA_DIR"] = str(self.project_dir.parent)
        import webapp.server as server_module
        importlib.reload(server_module)  # пере-читать DATA_DIR под новый temp dir

        from fastapi.testclient import TestClient
        self.client = TestClient(server_module.app)

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("MEDIA_STUDY_DATA_DIR", None)

    def test_manifest_endpoint_returns_fragments(self):
        response = self.client.get("/api/p/tiny/manifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["fragments"]), 1)

    def test_projects_list_shows_video(self):
        projects = self.client.get("/api/projects").json()
        self.assertEqual([p["id"] for p in projects], ["tiny"])
        self.assertEqual(projects[0]["state"], "ready")

    def test_range_request_returns_partial_content(self):
        full = self.client.get("/media/tiny/source.mp4")
        self.assertEqual(full.status_code, 200)
        self.assertGreater(len(full.content), 10)

        partial = self.client.get("/media/tiny/source.mp4", headers={"Range": "bytes=0-9"})
        self.assertEqual(partial.status_code, 206)
        self.assertEqual(len(partial.content), 10)
        self.assertIn("Content-Range", partial.headers)
        self.assertTrue(partial.headers["Content-Range"].startswith("bytes 0-9/"))


if __name__ == "__main__":
    unittest.main()
