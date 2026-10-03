# Reviewed subnet HTTP calls

`write_subnet_surface` and `call_subnet_surface` can execute source-reviewed HTTP operations even when
recurring health probes are disabled. Registry `http.operations` declares the
allowed method/path pairs, body media types and required bodies. This permission
does not enable a probe, establish provider availability or grant access to other
paths. Existing surfaces without this declaration keep their current behavior.

Use `how_do_i_call` to retrieve the exact admission and the provider's schema link.

For a valid reviewed service, `auth.detail` reuses the public catalog descriptor:
the credential scheme, header/query/cookie/body placement, name or signature
header set, value placeholder, optional body envelope and OAuth token URL. These
are provider instructions, not stored credentials. The guide reads no private
credential store and needs no additional surface/schema/provider request. Missing
or malformed descriptors are omitted; existing `auth.required` and `auth.schemes`
remain. Legacy services without a valid reviewed operation retain their original
guide shape.

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

For a larger prepared file request, use `body_artifact` with `url`, `sha256` and
`bytes`. The public `raw.githubusercontent.com` URL must use a full 40-character
commit and contain no credentials, query or fragment. Supply the lowercase
SHA-256 and exact uncompressed byte count of the complete request payload,
including multipart framing. The bound is 10,000,000 bytes; the same media and
boundary rules apply. Use only one of `body_artifact`, `body_base64`, `json_body`
or `body`. Empty payloads retain their Content-Type.

The target operation, caller permission, credentials and URL are checked before
the source is fetched. One credential-free GET resolves the artifact under the
target fetch deadline. Source redirects are refused. Length, stream and checksum
checks complete before a provider write; a mismatch or source failure sends no
provider request. The verified byte view is forwarded once and reused on provider
redirects, with existing credential stripping. Source transport error details and
artifact telemetry fields are redacted. There is no persistent artifact storage.
The inline 64 KiB MCP request limit and all response limits remain unchanged.

The website offers an artifact call template beside required binary/multipart
templates. Replace the URL, checksum and byte-count placeholders with your prepared
public request artifact. This avoids file base64 in the conversation and adds one
source GET per invocation. It does not establish provider availability, automate
local file access or admit a provider's returned presigned upload URL; those flows
require their own reviewed destination and file contract. Existing JSON fields
that accept media URLs can also use that provider-native representation, as in
[BitMind's published detection inputs](https://docs.bitmind.ai/api-reference/api/v1-detect.md).

Captured Swagger 2 operations use the same `json_body`, `body` and `body_base64`
fields. Their path-level `body`/`formData` parameters and local parameter references
are inherited; operation parameters override by name/location. The body parameter
name does not wrap the payload. Operation `consumes` overrides the root list, and
an empty list clears it. Without a media restriction, JSON/text bodies default to
JSON or can supply a concrete `content_type`; byte bodies must choose a concrete
type. Form parameters admit URL-encoded/multipart media. Forward an already
encoded form string or exact multipart bytes, retaining empty/repeated fields,
file bytes and boundary headers. Multiple media choices require `content_type`.
Mixed body/form declarations, unresolved parameters and malformed media metadata
are refused before provider traffic. JSON body credentials cannot reshape a
non-JSON form/text payload. Existing body omission and OpenAPI 3 behavior are
preserved; the provider retains field/file validation. These declarations follow
the [Swagger 2 body/form and consumes contract](https://spec.openapis.org/oas/v2.0.html#parameter-object).

The website's reviewed-operation view supplies fill-in templates for required
JSON, text, byte and multipart bodies. A JSON template retains the declared
media type when it is a JSON suffix or has parameters. Replace angle-bracket
values before calling; byte placeholders are not valid base64 payloads.
Multipart templates require the complete encoded body and a matching boundary.
Templates do not infer field values, attach credentials, upload files or execute
provider requests. Choose a declared format before copying a template. Optional
bodies remain omitted by default, with their declared formats available as explicit
choices. JSON, text and multipart alternatives share the same operation row;
public artifact alternatives use their own compact row.

## BitMind detection

SN34's reviewed HTTP declarations support the four currently documented standard
operations and two enterprise operations. Each uses POST, requires the caller's
Bearer credential and keeps recurring health probes disabled. Use the registered
surface's exact operation with `write_subnet_surface`; `how_do_i_call` and the
website's integration details expose its media contract.

| Surface                          | Path            | Declared request formats    |
| -------------------------------- | --------------- | --------------------------- |
| `sn-34-bitmind-detect-v1`        | `/v1/detect`    | JSON, plain text, multipart |
| `sn-34-bitmind-detect-image`     | `/detect-image` | JSON, multipart             |
| `sn-34-bitmind-detect-video`     | `/detect-video` | JSON, multipart             |
| `sn-34-bitmind-detect-text`      | `/detect-text`  | JSON                        |
| `sn-34-bitmind-enterprise-image` | `/image`        | JSON, multipart             |
| `sn-34-bitmind-enterprise-video` | `/video`        | JSON, multipart             |

The standard operations use `https://api.bitmind.ai`; enterprise operations use
`https://enterprise.bitmind.ai`. Store credentials separately for each surface,
or supply an explicit credential. The provider requires an enterprise key and
account-enabled video access for enterprise calls; a stored standard key is not
implicitly forwarded to an enterprise surface. See
[BitMind authentication](https://docs.bitmind.ai/api-reference/authentication).

For [unified detection](https://docs.bitmind.ai/api-reference/api/v1-detect), JSON
can carry a media URL/data URI or text; plain text and an encoded multipart `file`
are also documented. Optional routing, debug, source context and video trimming
fields are forwarded as supplied. The response envelope is preserved. Image and
video operations use their documented `image`/`video` fields, including multipart
files, debug and video trim settings. For
[text detection](https://docs.bitmind.ai/api-reference/api/detect-text), supply
the documented text passage and optional context; provider verdicts are retained.
The provider remains responsible for field validation, supported media, minimum
text length, quotas and account access. Provider errors are returned with their
status and body; no automatic replay is added.

Prepared multipart bytes can use inline base64 or the public artifact option,
under the unchanged request/response limits. The artifact bound applies to the
complete encoded request, including framing. It does not increase the provider's
[documented direct-video limit](https://docs.bitmind.ai/api-reference/api/detect-video).
Public artifact sources are public; provider zero-retention claims for
[enterprise image](https://docs.bitmind.ai/api-reference/enterprise-api/enterprise-image)
and [video](https://docs.bitmind.ai/api-reference/enterprise-api/enterprise-video)
do not establish retention for the caller's chosen source or the whole interaction.

Source-reviewed request contracts and mocked forwarding fixtures do not establish
live provider availability, detector accuracy or acceptance of a real file. Older
document/liveness/preprocess/presigned-upload registrations have no newly granted
permission; their current contracts and presigned destination flow still require
qualification. No provider probes or production requests are used by these fixtures.

For declared query parameters, use `query_values` with their JSON values rather
than escaping them into the path. Supply `path` and `method`; serialization uses
the captured operation and its path-level declarations. Operation declarations
override path declarations by query name. Local path-item and parameter references,
including canonical array indices in JSON pointers, resolve within that document.
Reviewed HTTP admission still independently restricts the allowed operation.
An empty `query_values` object does not load another schema for reviewed calls.

OpenAPI `form` supports repeated arrays and exploded objects, or comma joins with
`explode:false`. `spaceDelimited` and `pipeDelimited` use their declared joins;
`deepObject` uses bracketed scalar properties. Swagger 2 supports `csv`, `ssv`,
`tsv`, `pipes` and `multi`. Query `content` with JSON media accepts every JSON root
and serializes once, including nested filters. Other query content requires the
caller's pre-serialized string. Style nulls and empty collections are omitted;
JSON content retains null. Provider field validation remains with the provider.

The original flat `query` field retains its existing encoding for pre-serialized
fields. Do not overlap its keys with `query_values` or emitted object properties.
Query credentials override all emitted pairs and retain existing redaction.
Reserved expansion preserves permitted query characters and pre-encoded triples;
query/fragment/form delimiters remain escaped. Nested style values and ambiguous
space/pipe/tab items or bracketed deep-object keys require the provider's documented
pre-escaping or declared JSON content. No undocumented nested-query convention is
invented. These rules follow the
[OpenAPI parameter serialization and encoding guidance](https://spec.openapis.org/oas/v3.2.0.html#parameter-object)
and [Swagger 2 collection formats](https://spec.openapis.org/oas/v2.0.html#parameter-object).

Use `header_values` and `cookie_values` for captured custom parameters on that
same operation. Path declarations and bounded local references apply; operation
declarations override them. Header names compare without case, and header
`simple` style leaves escaping to the provider's convention. Arrays use the
declared join; objects honor `explode`. Swagger headers also support
`csv`, `ssv`, `tsv` and `pipes`. Declared JSON header content accepts all JSON roots
and uses JSON Unicode escapes when needed to retain the value in HTTP field bytes.

Cookies use the declared `form` or OpenAPI 3.2 `cookie` style. Form style encodes
values and retains its specified `&` joins for exploded collections; cookie
style preserves already escaped values and joins pairs with `; `. Content-based
cookies take the caller's already serialized string, since provider quoting and
escaping conventions vary. No semicolon or line-break injection is allowed.
Pre-escape delimiters in raw collections according to the provider's convention;
do not supply nested style values. Provider field validation remains unchanged.

Authentication uses `credential` or the existing session store. Header credentials
override matching names regardless of case; cookie credentials override emitted
cookie names. Host, framing, authentication and other transport-controlled headers
use the dedicated request fields, rather than `header_values`. Unknown parameters
and malformed values fail before provider traffic. Parameter values are scrubbed
from fetch errors and stripped alongside credentials on cross-origin redirects.
Empty parameter objects retain the existing request and do not require another
captured-schema read for reviewed operations. These conventions follow the
[OpenAPI parameter serialization contract](https://spec.openapis.org/oas/v3.2.0.html#parameter-object).

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
