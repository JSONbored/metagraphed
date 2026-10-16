# Live head delivery and persistence retry

The firehose's `head:last_seen` cursor records live delivery, not a committed
`blocks_head` receipt. `head:write_next` independently records the next required
sink write. It is stored before advancing live progress and advances only when
the actual mirror returns `result.ok === true`. A failed or absent sink leaves
that intent pending across eviction, including when the live head is unchanged.

Live delivery runs first. Persistence retries contiguous heights from the oldest
pending intent, never the recent-window truncation used by live catch-up. Both
paths share at most 25 block fetches per alarm and reuse fetched blocks. A full
live catch-up window reserves one slot for an older retry; ordinary new-head
traffic leaves up to 24 repair slots. A failed sink write stops persistence at
that height while the alarm still rearms. Current live headers can also commit
out of order within the same 25-block budget; those successes never advance the
contiguous cursor. If an old RPC block is unavailable, current cached live blocks
can still reach the sink while the failed height remains pending and reported.
A failed sink stops further writes in that alarm to avoid an outage write storm.
A cursor acknowledgement failure retries
the same existing height-keyed UPSERT; it does not advance uncertain progress.

This is prospective retry, not a historical replay or a new archive. On adoption,
an absent/invalid write intent starts after the legacy live cursor, or at the
current head if that cursor is absent/invalid. Legacy progress is unverified;
this cannot certify or repair writes skipped before adoption. A lower RPC head
does not regress either cursor. These are best-head observations, not finalized
canonical history: the existing finalized raw-capture owner remains distinct.
Historical RPC state may be pruned or differ after a reorg; retry is not proof
that the exact originally observed metadata can be regenerated. No old rows,
checkpoints, originals or history are deleted or automatically redriven.

The storage keys use the existing Durable Object storage and require no schema,
class migration, binding, credential, schedule or ownership change. A rollback to
old code loses the new retry guarantee; retain the pending key for a compatible
roll-forward. This source fix creates no capacity in a full D1 database. Verify
the running version, real sink writes and stored freshness after capacity is
restored. Queue acceptance/quarantine receipts and the direct subnet-burn capture
have separate owners and do not prove these head writes committed.
