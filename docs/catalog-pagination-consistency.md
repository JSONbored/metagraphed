# Catalog pagination consistency

Collection `cursor` remains a numeric row offset. Existing REST, MCP and client
requests keep their current behavior. An offset alone is not stable across
changes: `[a,b,c,d]` returns `[a,b]` at limit 2; removing `a` makes offset 2
return `[d]`, skipping `c`. Inserting a row before the offset can repeat `b`.

REST collection routes offer optional checked paging:

1. Start with `?limit=100&page_snapshot=start` at cursor 0 (or omit cursor).
2. Follow the returned RFC 8288 Link URLs, or echo `meta.pagination.snapshot`
   as `page_snapshot` alongside the numeric `next_cursor`.
3. A mismatched snapshot returns the existing `400 invalid_query` error with
   parameter `page_snapshot`. Restart at cursor 0 using the same search,
   filters, sort and projection; do not append that new first page to old rows.

The versioned `v1.<sha256>` identity binds the full filtered, ordered rows before
projection, their collection/public path and active query scope. Parameter and
object-key ordering do not matter; representation (`format`), page size and
numeric offset do not change the dataset identity. A resolved incident window
and public network path remain part of the scope. Hidden projected-field
changes and live-health changes can invalidate a walk too. Duplicate sort
values need no guessed unique key: unchanged ordered rows retain their order;
a tied-row reorder changes their digest. Invalid token versions and malformed
continuation offsets are rejected rather than treated as the first page.

This is a consistency check, not a retained frozen snapshot, a keyset cursor,
an authorization token, or a guarantee of progress while data keeps changing.
It identifies content, not a certified publication or chain-capture pass;
identical content can reproduce the same digest after an intervening change.
No old rows are stored; any matching-row mutation can require a restart. The
digest is computed only for opted-in requests, with work proportional to the
filtered row payload. CPU/memory and cache/freshness behavior need native
measurement before rollout. A cached guarded page still belongs to its stated
content generation; a cache miss after a mutation can require a restart.

The additive REST parameter and optional metadata field preserve existing
numeric cursor types and unguarded responses. MCP tools and GraphQL do not
advertise this mode until forwarding, output and restart contracts are
implemented there. Their existing offset behavior is preserved.

The endpoint, API catalog and provider views opt in through their shared
infinite-query helper. A mismatch stops continuation without automatic retries.
Refresh cancels pending pages, clears accumulated rows and starts at cursor zero
with the same filters. Late responses cannot append to the new query generation.
Each continuation must preserve both the first snapshot and total.

Those tables' CSV action starts a fresh checked walk and downloads only after
it completes. It preserves filters, shown columns and client sorting. Changed
results, network switches, navigation or view changes cancel the attempt rather
than emit a partial file. Exports are bounded to 50 pages, 50,000 rows and 16 MiB
of row JSON; users can narrow filters after a limit error. Provider probe columns
still merge separately cached endpoint evidence: the guard certifies the catalog
row walk, not one atomic capture spanning both sources.

The digest streams canonical rows already loaded by the collection handler. It
adds no storage queries, but costs linear CPU and per-row serialization on every
guarded cache miss. Existing artifact hashes do not cover all live overlays and
cannot safely replace that identity. Native cost and churn measurements remain
required; this source patch alone does not certify rollout acceptance for #12094.

Regenerate OpenAPI/types/client and relevant docs in the authorized native
environment, then run required schema, parity, route, coverage and UI/browser
checks. No generated output is hand-edited. Source regressions are prepared;
they were not executed on Mac.
