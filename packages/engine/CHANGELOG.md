# @cutline/engine

## 0.2.0

### Minor Changes

- [#15](https://github.com/Aepzie/cutline/pull/15) [`e997575`](https://github.com/Aepzie/cutline/commit/e9975751394198c5d7f277d5d4b45cefd1e0df75) Thanks [@Aepzie](https://github.com/Aepzie)! - Add direct manipulation in the preview. Click a layer to select it (top-most first, captions and locked tracks are skipped), drag it to move, drag a corner to scale uniformly, hold Shift to lock one axis, and get snapping with guide lines at the frame center and edges. While dragging the preview renders a local draft; releasing commits one `set_clip_props` operation, so a drag is a single undo step, and Escape cancels. With the preview focused, arrow keys nudge the selected overlay by 1 px (Shift: 10 px). If an agent changes the dragged clip mid-drag, the drag is cancelled; changes to other clips are picked up live, and clips touched by an agent are outlined in the preview. The engine's `Player` exposes the oriented bounds of the last rendered frame (`getLayerBounds()`, `getRenderedFrame()`, `canvasSize`) and an `onRender()` event.

- [#13](https://github.com/Aepzie/cutline/pull/13) [`0220cfd`](https://github.com/Aepzie/cutline/commit/0220cfd21aa10ad1b52b39a372bca0e119ef9fa1) Thanks [@Aepzie](https://github.com/Aepzie)! - Add shapes: rectangles (with rounded corners) and ellipses with fill and outline, as a new `shape` clip type. Agents use the new `add_shape` MCP tool (and `set_clip_property` for width, height, fill, stroke and corner radius); the editor has toolbar buttons and a Shape section in the properties panel. Shapes render in the browser (WebGL) and in the server renderer (ffmpeg), and support transforms, keyframes, fades, transitions and effects like other visual clips.

### Patch Changes

- Updated dependencies [[`58fb94f`](https://github.com/Aepzie/cutline/commit/58fb94f629d4ff7b1bb51f4f02dc66de22cbb419), [`0220cfd`](https://github.com/Aepzie/cutline/commit/0220cfd21aa10ad1b52b39a372bca0e119ef9fa1), [`82c3151`](https://github.com/Aepzie/cutline/commit/82c315194f7a8c3ece6ff6a9ce6ef89ba4b4db23)]:
  - @cutline/core@0.2.0
