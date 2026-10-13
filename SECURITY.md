# Security Policy

## Supported versions

Cutline is pre-1.0. Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately via
[GitHub Security Advisories](https://github.com/Aepzie/cutline/security/advisories/new).
You should get a response within 7 days. Please include reproduction steps
and the impact you see.

## Threat model and safe defaults

The Cutline server can read media files and run ffmpeg on them. It is designed
to run **on your own machine**:

- It binds to `127.0.0.1` by default (`CUTLINE_HOST`).
- `Host`/`Origin` headers are validated to block DNS-rebinding attacks from
  websites you visit.
- MCP `add_asset` with a local `path` only reads files under
  `CUTLINE_MEDIA_ROOTS` (defaults to your home directory and the data dir).
- `add_asset` with a `url` only fetches `http(s)` URLs, enforces a size limit,
  and refuses private network ranges unless `CUTLINE_ALLOW_PRIVATE_URLS=1`.
- Setting `CUTLINE_TOKEN` requires `Authorization: Bearer <token>` on all
  HTTP, MCP and WebSocket requests. **Always set it before exposing the server
  beyond localhost** (e.g. via Docker on a public host).
- No secrets are stored in the repository; configuration comes from the
  environment (see `.env.example`).
