# media-study

[Русский](README.ru.md) · **English**

A local app for learning a language from video and audio: a YouTube video,
your own file or a song is cut into short phrases, each phrase is polished in
a frame-accurate editor and becomes an Anki card — a clip with sound, the
original text and a translation.

Everything runs on your own machine: a FastAPI server and a page in the
browser (`http://127.0.0.1:8000`). The interface is in Russian or English
(Settings → Languages).

## Features

- **Adding media** — a YouTube link (via `yt-dlp`) or your own video/audio file.
- **Speech recognition** — local Whisper (faster-whisper, on the GPU via CUDA
  if available) or ElevenLabs Scribe via API.
- **Text alignment** — if a ready text exists (subtitles, a wiki script, a
  Notion page, song lyrics), the recognized words are replaced with it; an
  agent can find the source on its own.
- **Phrase splitting** — the SaT model (wtpsplit) plus punctuation, pauses and
  loudness; fragments cover the whole timeline with no gaps.
- **Editor** — frame-accurate boundary editing, text editing, deleting,
  merging and splitting fragments, edit history (Ctrl+Z), hotkeys.
- **Anki** — clips cut from the source in full quality (H.265), cards created
  via AnkiConnect in the background, new cards ordered by phrase order; cards
  flagged in Anki come back for editing. Optional reverse cards (translation
  on the front).
- **Translation** — models via OpenRouter with plot context and a glossary of
  names and terms; batch translation and refinement by flags.
- **Languages** — speech language and card language are set separately for
  video and audio (including Japanese/Chinese without spaces between words).
- **Packs** — markup, corrected texts and translations of a video can be
  exported as a `.mspack.json` file (without the video itself) and applied to
  the same video on another computer: the time offset is detected
  automatically.
- **Storage** — videos can be moved to another drive without leaving the app.

## Requirements

- Windows 10/11 (launched via `.bat`; the Python code itself is
  cross-platform but untested on other systems).
- Python 3.12 (`py -3.12`).
- For cards — [Anki](https://apps.ankiweb.net/) with the
  [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. The note
  type is chosen in Settings (Anki's Basic by default): the first field of the
  type becomes the front of the card, the second one — the back.
- Optional: an [OpenRouter](https://openrouter.ai/) key (translation, source
  search, AI text refinement) and an [ElevenLabs](https://elevenlabs.io/) key
  (Scribe recognition). They are entered in the app (Settings) and stored in
  the `secrets/` folder, which is not tracked by git.

No separate `ffmpeg` install is needed — it comes with the `imageio-ffmpeg`
package.

## Installation

```
git clone https://github.com/yndarra/media-study.git
cd media-study
py -3.12 -m pip install -r requirements.txt
```

## Running

- **`start.bat`** — double-click: the server starts without a window and the
  app opens in the browser. If the tab is already open, it just reloads. The
  server log is `data/server.log` (also in the app: bottom of the menu, Log).
- Manually: `py -3.12 -m media_study.web.run [--data-dir data] [--port 8000]`.

All videos, audio, clips and settings live in `data/` (created automatically,
not tracked by git).

## How to use it

1. **Add** — a link or a file; the Video/Audio mode is switched at the top of
   the menu.
2. **Processing** — optionally attach links to a text for alignment or a
   community pack, then start: download, editor copy, recognition, alignment,
   splitting (progress shown in percent).
3. **Video / Audio** — a list grouped by author with Edited, Sent to Anki and
   Translated bars; the video window shows stats, disk usage, and Edit, Send
   to Anki, Translate, Pack, Storage.
4. **Editor** — go through the fragments in order, fix boundaries and text.
   The Add to Anki button sends everything from the first fragment to the
   current one; clips and cards are made by a background process (Anki can be
   opened later).
5. **Translation** — the Translate button in the video window or Refine in the
   list.
6. **Statistics** — API costs, editing speed, summaries by video and author.

### Editor controls

Clicking the track sets the current frame; the triangles under the track are
the segment boundaries (a click selects a boundary, then the arrow keys move
it). The yellow marker shows where playback started. The phrase text is edited
in place on click: new text is green, deleted text stays in place in red.

Hotkeys (also work in the Russian keyboard layout, outside text fields):

| Key | Action |
|---|---|
| A / D | previous / next fragment |
| ← / → or Shift+A / Shift+D | frame back / forward (or the selected boundary) |
| Space | pause / play |
| W | replay from the segment start |
| Shift+Space | replay from the yellow marker |
| hold Shift | 2× speed while held |
| S | mark for deletion |
| R | speaker Rover (again — as before) |
| Q / E | segment start to the previous end / end to the next start |
| Shift+Q / Shift+E / Shift+W | select segment start / end / current frame |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo in the fragment history |
| Esc | leave the text field |

## Project structure

```
media-study/
├── start.bat                  app launcher
├── requirements.txt           Python dependencies
├── media_study/               all app code (Python package)
│   ├── core/                  shared by all parts
│   │   ├── manifest.py          manifest format: video, fragments, settings
│   │   ├── frames.py            frames <-> seconds
│   │   ├── audio.py             audio track (audio.pcm) and cuts from it
│   │   ├── waveform.py          loudness waveform for the editor track
│   │   ├── lang.py              speech and card languages
│   │   ├── context_bounds.py    padding before and after a segment
│   │   ├── text_clean.py        fragment text cleanup
│   │   ├── text_polish.py       text formatting (punctuation, case)
│   │   ├── progress.py          stage progress (for Processing)
│   │   ├── resources.py         how many CPU cores may be used
│   │   └── secrets.py           service keys from the secrets/ folder
│   ├── ingest/                stage 1: from a link or file to fragments
│   │   ├── cli.py               stage 1 entry point (called by the app)
│   │   ├── acquire.py           download by link / import your own file
│   │   ├── download.py          yt-dlp, subtitles
│   │   ├── reencode.py          editor copy (all-intra, ≤720p)
│   │   ├── speech/              speech recognition (Whisper, ElevenLabs)
│   │   ├── sources/             text sources (Notion, search agent)
│   │   ├── source_text.py       aligning the source with the recognized text
│   │   ├── boundaries.py        where to cut speech into phrases
│   │   ├── segment.py           fragments with full video coverage
│   │   ├── end_refine.py        refining ends by loudness
│   │   ├── reshape.py           reshaping fragments
│   │   ├── ai_fix.py            model refinement of unaligned text
│   │   ├── subtitles.py         subtitle parsing
│   │   ├── build_manifest.py    builds the manifest from all of the above
│   │   ├── rebuild.py           rebuild without downloading and recognition
│   │   └── batch_prepare.py     batch preparation of a playlist
│   ├── editing/               batch edits of a finished manifest
│   ├── export/                stage 3: Anki
│   │   ├── worker.py            background queue: clips -> cards
│   │   ├── clips.py             clip cutting
│   │   ├── anki.py              AnkiConnect: cards, colors, order
│   │   ├── reverse.py           reverse cards
│   │   ├── decks.py             decks
│   │   ├── translator.py        card translation (OpenRouter)
│   │   └── agent.py             translation and flag refinement agent
│   ├── packs.py               .mspack.json packs: export and apply
│   └── web/                   the app
│       ├── run.py               server launcher
│       ├── server.py            FastAPI app: data folder, video, startup
│       ├── api/                 API routes by section: system, media, ingest,
│       │                        settings, stage3, stats, anki, agent, editor
│       ├── library.py           video list, summaries, settings
│       ├── manifest_store.py    fragment edits with history (Ctrl+Z)
│       ├── storage.py           storage on other drives
│       └── static/              frontend
│           ├── index.html           markup and load order
│           ├── css/                 styles by area: base, library, modals,
│           │                        stats, settings, editor (order matters)
│           ├── js/                  pages around the editor
│           │   ├── format.js          formatting, sorting, languages
│           │   ├── dialogs.js         prompts, overlay window, forms
│           │   ├── motion.js          zebra bars, "Cancel?", progress bars
│           │   ├── shell.js           menu, video/audio mode, router, logs
│           │   └── pages/             sections: library, process, add, stats, settings
│           │   └── editor/            editor: state, view, app (core), text,
│           │                          bounds, modes, input (buttons, keys), main
│           ├── textedit.js, player.js, player, track, in-place text editing
│           │   timeline.js, audio.js …
│           ├── textfx.js            letter-by-letter text appearance
│           └── i18n.js, i18n-en.js  English interface
├── tools/                     utility scripts and .bat files
├── tests/                     tests
├── data/                      videos, audio and settings (not tracked by git)
└── secrets/                   OpenRouter and ElevenLabs keys (not tracked by git)
```

## Utilities

- Stage 1 without the app:
  `py -3.12 -m media_study.ingest.cli <url> --project-dir data/<id> [--transcript file.txt]`
  (or `tools\process_video.bat`).
- Rebuild the splitting without re-downloading and re-recognizing (manual edits
  are replaced, the old manifest is kept as `manifest.bak-<date-time>.json`):
  `py -3.12 -m media_study.ingest.rebuild --project-dir data/<id>`.
- Remove deleted fragments from the manifest:
  `py -3.12 -m tools.compact_manifest --project-dir data/<id>`.
- Interface strings missing an English translation:
  `py -3.12 -m tools.i18n_extract`.

## Tests

```
py -3.12 -m unittest discover -s tests -t .
```
