// Synthetic contract fixtures. These are UI evidence, never chain-history evidence.
export const BOUNDED_ARGS_HASH = `0x${"15".repeat(32)}`;
export const EVIDENCE_HASH = `0x${"12".repeat(32)}`;
export const UNINDEXED_HASH = `0x${"14".repeat(32)}`;
export const FAILED_PROXY_HASH = `0x${"13".repeat(32)}`;

export function extrinsicEvidenceFixture(hash: string) {
  const bounded = hash === BOUNDED_ARGS_HASH;
  let nested: unknown = "leaf";
  for (let i = 0; i < 9; i++) nested = { child: nested };
  const boundedArgs = {
    long: "x".repeat(2001),
    collection: Array.from({ length: 65 }, (_, i) => i),
    nested,
    ...Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`arg${i}`, i])),
  };
  const failed = hash === FAILED_PROXY_HASH;
  const unindexed = hash === UNINDEXED_HASH;
  return {
    ok: true,
    schema_version: 1,
    data: {
      schema_version: 1,
      ref: hash,
      extrinsic: {
        block_number: unindexed ? null : 8713384,
        extrinsic_index: unindexed ? null : 0,
        extrinsic_hash: hash,
        signer: null,
        call_module: unindexed ? null : failed ? "Proxy" : "SubtensorModule",
        call_function: unindexed ? null : failed ? "proxy" : "commit_timelocked_weights",
        call_args: bounded
          ? boundedArgs
          : unindexed
            ? null
            : failed
              ? { call: { Utility: { batch: [{ SubtensorModule: { add_stake: {} } }] } } }
              : {},
        success: unindexed ? null : !failed,
        observed_at: "2026-08-22T10:00:00.000Z",
      },
      events:
        failed || unindexed || bounded
          ? []
          : [
              {
                block_number: 8713384,
                event_index: 1,
                event_kind: "TimelockedWeightsCommitted",
                amount_tao: null,
                alpha_amount: null,
              },
              {
                block_number: 8713384,
                event_index: 2,
                event_kind: "StakeAdded",
                amount_tao: 1.25,
                alpha_amount: 2.5,
                netuid: 7,
              },
            ],
    },
    meta: { source: "synthetic-contract-fixture" },
  };
}
