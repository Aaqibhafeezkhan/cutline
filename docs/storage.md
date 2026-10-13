# Storage

The server stores two kinds of data, behind two small interfaces in
[`packages/mcp-server/src/storage/types.ts`](../packages/mcp-server/src/storage/types.ts):

| Interface      | Holds                                                      | Default (`LocalProjectStore` / `LocalBlobStore`) |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `ProjectStore` | Project documents (JSON, migrated on load)                 | `<data>/projects/<id>.json`, atomic writes       |
| `BlobStore`    | Asset files, exports and analysis caches, addressed by key | `<data>/<key>`                                   |

`<data>` is `CUTLINE_DATA_DIR` (default `.cutline-data` in the repository root, `/data` in
Docker). Keys look like:

```text
assets/<assetId>/<file>            uploaded / imported media (Asset.src)
exports/<projectId>/<file>.mp4     server renders
cache/<assetId>/envelope.json      loudness envelope (silence, waveform)
cache/<assetId>/transcript-*.json  Whisper transcripts
cache/<assetId>/scenes-*.json      scene cuts
```

## Adding S3 / Cloudflare R2

An object-storage adapter implements `BlobStore` (and optionally `ProjectStore`). Then pass it to
`createServices(config, { blobStore, projectStore })` or `startServer(config, { blobStore })`.
Mapping guidance:

| Method               | S3/R2 implementation                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `put(key, stream)`   | `Upload` from `@aws-sdk/lib-storage` (multipart, streams)                                   |
| `putFile(key, path)` | same, from `createReadStream(path)`                                                         |
| `stat(key)`          | `HeadObject` → `ContentLength`, `LastModified`; `null` on 404                               |
| `read(key, range)`   | `GetObject` with `Range: bytes=start-end` → `Body` as a Node stream                         |
| `localPath(key)`     | **ffmpeg needs files**: download to a local cache directory (keyed by ETag) and return path |
| `delete(key)`        | `DeleteObjects` for all keys with the prefix                                                |
| `list(prefix)`       | `ListObjectsV2` with pagination                                                             |

Notes:

- The HTTP route that serves media (`GET /api/projects/:id/assets/:assetId/file`) uses
  `localPath` + `sendFile` today. With object storage, prefer redirecting the browser to a
  short-lived pre-signed URL (the engine only needs HTTP range requests and CORS).
- Keep the local cache for `localPath` on fast disk and bounded in size (LRU by last access).
- `ProjectStore` documents are small; DynamoDB, Postgres (`jsonb`) or an object per project all
  work. Writes are already serialized per project by `DocumentService`.
- Undo history is in memory per server process. Persisting it, or running several server replicas,
  needs a shared log (a natural next step together with object storage).
