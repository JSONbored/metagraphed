# Chain-detail streaming admission

The existing 16,000,000-byte admission rule measures
`utf8Bytes(await request.text()).length`, not raw HTTP wire bytes. The focused
reader preserves this rule while refusing oversized prefixes before retaining
their decoded text or draining the remaining request. Authentication still runs
first; JSON parsing, family validation, store selection and writes are unchanged.

`TextDecoder` runs in streaming mode and flushes at EOF. Its output is encoded
and counted before appending, so split code points, malformed UTF-8 replacement
characters and the leading BOM use the same normalized text metric. Output is
monotone: once the normalized prefix exceeds the limit, no suffix can make the
completed text small enough. A leading UTF-8 BOM consumes three wire bytes but
does not appear in `Request.text()`; accepting an exactly sized body with that
BOM therefore requires accepting 16,000,003 wire bytes. Malformed input can have
the opposite effect: a single invalid byte becomes a three-byte replacement
character. A raw-wire cap or a new Content-Length rule would change admission.

The reader does not add header rejection or trust Content-Length as proof of
actual size. It also preserves empty, already-used, locked and failed-body
behavior. Errors from reading still propagate. Oversized bodies retain the same
413 response and no family write. Refusal requests cancellation without awaiting
its acknowledgment, so a rejecting or non-settling cancellation cannot hold it
open. Under-limit stalled bodies retain their existing lifetime policy; no new
timeout is introduced. Early refusal can precede an error in an unread oversized
tail, which is the intended difference from draining that tail first.

Each upstream chunk is decoded in slices of at most 64 KiB, bounding our temporary
decoding/re-encoding work. This cannot prevent the upstream allocation of a large
chunk. Accepted text and subsequent JSON objects still occupy memory; the byte
limit is not a production isolate-memory guarantee.

The closest source analogues are `workers/http.ts:readBoundedRequestText` and
`src/mcp-server.ts:readLimitedMcpBody`. Both count raw bytes and apply additional
header rules; reusing them unchanged would alter this route's acceptance. Their
stream-reader structure is retained without introducing a generic wrapper or
changing unrelated endpoints.

Native fixtures compare the result with `Request.text()` at every split for BOM,
malformed/incomplete UTF-8, Unicode, escaped surrogates and empty input. They cover
exact normalized-size acceptance, Content-Length non-authority, EOF replacement,
interruption and refusing/cancelling before a tail is read. The existing raw
Wrangler deployment-bundle harness checks actual workerd HTTP admission with no
production store or outbound access. A pinned original-main control must fail
the route regression specifically because it reads past the oversized prefix.

The pinned Node test host strips two leading BOMs; workerd's native Fetch strips
one. That host behavior is not used to redefine production admission. An isolated
native Fetch oracle using the deployment compatibility date and flags verifies
zero through four leading BOMs, and the actual deployment bundle preserves the
same 503/400 decisions. The original-main bundle must pass those controls too.
