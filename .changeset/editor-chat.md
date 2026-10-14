---
'@cutline/mcp-server': minor
'@cutline/web': minor
---

Chat with Claude inside the editor: a collapsible Chat panel (Ctrl+K) streams Claude's replies and tool calls from the new `POST /api/projects/:id/chat` endpoint, which runs an agent loop over the existing MCP tools in-process (official Anthropic TypeScript SDK). Enabled by setting `ANTHROPIC_API_KEY` on the server; `CUTLINE_CHAT_MODEL` picks the model (default `claude-opus-5-5`).
