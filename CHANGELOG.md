# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Shapes: rectangles (optionally rounded) and ellipses with fill and outline, via the new `add_shape` MCP tool, toolbar buttons and a properties section; rendered in the browser and by the server renderer.
- Entrance/exit animation presets for visual clips (`fade`, `slide-left`/`-right`/`-up`/`-down`, `zoom`, `pop`) via the new `animate_clip` MCP tool, the `set_animation` operation, `set_clip_property` and an Animation section in the properties panel. They are evaluated at render time, so they follow trims and splits, and the server renderer matches the browser preview.

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

[Unreleased]: https://github.com/Aepzie/cutline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Aepzie/cutline/releases/tag/v0.1.0
