# Reviewed subnet HTTP calls

`write_subnet_surface` and `call_subnet_surface` can execute source-reviewed HTTP operations even when
recurring health probes are disabled. Registry `http.operations` declares the
allowed method/path pairs, body media types and required bodies. This permission
does not enable a probe, establish provider availability or grant access to other
paths. Existing surfaces without this declaration keep their current behavior.

Use `how_do_i_call` to retrieve the exact admission and the provider's schema link.
Use `write_subnet_surface` for POST/PUT/PATCH/DELETE and `call_subnet_surface` for
GET/HEAD. Supply `path` and `method` explicitly, use `json_body` for JSON, and provide your
own credential when required. Request/response limits, credential isolation,
same-origin path restrictions, DNS checks, safe redirects and binary attachment
selection remain the same as other subnet HTTP calls. An admitted operation is
matched locally; it does not fetch or reinterpret a provider's schema on each
request. The provider remains responsible for its request field validation.

For a schema-declared binary write, pass `body_base64` containing canonical padded
base64 of the exact request bytes. The bytes are decoded once and forwarded as a
byte view. Use only one of `body_base64`, `json_body` or `body`. Empty byte bodies
are supported. Existing JSON values retain their normal JSON number normalization;
byte bodies preserve the caller's exact encoding, including raw JSON when needed.

For multipart, encode the complete multipart body yourself and pass its matching
boundary in `content_type`, for example `multipart/form-data; boundary=upload-1`.
The full Content-Type header and payload are forwarded unchanged. Declared MIME
ranges such as `image/*` require an explicit concrete `content_type`. Fixed
parameters in a declaration require an exact match. Local OpenAPI request-body
references are resolved within the captured document, including escaped JSON
pointer keys; cycles, missing targets, external references and chains beyond
32 reference hops are rejected without fetching another document.

Header, query and cookie credentials can accompany byte requests. JSON body
credentials require `json_body` or `body`, because merging credential fields would
alter the byte payload. The existing 64 KiB limit applies to the entire incoming
MCP request, including base64's overhead and the JSON-RPC envelope. This is not a
64 KiB file allowance or a bulk-upload facility; no request limit is increased.
These request representations follow the captured
[OpenAPI media-type and request-body contract](https://spec.openapis.org/oas/v3.1.0.html#request-body-object)
and the caller retains responsibility for the provider's field and file rules.

SN10 TaoFi admits the eight POST operations in its published
[OpenAPI document](https://taofi-doc.web.app/openapi.yaml): `getBuyQuote`,
`getBuyCall`, `getSellQuote`, `getSellCall`, `getRefundCall`, `getBalance`,
`getNativeTaoQuote` and `getNativeTaoCall`. Each requires an `application/json`
body. Quote and call-data retrieval do not sign or submit the returned transaction.

SN42 Gopher uses caller-provided bearer credentials. Its
[pinned client implementation](https://github.com/gopher-lab/gopher-mcp-server/blob/f75705d9b1a121a4b1936ad967a30611736e5b70/data/internal/client/client.go)
submits JSON with `POST /api/v1/search/live`, then retrieves the returned job ID
with `GET /api/v1/search/live/result/{uuid}`. Both operations are admitted. The
initial result is returned immediately, without automatic polling. Request the
result explicitly when needed; provider statuses and response bodies remain
visible to the caller.

These declarations and tests establish source-based integration support. Tests
use mocked providers; they do not establish deployed service health, available
account scopes, quotas or retained data. Recurring probes for these services stay
disabled, and recorded health remains independent of explicit call permission.
