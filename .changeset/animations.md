---
'@cutline/core': minor
'@cutline/mcp-server': minor
'@cutline/web': minor
---

Add entrance/exit animation presets: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom` and `pop`, stored as `animationIn` / `animationOut` on video, image, text and shape clips. The resolver evaluates them at render time (offsets add, scale and opacity multiply with the transform and keyframes), so they stay attached to the clip edges through trims and splits. Agents use the new `animate_clip` MCP tool (or the `set_animation` operation and `set_clip_property`); the editor has an Animation section in the properties panel; the server renderer produces the same motion with ffmpeg expressions.
