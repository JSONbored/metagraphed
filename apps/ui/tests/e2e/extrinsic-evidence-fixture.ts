// Synthetic contract fixtures. These are UI evidence, never chain-history evidence.
export const EVIDENCE_HASH = `0x${"12".repeat(32)}`;
export const FAILED_PROXY_HASH = `0x${"13".repeat(32)}`;

export function extrinsicEvidenceFixture(hash: string) {
  const failed = hash === FAILED_PROXY_HASH;
  return {
    ok: true,
    schema_version: 1,
    data: {
      schema_version: 1,
      ref: hash,
      extrinsic: {
        block_number: 8713384,
        extrinsic_index: 0,
        extrinsic_hash: hash,
        signer: null,
        call_module: failed ? "Proxy" : "SubtensorModule",
        call_function: failed ? "proxy" : "commit_timelocked_weights",
        call_args: failed
          ? { call: { Utility: { batch: [{ SubtensorModule: { add_stake: {} } }] } } }
          : {},
        success: !failed,
        observed_at: "2026-08-22T10:00:00.000Z",
      },
      events: failed
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
