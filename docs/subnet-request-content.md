# Subnet request content

`write_subnet_surface` accepts `json_body` for a direct JSON value. Objects,
arrays, strings, numbers, booleans and `null` are serialized once when sending
the HTTP request. JSON supports each of these root types under
[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html#section-2).

Fetch the surface's captured schema with `get_api_schema`, then use its exact
declared path, method and request media type. For a declared JSON Patch
operation, the direct argument has the array form defined by
[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902.html#section-3):

```json
{
  "surface_id": "<catalogued surface id>",
  "path": "<declared path>",
  "method": "PATCH",
  "content_type": "application/json-patch+json",
  "json_body": [{ "op": "replace", "path": "/name", "value": "ada" }]
}
```

Use either `json_body` or `body`. The existing `body` option still sends an
object as JSON or a pre-serialized string exactly as supplied, including
whitespace. An omitted body and legacy `body: null` still send no body.
`json_body: null` sends the four bytes `null`; `json_body: ""` sends a JSON
empty string. Direct values avoid embedding escaped serialized JSON in an
MCP string argument. Numeric precision and normalization follow the existing
MCP JSON transport; use strings when the provider's schema represents exact
wide integers as strings.

`json_body` requires a declared `application/json` or `+json` request media
type. It follows the same POST/PUT/PATCH, operation admission, caller credential,
network safety and request limits as other writes. Read tools accept no body.

For flat body credentials, supply an object so the credential fields can merge
without reshaping the payload. A surface's declared nested credential envelope
preserves every JSON root, with the payload and signature under separate keys.
Same-origin redirects preserve the signed bytes; cross-origin redirects stop
before sending body credentials elsewhere.
