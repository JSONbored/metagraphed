# Daily complete Alpha observations (#501)

This source batch rides the existing `validator_nominators` full scan and its
runtime-qualified Alpha receiver. It adds no RPC calls, scheduler, producer,
membership-delta inference or later-pool valuation. Deployment and migration
0044 remain held with the existing Alpha foundation.

`nominator_daily_captures` selects one complete full-pass membership per UTC
**observation** date (`captured_at`), independent of the globally current
serving selection. Completion after midnight still belongs to its original
observation date. It is not a reconstructed chain-midnight balance. A delayed
older date may qualify without replacing current serving data.

Within a date, a later observation can replace the selection only at a strictly
higher block; both observation time and block height must advance. An equal-height
same-hash pass cannot replace selected originals. An equal-height conflicting
hash refuses completion. Actual retained
member count, declared rows/chunks and original runtime metadata must agree
before selection. Qualification, selection, current membership, both daily
export revisions and same-day superseded-original cleanup share the receiver's
existing native transaction. Lost acknowledgements reuse durable chunk receipts.

The `nominator_positions_daily` view reads the selected pass's retained exact
originals. Its logical key is `(coldkey, hotkey, netuid, snapshot_date)`; the
view has no physical primary key. The selector and retained member keys prove
uniqueness. A later complete scan omitting a member records their absence for
that later observation; it does not carry their old position forward or invent
a departure time between observations. The amount and operands stay at the
same runtime-qualified capture. Self-stake and Root remain separate domains.

Completed selected originals are retained without initial expiry. Only
superseded completed captures of the packet's observation day are pruned.
Incomplete captures and every selected day remain. Mutation/delete fences make
an older receiver's blanket staging cleanup fail atomically, so rollback must
retain a compatible receiver. Receipts cannot reconstruct originals deleted
before this migration; no preexisting daily coverage is fabricated.

## Bounded native logical reads

The existing authenticated state-export POST accepts `kind: "nominator-daily"`:

- `operation: "days", from, to` lists at most 31 UTC dates. Complete zero-member
  observations are present with `rows:0`. Dates without a qualified observation
  are `missing_unobserved`; this does not establish pruning or runtime support.
- `operation: "capture", day` returns up to 100 exact historical members and the
  selected capture identity/provenance. Continue with its `captured_at` and
  three-part `next_cursor`. A replacement selection returns 412; restart that
  date rather than concatenate different scans. Save progress only after
  durably retaining and verifying a page; verify its total against
  `expected_rows`, and re-read the selected identity after the final page.
- `operation: "metadata", sha256` returns the existing immutable original
  SCALE metadata once per digest. Keep its identity with the member originals.

The fixed `alpha-daily-members-v1` projection uses an explicit field list;
metadata originals are checked against their runtime pins and content digest.
These operations require the whole declared D1 daily read family; partial
ownership or corrupt runtime/quantity evidence is unavailable, never a measured
empty response. Existing state-export authentication and request-byte limits
apply before dispatch. These are internal operations, not a new public API or
MCP contract. Public history presentation and external retention consumers must
use this owner, not introduce another scan or join current pool totals.

This is a logical read endpoint, not a qualified source-backup or restore
contract: it does not export original chunk receipts or the whole control state.
The dedicated per-capture projection avoids silently expanding the generic
`lossless-v1` full-projection two-million-row ceiling. It does not change that
protocol or certify a backup. Prove full source export, receipt/control-state
recovery and a native restore rehearsal before calling the history recoverable.

## Growth, qualification and release gates

For N retained nonroot Alpha positions per day, membership grows by about 365N
rows/year, plus one selector, pass/chunk receipts and per-pool records per scan.
One million/day means 365 million member rows/year as an illustration, not an
observed population or storage estimate. Measure exact evidence bytes, index
bytes, pool cardinality, writes/scan, full-pass transaction CPU, database growth,
export duration and independent-backup/restore throughput before deployment or
choosing a capacity/retention horizon. Spare CPU does not provide this budget.

The cadence watchdog measures the selected head's `captured_at` at 1.5 existing
24-hour ticks, including a qualified empty pass. Pending captures do not advance
it. The derived view has no separate periodic writer. No new scan cadence is
introduced.

Native CI fixtures must cover three distinct observation dates, departures,
same-day replacement, midnight completion, delayed older completion, partial
competitors, zero versus missing, stale continuation, exact runtime operands,
lost ACK after superseded cleanup, revision/census rollback and old-receiver
cleanup fences. Before manual issue closure, observe at least three real dates
and prove retained membership/coverage, source/export parity and restore. No
fixture is evidence of authentic chain history. #452 runtime-item coverage,
#526 resumable historical repair, #654 index capacity and #695 event coverage
remain separate required dependencies.
