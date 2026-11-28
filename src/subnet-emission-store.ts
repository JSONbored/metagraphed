// The subnet emission store contract (MET-7365) -- the native seam the
// emission split routes read through and the capture writes through. Same
// shape discipline as selectedSubnetServicesStore: a key ABSENT from the env
// means "no store", which the builders render as the schema-stable decline;
// a key present with the wrong shape is a configuration error worth throwing
// on, not degrading over.

import type {
  LifecycleRow,
  SplitRow,
  SubnetEmissionWriter,
} from "./subnet-emission-capture.ts";

/** The newest block both families were observed whole at. */
export interface SubnetEmissionObservation {
  /** bigint block height, crossed as text. */
  block_number: string;
  /** bigint epoch-ms, crossed as text. */
  observed_at_ms: string | null;
}

/** A row with its validity range, its bounds as text. */
export type Ranged<T> = T & { valid_from: string; valid_to: string | null };

export interface SubnetEmissionCurrent {
  observation: SubnetEmissionObservation | null;
  /** Every subnet's current split row, ascending by netuid. */
  splits: Ranged<SplitRow>[];
  /** Every subnet's current lifecycle row, ascending by netuid. */
  lifecycle: Ranged<LifecycleRow>[];
}

export interface SubnetEmissionHistory {
  observation: SubnetEmissionObservation | null;
  /** One subnet's split rows, newest first and bounded. */
  splits: Ranged<SplitRow>[];
  /** One subnet's lifecycle rows, newest first and bounded. */
  lifecycle: Ranged<LifecycleRow>[];
}

export interface SubnetEmissionStore extends SubnetEmissionWriter {
  current(): Promise<SubnetEmissionCurrent>;
  subnet(netuid: number): Promise<SubnetEmissionHistory>;
}

export function selectedSubnetEmissionStore(
  env: unknown,
): SubnetEmissionStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_EMISSION_STORE" in env))
    return null;
  const store = (env as Record<string, unknown>).SUBNET_EMISSION_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    ["write", "current", "subnet"].some(
      (method) =>
        typeof (store as Record<string, unknown>)[method] !== "function",
    )
  )
    throw new TypeError("Invalid native subnet emission store");
  return store as SubnetEmissionStore;
}
