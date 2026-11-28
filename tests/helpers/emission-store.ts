// A bound subnet emission store (src/subnet-emission-store.ts) holding one
// current split per subnet given, for the surfaces that read a subnet's
// declared owner share (MET-7385, src/owner-share.ts).

/** u64::MAX: a subnet's whole emission in the runtime's parts. */
export const PARTS_ONE = (1n << 64n) - 1n;
/** The default split's owner slot, as the runtime builds it from 11796/65535. */
export const DEFAULT_OWNER_PARTS = (11_796n * PARTS_ONE) / 65_535n;
/** A declared 33% owner slot, as nine subnets held on 2026-11-28. */
export const DECLARED_OWNER_PARTS = (PARTS_ONE * 33n) / 100n;

/** A current split whose owner slot is `ownerParts`, the rest halved between
 * validators and miners with the miner slot taking the rounding. */
function splitRow(netuid: number, ownerParts: bigint) {
  const validator = (PARTS_ONE - ownerParts) / 2n;
  return {
    netuid,
    burn_parts: "0",
    recycle_parts: "0",
    owner_parts: String(ownerParts),
    validator_parts: String(validator),
    miner_parts: String(PARTS_ONE - ownerParts - validator),
    gamma_shares: [],
    valid_from: "9604739",
    valid_to: null,
  };
}

/** The store, with `owners` (netuid to owner parts) as its current splits, or
 * with no capture observed when `owners` is null. `calls` records its reads. */
export function emissionStore(owners: Record<number, bigint> | null) {
  const observation =
    owners === null
      ? null
      : { block_number: "9606539", observed_at_ms: "1795900000000" };
  const splits = Object.entries(owners ?? {}).map(([netuid, parts]) =>
    splitRow(Number(netuid), parts),
  );
  const calls = { current: 0, subnet: [] as number[] };
  return {
    calls,
    write: async () => ({ written: true, opened: 0, closed: 0 }),
    current: async () => {
      calls.current += 1;
      return { observation, splits, lifecycle: [] };
    },
    subnet: async (netuid: number) => {
      calls.subnet.push(netuid);
      return {
        observation,
        splits: splits.filter((row) => row.netuid === netuid),
        lifecycle: [],
      };
    },
  };
}
