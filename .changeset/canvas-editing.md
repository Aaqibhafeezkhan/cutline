---
'@cutline/engine': minor
'@cutline/web': minor
---

Add direct manipulation in the preview. Click a layer to select it (top-most first, captions and locked tracks are skipped), drag it to move, drag a corner to scale uniformly, hold Shift to lock one axis, and get snapping with guide lines at the frame center and edges. While dragging the preview renders a local draft; releasing commits one `set_clip_props` operation, so a drag is a single undo step, and Escape cancels. With the preview focused, arrow keys nudge the selected overlay by 1 px (Shift: 10 px). If an agent changes the dragged clip mid-drag, the drag is cancelled; changes to other clips are picked up live, and clips touched by an agent are outlined in the preview. The engine's `Player` exposes the oriented bounds of the last rendered frame (`getLayerBounds()`, `getRenderedFrame()`, `canvasSize`) and an `onRender()` event.
