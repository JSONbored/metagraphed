// The commitments store contract (MET-7365) -- the native seam the commitment
// routes read through and the capture writes through. Same shape discipline
// as selectedSubnetEmissionStore: a key ABSENT from the env means "no store",
// which the builders render as the schema-stable decline; a key present with
// the wrong shape is a configuration error worth throwing on, not degrading
// over.

import type { CommitmentsWriter } from "./commitments-capture.ts";

/** The newest block the commitments were observed whole at. */
export interface CommitmentsObservation {
  /** bigint block height, crossed as text. */
  block_number: string;
  /** bigint epoch-ms, crossed as text. */
  observed_at_ms: string | null;
}

/** One stored row: the hotkey as hex without 0x, the bounds and the
 * committed block as text, the deposit as decimal rao text. */
export interface CommitmentRow {
  hotkey: string;
  valid_from: string;
  valid_to: string | null;
  committed_block: string | null;
  deposit: string | null;
  fields: unknown;
  reveals: unknown;
}

export interface SubnetCommitmentsPage {
  observation: CommitmentsObservation | null;
  /** How many current rows the subnet holds. */
  total: number;
  /** One page of them, newest commitment first. */
  rows: CommitmentRow[];
}

export interface HotkeyCommitmentHistory {
  observation: CommitmentsObservation | null;
  /** One (netuid, hotkey)'s rows, newest first and bounded. */
  rows: CommitmentRow[];
}

export interface CommitmentsStore extends CommitmentsWriter {
  subnet(
    netuid: number,
    page: { limit: number; offset: number },
  ): Promise<SubnetCommitmentsPage>;
  /** `hotkey` is the 32-byte public key as hex, no 0x. */
  hotkey(netuid: number, hotkey: string): Promise<HotkeyCommitmentHistory>;
}

export function selectedCommitmentsStore(
  env: unknown,
): CommitmentsStore | null {
  if (!env || typeof env !== "object" || !("COMMITMENTS_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).COMMITMENTS_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    ["write", "subnet", "hotkey"].some(
      (method) =>
        typeof (store as Record<string, unknown>)[method] !== "function",
    )
  )
    throw new TypeError("Invalid native commitments store");
  return store as CommitmentsStore;
}
