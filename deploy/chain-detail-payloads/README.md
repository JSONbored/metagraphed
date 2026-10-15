# Native payload publication and finite retention

Prepared schema only. No workflow applies this bundle, sets a quota, deploys a
Worker or deletes data. The capacity and physical-schema gates remain held.

The native writer requires this held schema for chunked captures. It stages exact
chunk statements and business references, then
commits them with all four families in one existing D1 batch. All statements
count against the same900 ceiling; every statement retains the100-bind ceiling.
Existing parts must have identical bytes. Extra parts fail the same transaction.
A late failure rolls back newly inserted parts, references, coverage, revisions
and quota accounting. No catch-path deletion can damage a concurrent shared hash.
A different compressed representation for the same logical hash is refused and
requires explicit verified representation migration; it is never overwritten.

The schema bundle maintains a single encoded-byte counter through database
triggers, counting unique committed parts, including retained orphans. Its limit
starts at0 and must be explicitly chosen from measurements. Exact replay uses
no new quota. A replacement requiring extra retained bytes can fail before any
business change if headroom is absent. Provisioning and source activation must
be coordinated; a chunked capture refuses a missing quota schema. Inline/small
payloads keep their current behavior. Before enabling, verify the quota trigger
set, actual census/counter agreement, backup closure and replacement headroom.
This is an encoded-storage admission bound, not a physical-size, RAM or latency
claim. Malicious/administrative bypass of triggers is outside this writer's trust
boundary. Restores must recompute/verify the counter, rather than double-apply it.

There is deliberately no automatic chunk deletion. Successful replacements and
row retention can leave old parts, but they stay charged to the finite quota.
This preserves already-selected/in-flight rows: hot row selection and chunk
hydration are separate reads today. A zero-current-reference GC could delete a
chunk between those reads. Reclamation requires a separately qualified coherent
read or lease/snapshot protocol and private restoration proof. Until then, an
exhausted quota is explicit admission failure and requires operator recovery;
it does not justify increasing a limit or unsafe cleanup. Old unreferenced parts
are counted by the explicit initial census; that full scan's cost is an
application gate, not something CI or this preparation executes in production.

Private whole-source restore must carry the business rows, native chunk parts
and all referenced legacy R2 v1/v2 originals. Verify exact part census/order,
stored bytes, raw-byte SHA256, decompression limits and row-reference closure
before selecting the restored owner. Derive the quota counter from restored
parts with writers held. A public four-table projection is not that backup.
Do not widen public export to expose private control or closure state.

## Prepared reader-safe reclamation

The successor reader captures selected rows and their immutable chunk parts in
one D1 batch. Hydration consumes that owned snapshot and cannot fall back to a
later chunk lookup. Direct block/extrinsic/event readers and indexed hot-tail
readers use the same helper. Metadata-only/account/aggregate reads keep their
existing paths. Separate result rows preserve D1's per-row byte limit. Snapshot
parts have a 48MiB encoded and300-part transfer ceiling; an admitted32MiB raw
selection needs fewer than280 parts. Corrupt or oversized selections retain the
existing fail-closed digest/order/decompression checks.

The prepared quota bundle adds NUL-safe BLOB expression indexes for both native
reference owners and a bounded sweep cursor. `CHAIN_DETAIL_PAYLOAD_GC=enabled`
opts the existing prune tick into one pass of at most16hashes/192parts; no checked
in configuration enables it. The cursor scans forward through live hashes and
wraps, so a live prefix cannot permanently hide retired hashes. Reference checks,
chunk deletion, trigger-based quota release and cursor advance commit together.
A competing publisher serializes on the same D1 database; current references
protect shared hashes, while a later publication recreates exact deleted parts
inside its original atomic capture. Failed batches preserve cursor/counter/data.

This replaces the earlier deliberate no-GC source policy only after coordinated
activation. Every writer must publish parts and references atomically. Do not
enable reclamation while any reader performs separate row/chunk reads or older
writer/reader invocations remain in flight. The standalone
hydration helper still supports offline callers; it is not a concurrent read
protocol without a supplied snapshot. Private coherent restores must retain the
new cursor/index schema and derive/verify the quota counter from original parts.
No schema bundle, flag, deployment or live deletion is activated here.

Native fixtures must verify racing readers, either family keeping a shared hash,
failed and competing sweeps, publication after candidate selection, cursor
fairness, repeated replacement, and restored source/counter/reader projections.
Actual sweep throughput versus retirement rate, DB/page/free-space amplification,
query plans, serving interference, RPO/RTO and whole-estate REST/MCP/UI corpus
remain separate measured acceptance. Fixed per-tick work is not a throughput or
capacity guarantee; quota exhaustion remains explicit admission failure.

## Historical hot-tier sizing and retention rationale

The following notes are preserved verbatim from the prune module header. Their
August sample and capacity language are historical source context, not a current
volume census or qualification of the new payload/read/reclamation envelope.
Current sizes, runtime resource use and sweep throughput require measurement.

Retention for the chain-detail hot tier (#9208).

THE WINDOW COVERS THE SERVING GAP: chain tip minus the oldest selected index.
Below that seam the retained reader holds the same rows at full depth, so
a hot row below it is a duplicate that costs D1 space and buys nothing. The
decode lane runs HOURLY, so that gap is normally <= 2h (~600 blocks at the
chain's 12s cadence). This is not an archive and it is never backfilled --
history is the lakehouse's job, and #9208 says so explicitly.

Decoded rows alone are insufficient: index publication can still be pending.
Legacy environments retain their decode-watermark policy.

THE FLOOR IS MEASURED, NOT GUESSED (2026-08-03). Ten real blocks were pulled
from the live API across 8,740,000-8,759,000, loaded into THIS migration's
exact schema in SQLite, and measured by page count (so index overhead is in
the number, not left out of it). chain_events args came from the real
captured fixtures in tests/chain-event-args.test.ts -- block 8,587,754,
indices 412 and 119 -- because that stream has no live reader to sample:

extrinsics 1,365 B/row (mean call_args 863 B), 27.6 rows/block
account_events 153 B/row, 329.8 rows/block
chain_events 289 B/row (mean args 183 B), 339 rows/block
-> 181.6 KiB per block

At the chain's ~300 blocks/hour that is ~53 MiB/hour resident, so the 6h
floor below holds ~319 MiB: 3.1% of the store's 10 GB per-database cap. The 24h
ceiling holds ~1.25 GiB, 12.5% of the cap, which is the price of the failure
mode where the decoder has been dead for a full day.

AT SUSTAINED PEAK, which is the number that actually has to fit: the measured
per-block maxima are 143 extrinsics / 667 chain_events / 461 account_events,
and a window where EVERY block looks like that costs 448 KiB/block -> 787 MiB
at 6h (7.7% of the cap) and 3.1 GiB at the 24h ceiling. Still comfortable at
the floor, and still short of the cap at the ceiling.

ONE HONEST CAVEAT. The 863 B call_args mean was measured on the SERVED
(normalized) shape, because the raw scale_value tree is only readable through
the R2 SQL token this repo does not hold. The stored form is the raw tree and
is therefore LARGER. The peak-case row above absorbs it with room to spare:
call_args would have to grow ~5x before the 6h window reached a tenth of the
cap, and the window is 6h -- 3x the hourly decode lane's worst-case lag --
because that is what #9208 asked for, not because capacity is what bounds it.

THE WINDOW IS ADAPTIVE, and that is the part worth reading. A FIXED 6h window
would create a gap the moment the decode lane fell more than 6h behind: rows
dropped here before the lakehouse absorbed them, and every block in between
declining. So the retained depth follows the SEAM -- the same resolved
watermark the read path routes on -- and only falls back to the 6h floor when
the seam is close, which is the normal case. The 24h ceiling is what stops a
multi-day decoder outage from turning D1 into the archive this tier refuses
to be; past it the prune resumes and the reads decline, loudly and
diagnosably, which is the correct failure for a lane that has been broken for
a day.

PRUNING IS BLOCK-SCOPED, NOT TIME-SCOPED, for the same reason the seam is a
height: `observed_at` is an observer's clock and the coverage question is
about heights. A wall-clock cutoff would also make the prune's behaviour
depend on whether the lane is currently running, which is exactly when it
must not.

## Historical hot-tier routing rationale

Preserved source header; dated observations are historical context. Current
readers use the coherent payload snapshot described above.

```text
// Block drill-down for the range the lakehouse has not decoded yet (#9208).
//
// THE SHAPE OF THE PROBLEM. `blocks_head` carries block HEADERS to chain tip,
// so the block LIST is realtime; extrinsics and events exist only in the R2
// lakehouse, and only once the hourly batch decoder has run. Measured in
// production against head 8,762,608 (2026-08-03): block 8,759,000 answered 29
// extrinsics and 100 events, block 8,762,600 answered 0 and 0. A block explorer
// whose list is live and whose DETAIL is empty is the worst possible shape --
// it looks healthy until someone clicks.
//
// So there are now two tiers per block, exactly as there already are for
// headers, and this module is the hot one plus the routing between them:
//
//   block_number <= seam  ->  R2 lakehouse (verified history, full depth)
//   block_number >  seam  ->  D1 chain_detail_* (the live-follow lane's window)
//
// ONE SEAM, AND IT IS THE SAME SEAM. `resolveBlocksSeam` (src/blocks-cold-tier.ts,
// #9217) resolves the decoder's own published watermark, floored by the
// configured constant. This module calls it and does not introduce a second
// knob -- "how far is decoded" has exactly one derived answer, and a hot tier
// with its own idea of that answer would be a second source of truth that
// drifts silently in whichever direction nobody is watching.
//
// A GAP DECLINES. It never answers empty. Above the seam, an empty extrinsics
// array is indistinguishable from a block that genuinely had none, and that
// ambiguity IS the bug this whole issue exists to kill. So the hot tier's
// answer is authoritative ONLY for a block present in `chain_detail_blocks` --
// the coverage register the sync writes last. A block above the seam that the
// register does not carry is outside the window (not yet followed, or pruned
// past), and after giving the lakehouse its own chance to answer, the read
// DECLINES. `answerBlockDetail` returns `{kind:"gap"}` and the caller turns it
// into a 503 with a typed code, which a client can retry and a human can
// diagnose; an empty 200 is neither.
//
// THE LAKEHOUSE STILL GETS ASKED above the seam, before any decline. The
// published watermark is the MIN across four tables, so a run that committed
// chain.extrinsics and died before chain.chain_events leaves real rows above
// it -- src/extrinsics-cold-tier.ts's header makes exactly this argument for
// why it refuses to gate on the seam at all. Refusing rows we hold would be the
// same failure in a new place, so the order is: hot, then cold, then decline.
//
// There is one safe early decline: the watermark also carries each table's
// individual decode ceiling. If the relevant table's published ceiling is
// below a numeric block, it is impossible for its lakehouse query to answer --
// not merely unlikely -- so the slow query is skipped. A per-table ceiling is
// never positive evidence, and absent or stale diagnostics keep the full
// hot-then-cold path.

```
