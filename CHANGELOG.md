# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Aepzie/cutline/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Aepzie/cutline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Aepzie/cutline/releases/tag/v0.1.0
