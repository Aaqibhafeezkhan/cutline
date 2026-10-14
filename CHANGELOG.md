# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chat with Claude inside the editor**: a collapsible Chat panel (toolbar button or `Ctrl+K`)
  where you can type "Make this a 30-second short" without Claude Desktop. The server runs an agent
  loop with the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`) over the existing MCP tools,
  called in-process and scoped to the open project, so every edit is a normal operation: it shows up
  live with the agent highlight and `Ctrl+Z` undoes it. Replies stream over
  `POST /api/projects/:id/chat` (server-sent events) with text, tool-call chips, errors, a Stop
  button and "New chat"; `get_frames` images are passed to the model so it can look at the video.
  At most 20 tool calls per message. Enable it by setting `ANTHROPIC_API_KEY` in the server
  environment (it never reaches the browser); `CUTLINE_CHAT_MODEL` (default `claude-opus-5-5`) and
  `CUTLINE_CHAT_EFFORT` (default `medium`) tune it. Without a key the panel explains how to enable it.
- **Transcript editing**: edit the video by editing its transcript. The editor's new Transcript
  panel shows the timeline's words as text (paragraphs at pauses), highlights the word being
  spoken and seeks on click. Select words (drag, Shift+click or Shift+arrow keys) and press
  Delete/Backspace to cut exactly those words out of all unlocked tracks with one ripple
  `delete_range` (one undo step); the right-click menu also offers "Remove fillers". The new MCP
  tool `delete_words` does the same for agents, by exact phrase (`text`, with `occurrence` or
  `all`) or by word index range, with `dryRun`. Core exports the pure helpers
  `wordRangesToCuts`, `findPhraseInWords` and `groupParagraphs`; the server adds a
  `POST /api/projects/:id/transcript` route that returns cached (or freshly transcribed) per-asset
  words. The MCP server now exposes 34 tools.
- **Chapters, markers and highlight reels**: projects can hold markers (`chapter`, `note`,
  `highlight` with an optional end) that follow ripple edits of the whole timeline (`delete_range`,
  and ripple trims/deletes on the main video track). New core operations `add_markers`,
  `update_marker`, `remove_markers`, `set_chapters` (validates order and YouTube's rules: first at
  0, at least 3, each at least 10 s) and `assemble_ranges` (lays timeline ranges back-to-back with
  everything they show, optional crossfades; labelled ranges become chapters). Five new MCP tools:
  `get_chapters_input` (transcript sentences grouped into ~20–60 s blocks plus scene cuts,
  silences and loud moments, so an agent can pick chapters and highlights in one call),
  `set_chapters`, `export_chapters` (YouTube description text, ffmetadata or JSON),
  `mark_highlights` and `create_highlight_reel` (new project or appended, optional 9:16/1:1
  output size). Server-rendered MP4s embed the chapters. The editor draws chapters as labelled
  flags and highlights as coloured spans on the ruler (click seeks, double-click renames, Del
  removes, `M` adds a note at the playhead) and has a Chapters panel with "Copy for YouTube".
  `get_project` lists chapters and markers. The MCP server now exposes 39 tools.

## [0.3.0] - 2026-10-13

Audio and branding: remove filler words, detect beats and cut on the beat, duck music under
speech, normalize loudness, and define a brand kit once per project. Agents get six new MCP tools;
as before, the browser engine and the server renderer produce the same result.

### Added

- **Remove filler words**: the new `remove_filler_words` MCP tool transcribes the timeline, finds
  hesitations ("um", "uh", "er", "hmm", "äh", "ähm", "öhm", … — case and punctuation are ignored)
  and cuts them with a single ripple `delete_range` (one undo step). `dryRun` previews the cuts,
  `fillers` replaces the word list, `repeats` also removes stutters like "I I think", and padding
  never reaches into neighbouring words. The editor's captions panel has a matching "Remove
  fillers" button; core exports the pure `findFillerRanges` helper. Whisper often leaves
  disfluencies out of its transcript, so only fillers it wrote down can be found.
- **Beat detection and cutting on the beat**: a pure-TypeScript beat tracker (spectral-flux onset
  envelope, autocorrelation tempo estimate with an 80–160 BPM preference, dynamic-programming beat
  grid, downbeats when clear) with results cached per asset. New MCP tools `detect_beats` (BPM,
  confidence, beat and downbeat times in asset and timeline seconds) and `cut_to_beats` (lays the
  main video track's clips, or the given clips, back-to-back so every cut lands on every Nth beat,
  as one undo step built from `move_clip`/`trim_clip`). The editor shows beat ticks on clips whose
  beats are known, snaps timeline drags to them, and has a "Detect beats" button for audio and
  video clips (new REST route `GET`/`POST /api/projects/:id/assets/:assetId/beats`). New synthetic
  fixture `clicks-120bpm-8s.wav`.
- **Auto-ducking**: background music gets quieter automatically while someone speaks. The new
  `duck_music` MCP tool finds speech on the voice track(s) (cached transcript word timings, or
  non-silent ranges) and picks the music track by itself when it can; the new `duck_audio`
  operation stores a clip-relative ducking envelope (`amountDb`, `attack`, `release`) that the
  resolver turns into gain points, so the browser engine and the ffmpeg renderer both follow it
  and it survives trims, splits and ripple cuts. Re-running replaces the previous ducking.
- **Loudness normalization**: the new `normalize_loudness` MCP tool measures EBU R128 integrated
  loudness and true peak per clip with ffmpeg `ebur128` (cached per asset range) and sets clip
  volumes to hit a LUFS target (default -14), capped by a true-peak ceiling and the ×4 volume
  limit. The Audio section of the properties panel has "Duck under speech" and "Normalize
  loudness" buttons (REST: `POST /api/projects/:id/audio/duck` and `/audio/normalize`).
- **Brand kit**: an optional `brand` in the project settings holds colors (primary, secondary,
  accent, text, background), a body and a heading font family, and a logo image with its corner.
  The new `set_brand` operation and `set_brand_kit` MCP tool merge partial updates (`null` clears a
  field, `reset` starts over) and check that the logo is an image asset. Templates, `add_text` and
  `add_shape` use the brand colors and fonts whenever the caller does not pass explicit ones. The
  new `add_logo` operation and `logo` template (via `add_template`) place the logo in a corner with
  a margin, by default for the whole timeline. The editor has a Brand kit dialog in the top bar
  (color pickers, font selects, logo picker, "Add logo to video"), and the Add menu previews the
  brand colors. `get_project` summaries include the brand kit.

### Changed

- The MCP server now exposes 33 tools (was 27): `remove_filler_words`, `detect_beats`,
  `cut_to_beats`, `duck_music`, `normalize_loudness` and `set_brand_kit`.
- CI uses `actions/checkout` v7, `actions/setup-node` v7, `pnpm/action-setup` v6 and
  `actions/upload-artifact` v7.

## [0.2.0] - 2026-10-13

Motion graphics: shapes, text templates and animation presets, plus direct manipulation of
overlays in the preview. Agents get three new MCP tools; everything renders the same in the
browser and in the server renderer.

### Added

- **Shapes**: rectangles (optionally with rounded corners) and ellipses with fill and outline, as
  a new `shape` clip type. Agents use the new `add_shape` MCP tool (and `set_clip_property` for
  size, fill, stroke and corner radius); the editor has toolbar buttons and a Shape section in the
  properties panel. Shapes support transforms, keyframes, fades, transitions and effects like
  other visual clips and render in WebGL and with ffmpeg.
- **Templates and richer text**: `title`, `lower-third`, `banner` and `callout` templates built
  from shapes and text, inserted as one undo step via the new `add_template` MCP tool or the new
  "Add" menu in the editor; a text button and `T` shortcut; font family (sans/serif/mono), italic
  and outline controls for text, with matching fonts in the server renderer.
- **Animation presets**: entrance/exit animations (`fade`, `slide-left`, `slide-right`,
  `slide-up`, `slide-down`, `zoom`, `pop`) for video, image, text and shape clips, via the new
  `animate_clip` MCP tool, the `set_animation` operation, `set_clip_property` and an Animation
  section in the properties panel. They are evaluated at render time, so they stay attached to the
  clip edges through trims and splits, and the server renderer matches the browser preview.
- **Canvas editing**: click to select, drag to move and drag a corner to scale overlays directly in
  the preview, with Shift axis lock, snapping guides at the frame center and edges, Escape to
  cancel and arrow-key nudging (1 px, Shift: 10 px). Each drag commits a single `set_clip_props`
  operation (one undo step). Agent edits to other clips show up live during a drag, an agent edit
  to the dragged clip cancels it, and clips touched by an agent are outlined in the preview.
- **Engine**: the `Player` exposes the oriented bounds of the last rendered frame
  (`getLayerBounds()`, `getRenderedFrame()`, `canvasSize`) and an `onRender()` event.

### Changed

- New text and shape overlays always stack above whatever they overlap in time.
- The MCP server now exposes 27 tools (was 24): `add_shape`, `add_template` and `animate_clip`.
- Releases are cut by pushing a `vX.Y.Z` tag; the Release workflow creates the GitHub Release from
  the matching `CHANGELOG.md` section.

## [0.1.0] - 2026-10-13

First public release: a browser video editor that AI agents can drive over MCP while a human
watches and intervenes live.

### Added

- **Core (`@cutline/core`)**: Zod schema for projects (tracks, video/audio/image/text/caption clips,
  assets, transforms, keyframes, effects, transitions, caption styles); 18 pure, intent-based edit
  operations with actionable errors; RFC 6902 JSON Patch generation; patch-based undo/redo; schema
  migrations; the frame/audio resolver shared by all renderers; analysis helpers (loudness
  envelopes, silence detection, waveform summaries, transcript-to-timeline mapping, caption
  grouping). 100 % test coverage.
- **Engine (`@cutline/engine`)**: WebGL preview player (PixiJS) with WebCodecs decoding through
  Mediabunny, OPFS asset cache, Web Audio playback with gain envelopes, and an MP4/WebM exporter
  (H.264/AAC preferred) that runs in a Web Worker.
- **MCP server (`@cutline/mcp-server`)**: 24 tools (editing, perception, output) over Streamable HTTP
  and stdio (the stdio mode bridges to a running server); WebSocket sync that broadcasts JSON patches
  with their origin; REST API with range-capable media streaming and uploads; ffmpeg-based silence,
  scene and waveform analysis, timeline frame rendering and MP4 export; local Whisper
  transcription via transformers.js; local-disk storage adapters; Host/Origin checks and optional
  bearer token.
- **Editor (`apps/web`)**: projects page; multi-track timeline with drag, trim, split, ripple delete,
  zoom, snapping and keyboard shortcuts; live preview; asset bin with uploads (ffmpeg.wasm
  fallback for formats the browser cannot decode); properties and captions panels; activity feed,
  presence and pulsing highlights for agent changes; export dialog (browser or server).
- Docker image and `docker-compose.yml`, CI (lint, typecheck, tests, build, Docker, Playwright),
  Changesets release workflow, generated MCP tool reference, architecture/storage/licensing docs,
  synthetic CC0 test fixtures, scripted demo agent.

[Unreleased]: https://github.com/Aepzie/cutline/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Aepzie/cutline/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Aepzie/cutline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Aepzie/cutline/releases/tag/v0.1.0
