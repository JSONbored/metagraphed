# Subnet response content

`call_subnet_surface` and `write_subnet_surface` support the same explicit
`response_mode: "attachment"` option. Use it when a catalogued API returns an
image, audio, video, archive or other binary result:

```json
{
  "surface_id": "<catalogued surface id>",
  "response_mode": "attachment"
}
```

PNG, JPEG, WebP and GIF responses become MCP image content. Audio becomes MCP
audio content; clients older than protocol 2025-03-26 receive the exact audio
bytes as an embedded binary resource. Other binary formats use an embedded
resource with a checksum URI. The [MCP tool-result contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-result)
defines these native content blocks. No external file is published or stored.

The structured `body` contains only `encoding: "mcp_content"`, `mime_type`,
`bytes` and `sha256`. Complete original bytes appear once in native content,
without a second base64 copy in structured JSON or compatibility text. An empty
binary body has a zero-byte receipt and no attachment. JSON and text responses
retain their ordinary behavior, including existing capped text/SSE reads.
Omitting the option retains the existing binary-content rejection.

The existing 256 KiB response limit and surface deadline still apply. Binary
responses must finish within both bounds; a partial image, audio or archive is
rejected rather than returned as a corrupt attachment. Failed reads do not
replay an operation, and upstream errors cannot echo caller credentials. Stream
cancellation starts on completion or failure without making a stalled upstream
cancellation extend the response deadline. A single bounded destination avoids
retaining fragmented chunks or concatenating another full response buffer.

Surface resolution, exact declared path/method checks, read/write permissions,
caller credentials, request-body validation and redirect/DNS safety apply to
attachment calls. This mode does not invent an endpoint or grant provider
access. Availability still depends on the actual subnet service. Images and
audio are relayed exactly; fixture tests do not establish a provider's live
availability or measure production latency.

JSON body credentials, including flat signatures and nested signature envelopes,
remain scoped to the catalogued origin. Same-origin redirects preserve the exact
signed payload; a cross-origin redirect stops before a second request can send
that credential elsewhere. Existing header credential stripping and ordinary
body forwarding retain their behavior.

Text/SSE, rejected binary and redirect cleanup request stream cancellation
without waiting for an upstream cleanup promise. The text reader also checks the
clock between chunks, so continuously ready empty chunks cannot starve its
deadline timer. Existing capped text bytes, truncation receipts and redirect
revalidation remain in place.
