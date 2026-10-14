# @cutline/core

## 0.4.0

### Minor Changes

- Clip speed (0.1–16×), reverse playback and freeze frames: the `set_speed` and `freeze_frame`
  operations, speed-aware resolver output for both renderers, the `set_clip_speed` and
  `freeze_frame` MCP tools, and a Speed section, Freeze frame button (F) and speed badges in the
  editor.

- [#30](https://github.com/Aepzie/cutline/pull/30) [`ae2820d`](https://github.com/Aepzie/cutline/commit/ae2820db053aec8cce4a94390f0203beae80c96c) Thanks [@Aepzie](https://github.com/Aepzie)! - Chapters, markers and highlight reels: project markers (chapter, note, highlight) that follow
  ripple edits, the operations `add_markers`, `update_marker`, `remove_markers`, `set_chapters` and
  `assemble_ranges`, five MCP tools (`get_chapters_input`, `set_chapters`, `export_chapters`,
  `mark_highlights`, `create_highlight_reel`), MP4 chapters in server exports, and markers on the
  editor ruler with a Chapters panel ("Copy for YouTube").

- [#29](https://github.com/Aepzie/cutline/pull/29) [`b1d925e`](https://github.com/Aepzie/cutline/commit/b1d925ebe8bb6ad5f2b2dd0cd79260f3b27ab9ed) Thanks [@Aepzie](https://github.com/Aepzie)! - Suggestion mode for agent edits: a per-project Direct / Suggest switch (`set_agent_mode`
  operation). In suggest mode agent edits become proposals that the editor previews, accepts (one
  undo step) or rejects. New `list_proposals` MCP tool, `diffProjects` / `describeChanges` helpers in
  core, and a Suggestions panel in the editor.

- [#27](https://github.com/Aepzie/cutline/pull/27) [`afde8b3`](https://github.com/Aepzie/cutline/commit/afde8b31ce9aa0cdf960ceaeda8832926697c41f) Thanks [@Aepzie](https://github.com/Aepzie)! - Transcript editing: a Transcript panel in the editor (click a word to seek, select words and press
  Delete to cut them in one undo step), the `delete_words` MCP tool (remove a spoken phrase or a word
  index range) and the pure core helpers `wordRangesToCuts`, `findPhraseInWords` and
  `groupParagraphs`.

## 0.3.0

### Minor Changes

- [#21](https://github.com/Aepzie/cutline/pull/21) [`5c1f710`](https://github.com/Aepzie/cutline/commit/5c1f7105c07d2d1c87a49e7b65686d924a2cd47b) Thanks [@Aepzie](https://github.com/Aepzie)! - Auto-duck music under speech (`duck_audio` operation, `duck_music` MCP tool) and normalize clip loudness to a LUFS target (`normalize_loudness` MCP tool), with matching buttons in the editor's audio properties.

- [#22](https://github.com/Aepzie/cutline/pull/22) [`6099b04`](https://github.com/Aepzie/cutline/commit/6099b048fd7a724984c2938b2291d053ec41b4a9) Thanks [@Aepzie](https://github.com/Aepzie)! - Brand kit: define colors, body/heading fonts and a logo once per project. New `set_brand` and
  `add_logo` operations, a `logo` template, the `set_brand_kit` MCP tool, and a Brand kit dialog in
  the editor. Templates and new text and shapes use the brand values unless explicit ones are given.

- [#19](https://github.com/Aepzie/cutline/pull/19) [`b200a77`](https://github.com/Aepzie/cutline/commit/b200a7773f89ef01f6045d9048fd3b2900ca7ebc) Thanks [@Aepzie](https://github.com/Aepzie)! - Remove filler words ("um", "uh", "äh", "ähm", …) from talking-head footage in one step: new
  `findFillerRanges` helper in core, the `remove_filler_words` MCP tool (with `dryRun` and optional
  stutter removal) and a "Remove fillers" button in the editor's captions panel.

## 0.2.0

### Minor Changes

- [#16](https://github.com/Aepzie/cutline/pull/16) [`58fb94f`](https://github.com/Aepzie/cutline/commit/58fb94f629d4ff7b1bb51f4f02dc66de22cbb419) Thanks [@Aepzie](https://github.com/Aepzie)! - Add entrance/exit animation presets: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom` and `pop`, stored as `animationIn` / `animationOut` on video, image, text and shape clips. The resolver evaluates them at render time (offsets add, scale and opacity multiply with the transform and keyframes), so they stay attached to the clip edges through trims and splits. Agents use the new `animate_clip` MCP tool (or the `set_animation` operation and `set_clip_property`); the editor has an Animation section in the properties panel; the server renderer produces the same motion with ffmpeg expressions.

- [#13](https://github.com/Aepzie/cutline/pull/13) [`0220cfd`](https://github.com/Aepzie/cutline/commit/0220cfd21aa10ad1b52b39a372bca0e119ef9fa1) Thanks [@Aepzie](https://github.com/Aepzie)! - Add shapes: rectangles (with rounded corners) and ellipses with fill and outline, as a new `shape` clip type. Agents use the new `add_shape` MCP tool (and `set_clip_property` for width, height, fill, stroke and corner radius); the editor has toolbar buttons and a Shape section in the properties panel. Shapes render in the browser (WebGL) and in the server renderer (ffmpeg), and support transforms, keyframes, fades, transitions and effects like other visual clips.

- [#14](https://github.com/Aepzie/cutline/pull/14) [`82c3151`](https://github.com/Aepzie/cutline/commit/82c315194f7a8c3ece6ff6a9ce6ef89ba4b4db23) Thanks [@Aepzie](https://github.com/Aepzie)! - Add graphics templates and richer text: `title`, `lower-third`, `banner` and `callout` templates built from shapes and text (one undo step) via the new `add_template` MCP tool and an "Add" menu in the editor; a text button and `T` shortcut; font family (sans/serif/mono), italic and outline controls for text, with matching fonts in the server renderer. New overlays now always stack above whatever they overlap in time.
