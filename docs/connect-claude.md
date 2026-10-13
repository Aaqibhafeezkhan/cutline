# How to connect Claude (and other MCP clients)

Cutline is an MCP server. Start it with `pnpm dev` (development), `pnpm start` (after
`pnpm build`) or `docker compose up`. The editor shows connection snippets under
**Connect agent** in the top bar.

| Setup                | Editor                | MCP endpoint              |
| -------------------- | --------------------- | ------------------------- |
| `pnpm dev`           | http://localhost:5173 | http://localhost:4100/mcp |
| `pnpm start`, Docker | http://localhost:4100 | http://localhost:4100/mcp |

## Claude Code

```bash
claude mcp add --transport http cutline http://localhost:4100/mcp
```

Check it with `claude mcp list`. In a session, ask for example:

> Create a Cutline project from ~/Videos/interview.mp4, cut out the pauses, add captions and a title
> "Interview with Ada" for the first 3 seconds, then export.

Claude will call `create_project` → `add_asset` → `add_clip` → `detect_silence` → `delete_range` →
`add_captions` → `add_text_overlay` → `export_video`. Open the `editorUrl` from the first result to
watch.

## Claude Desktop

Claude Desktop launches local MCP servers over stdio. Build once:

```bash
pnpm build
```

Then edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "cutline": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/cutline/packages/mcp-server/dist/cli.js",
        "--stdio",
        "--serve-web"
      ],
      "env": { "FFMPEG_PATH": "/usr/local/bin/ffmpeg" }
    }
  }
}
```

- If a Cutline server is already running (e.g. `pnpm dev` or Docker) on port 4100, the stdio
  process **bridges** to it, so the editor you have open shows the edits live.
- Otherwise it starts a server in-process, and `--serve-web` makes it serve the built editor at
  http://localhost:4100 so you can still watch.
- `env` is optional; use it when ffmpeg is not on the PATH Claude Desktop sees (common on macOS).

Restart Claude Desktop after editing the config. The tools appear under the 🔨 menu.

## Other MCP clients

Any client with **Streamable HTTP** support can connect to `http://localhost:4100/mcp`. For
stdio-only clients use the same command as for Claude Desktop.

## Remote / secured servers

When Cutline runs with `CUTLINE_TOKEN` (required before exposing it beyond localhost), clients
must send `Authorization: Bearer <token>`:

```bash
claude mcp add --transport http cutline https://cutline.example.com/mcp \
  --header "Authorization: Bearer $CUTLINE_TOKEN"
```

For the stdio bridge, set `CUTLINE_TOKEN` in the `env` block. Also add your hostname to
`CUTLINE_ALLOWED_HOSTS`, otherwise the server rejects the request's `Host` header (DNS-rebinding
protection).

## Media paths

`add_asset` with `path` reads files **on the machine running the server**, and only below
`CUTLINE_MEDIA_ROOTS` (default: your home directory and the data directory). In Docker, mount
media at `/media` and refer to `/media/file.mp4`. `add_asset` with `url` downloads public http(s)
URLs.

## Troubleshooting

| Symptom                                        | Fix                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `needs ffmpeg, which was not found`            | Install ffmpeg or set `FFMPEG_PATH`                                         |
| `Speech-to-text is not installed`              | `pnpm install` (the optional `@huggingface/transformers` failed to install) |
| First `get_transcript` is slow                 | The Whisper model downloads once (~80 MB); later calls use the cache        |
| Client times out on long exports               | Raise the client's tool timeout; Cutline sends progress notifications       |
| `Host "…" is not allowed`                      | Add the hostname to `CUTLINE_ALLOWED_HOSTS`                                 |
| Editor shows "Cannot reach the Cutline server" | Start the server (`pnpm dev`) and check port 4100 is free                   |
