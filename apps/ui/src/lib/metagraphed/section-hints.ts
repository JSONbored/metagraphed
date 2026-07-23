/**
 * Central copy for section-title tooltips. Keeping this in one place makes
 * the wording easy to review, edit, and reuse — hint copy is UX writing, not
 * component logic.
 */
export const BLOCK_SECTION_HINTS = {
  chain:
    "Previous and next blocks on the canonical chain, with a live per-block cadence trend so you can spot slow slots or catch-ups.",
  details:
    "Core header fields: block number, hash, parent hash, author, extrinsic and event counts, and when this block was observed.",
  extrinsics:
    "Signed or inherent transactions included in this block. Click a row to jump to its extrinsic detail page.",
  events:
    "Runtime events emitted while this block executed — rewards, transfers, staking, sudo, and system notices — grouped under the extrinsic that triggered them.",
  chainEventsRaw:
    "Unfiltered per-event stream straight from the node. Useful for indexer debugging; the grouped view above is friendlier for humans.",
  call: "Ready-to-run API and artifact URLs for this block — copy them straight into curl, a client, or a browser.",
} as const;

export const BLOCK_TERM_HINTS = {
  cadence:
    "Seconds between consecutive blocks. Subtensor targets ~12s; spikes mean missed slots or catch-up bursts.",
  blockHash: "SCALE-encoded hash of this block's header. Uniquely identifies the block.",
  parentHash: "Hash of the block immediately before this one on the canonical chain.",
  author: "SS58 address of the validator that authored (produced) this block.",
  extrinsic:
    "An extrinsic is a transaction or inherent that was included in the block — the unit of state change on Substrate chains.",
  event:
    "A runtime event is a side effect emitted while executing an extrinsic or system logic (transfer, reward, sudo, etc.).",
  successRate:
    "Share of this block's extrinsics that returned Success. Failed extrinsics still get on-chain, but their state changes are reverted.",
  valueMoved:
    "Sum of τ transferred by economically-relevant events in this block (rewards, transfers, stake adds/removes). Approximate — some pallets don't emit a τ amount.",
} as const;
