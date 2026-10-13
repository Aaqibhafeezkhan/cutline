# @cutline/mcp-server

## 0.3.0

### Minor Changes

- [#21](https://github.com/Aepzie/cutline/pull/21) [`5c1f710`](https://github.com/Aepzie/cutline/commit/5c1f7105c07d2d1c87a49e7b65686d924a2cd47b) Thanks [@Aepzie](https://github.com/Aepzie)! - Auto-duck music under speech (`duck_audio` operation, `duck_music` MCP tool) and normalize clip loudness to a LUFS target (`normalize_loudness` MCP tool), with matching buttons in the editor's audio properties.

- [#20](https://github.com/Aepzie/cutline/pull/20) [`7450d60`](https://github.com/Aepzie/cutline/commit/7450d6038d1a72e41b105f314a0cd299d174aa4e) Thanks [@Aepzie](https://github.com/Aepzie)! - Detect beats and cut on the beat: new `detect_beats` and `cut_to_beats` MCP tools backed by a
  pure-TypeScript beat tracker, beat markers and beat snapping on the timeline, and a "Detect beats"
  button in the clip properties.

- [#22](https://github.com/Aepzie/cutline/pull/22) [`6099b04`](https://github.com/Aepzie/cutline/commit/6099b048fd7a724984c2938b2291d053ec41b4a9) Thanks [@Aepzie](https://github.com/Aepzie)! - Brand kit: define colors, body/heading fonts and a logo once per project. New `set_brand` and
  `add_logo` operations, a `logo` template, the `set_brand_kit` MCP tool, and a Brand kit dialog in
  the editor. Templates and new text and shapes use the brand values unless explicit ones are given.

- [#19](https://github.com/Aepzie/cutline/pull/19) [`b200a77`](https://github.com/Aepzie/cutline/commit/b200a7773f89ef01f6045d9048fd3b2900ca7ebc) Thanks [@Aepzie](https://github.com/Aepzie)! - Remove filler words ("um", "uh", "äh", "ähm", …) from talking-head footage in one step: new
  `findFillerRanges` helper in core, the `remove_filler_words` MCP tool (with `dryRun` and optional
  stutter removal) and a "Remove fillers" button in the editor's captions panel.

### Patch Changes

- Updated dependencies [[`5c1f710`](https://github.com/Aepzie/cutline/commit/5c1f7105c07d2d1c87a49e7b65686d924a2cd47b), [`6099b04`](https://github.com/Aepzie/cutline/commit/6099b048fd7a724984c2938b2291d053ec41b4a9), [`b200a77`](https://github.com/Aepzie/cutline/commit/b200a7773f89ef01f6045d9048fd3b2900ca7ebc)]:
  - @cutline/core@0.3.0

## 0.2.0

### Minor Changes

- [#16](https://github.com/Aepzie/cutline/pull/16) [`58fb94f`](https://github.com/Aepzie/cutline/commit/58fb94f629d4ff7b1bb51f4f02dc66de22cbb419) Thanks [@Aepzie](https://github.com/Aepzie)! - Add entrance/exit animation presets: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom` and `pop`, stored as `animationIn` / `animationOut` on video, image, text and shape clips. The resolver evaluates them at render time (offsets add, scale and opacity multiply with the transform and keyframes), so they stay attached to the clip edges through trims and splits. Agents use the new `animate_clip` MCP tool (or the `set_animation` operation and `set_clip_property`); the editor has an Animation section in the properties panel; the server renderer produces the same motion with ffmpeg expressions.

- [#13](https://github.com/Aepzie/cutline/pull/13) [`0220cfd`](https://github.com/Aepzie/cutline/commit/0220cfd21aa10ad1b52b39a372bca0e119ef9fa1) Thanks [@Aepzie](https://github.com/Aepzie)! - Add shapes: rectangles (with rounded corners) and ellipses with fill and outline, as a new `shape` clip type. Agents use the new `add_shape` MCP tool (and `set_clip_property` for width, height, fill, stroke and corner radius); the editor has toolbar buttons and a Shape section in the properties panel. Shapes render in the browser (WebGL) and in the server renderer (ffmpeg), and support transforms, keyframes, fades, transitions and effects like other visual clips.

- [#14](https://github.com/Aepzie/cutline/pull/14) [`82c3151`](https://github.com/Aepzie/cutline/commit/82c315194f7a8c3ece6ff6a9ce6ef89ba4b4db23) Thanks [@Aepzie](https://github.com/Aepzie)! - Add graphics templates and richer text: `title`, `lower-third`, `banner` and `callout` templates built from shapes and text (one undo step) via the new `add_template` MCP tool and an "Add" menu in the editor; a text button and `T` shortcut; font family (sans/serif/mono), italic and outline controls for text, with matching fonts in the server renderer. New overlays now always stack above whatever they overlap in time.

### Patch Changes

- Updated dependencies [[`58fb94f`](https://github.com/Aepzie/cutline/commit/58fb94f629d4ff7b1bb51f4f02dc66de22cbb419), [`0220cfd`](https://github.com/Aepzie/cutline/commit/0220cfd21aa10ad1b52b39a372bca0e119ef9fa1), [`82c3151`](https://github.com/Aepzie/cutline/commit/82c315194f7a8c3ece6ff6a9ce6ef89ba4b4db23)]:
  - @cutline/core@0.2.0
