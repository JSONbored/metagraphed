# Native API static assets

`createNativeStaticAssets` replaces the API Worker's `ASSETS` binding with an
explicit immutable directory snapshot. It retains exact file bytes and serves
only those paths, with MIME types, strong content ETags, conditional GET and
HEAD. It does not serve the separate UI or start an HTTP listener.

Construction validates ownership and permissions, refuses symlinks and special
files, bounds directory depth and entries, and checks each file's identity,
size and timestamps while reading. The configured file, total-memory, and
response-concurrency limits are mandatory. Admission remains held until the
response body is consumed, cancelled, or times out; each pull copies only a
bounded chunk and cannot mutate the stored snapshot. Directory changes after construction
cannot alter the snapshot; a new snapshot requires a new adapter.

The existing operating-system metadata exclusions and `.assetsignore` entries
are supported. Other ignore policies and `_headers`/`_redirects` fail visibly
until an explicit native implementation is supplied. Hidden files are excluded
except public discovery content beneath `.well-known`. Paths are exact; the
adapter does not invent redirects or extension aliases.

The owner closes the adapter after request admission stops. All open files are
closed during construction, and close drains admitted response creation before
releasing the snapshot memory. The final native environment must select this
adapter explicitly; this change does not alter Worker deployment or production
asset ownership.
