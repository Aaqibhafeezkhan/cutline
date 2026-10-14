---
'@cutline/core': minor
'@cutline/mcp-server': minor
'@cutline/web': minor
---

Suggestion mode for agent edits: a per-project Direct / Suggest switch (`set_agent_mode`
operation). In suggest mode agent edits become proposals that the editor previews, accepts (one
undo step) or rejects. New `list_proposals` MCP tool, `diffProjects` / `describeChanges` helpers in
core, and a Suggestions panel in the editor.
