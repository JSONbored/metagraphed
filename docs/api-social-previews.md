# API social previews

The API landing and subnet/account images use a fixed graphite treatment with
the site's dark tokens, owned wordmark and bounded text. The open composition
uses a prominent Geist Mono subject, compact sentence-case facts and a separate
entity identity area. It has no header/footer bands or repeated category label.
A preview depicts supplied
public data; it does not establish the freshness of a crawler's cached image.

`src/og-card-style.ts` contains renderer-compatible literals and layout only.
Its selected colors are checked against `packages/ui-kit/src/styles.css`; the
backend imports no website runtime. The wordmark geometry is checked against
the site's owned asset. Geist Mono draws headlines and fact values; Geist draws
supporting copy, and Inter covers additional identity glyphs. The shared font loader
requests five bounded faces with encoded glyph subsets and timeouts. A font or
render failure uses the existing short-cache static fallback.

The landing card stays a publish-time artifact, with its renderer version in
the filename: `/metagraph/og-image-v4.png` for version 4. The Worker reads only
its matching filename. Until that version has been published, it serves the new
dark static fallback for 60 seconds without warming the successful image cache.
An older unversioned image therefore cannot masquerade as the new artwork.
`scripts/refresh-og-image.ts` renders it from the local registry summary, writes a
temporary file and replaces each staging artifact only after a complete write.
It writes the legacy `og-image.png` first for older Workers, then the current
versioned filename. Its success receipt includes both `artifact_paths`,
`renderer_version` and the PNG `sha256`. A failure logs `status: skipped` without
claiming current-version completion; the compatibility file may already have
been updated if a later write fails. This does not prove an R2
publication succeeded; verify the later artifact upload and served PNG separately.

The Worker serves that binary artifact at `/og.png` or `/og`. Discovery HTML and
the edge cache use the shared `CARD_VERSION`. Entity cards retain their lazy
runtime renderer and bounded registry read, with R2 keys under
`cache/og/v<version>/<kind>/<subject>-<facts digest>.png`. An unchanged entity
therefore gets new artwork after a renderer version change. Old cache objects
need no purge. Public entity URLs remain stable, and third-party recrawl is
outside these internal cache guarantees.

An entity with a declared logo is complete only after that logo has loaded.
Complete R2 objects record `entity_logo: included` in custom metadata; an older
object without this marker is regenerated on demand when a logo is expected.
An unavailable logo still produces a readable monogram, but that response gets
`public, max-age=60` with no stale-while-revalidate and is not stored in R2.
A later request can recover the logo with unchanged facts and URL. Intentional
no-logo cards keep their ordinary long cache and remain compatible with older
objects. An uncached HEAD request does no image work and uses the short lifetime
when a logo has not yet been verified. Crawlers control their own recrawl timing.

Logo reads accept only credential-free direct HTTPS requests to `metagraph.sh`, with redirects
disabled, a three-second deadline covering headers and body, and the publisher's
512 KiB byte limit enforced on the stream. PNG, JPEG, GIF and vector SVG retain
their actual MIME when inlined. Missing/unsupported MIME, mismatched raster
signatures and SVGs with embedded images or external resources are declined.
This validates format headers and bounds; raster decoding remains the renderer's
job. WebP and ICO originals require a supported derivative and currently produce
the same short-lived monogram. None of these failures establishes a completed
R2 image or triggers a background logo probe.

Subnet identifiers have their own field beside the title rather than taking a
fact slot. Account cards show one abbreviated address and destination context,
with no duplicate address statistic or invented account values. Both identifiers
and context participate in the content digest. The landing retains up to four
published facts and subnet cards up to three; missing facts reserve no empty row.
Count facts must be nonnegative safe integers; coverage and readiness scores
must be integers from 0 through 100. Invalid values are omitted without rounding
or clamping them into plausible measurements, while known zero remains visible.

Regenerate local synthetic examples and the committed full-size API fallback:

```sh
node --experimental-strip-types scripts/render-api-og-preview.ts /tmp/api-og-preview --write-fallback
```

The script renders actual Satori/Resvg PNGs and records dimensions and hashes.
It uses font requests only; entity values and logos are local fixtures. Review
normal, absent-data, account, logo, maximum-title/value, unbroken-identity and
Unicode examples. Also compare the same markup through local Workerd's actual
`workers-og` parser/wasm: HTML whitespace must not become layout children, and
glyph coverage cannot be inferred from valid PNG dimensions alone.

For release, distinguish source/CI, Worker deployment, successful artifact render,
artifact publication, and ordinary served-image verification. A versioned image
URL directs newly fetched page metadata to the new image identity; it cannot
invalidate a social platform's already-cached page or preview.
Source deployment can establish the new dark fallback before the next normal
artifact publication. Dynamic registry counts remain pending until the matching
versioned artifact has a successful render, upload and served-image receipt.
