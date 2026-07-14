// Broadcast path (#5238) + idempotency/double-submit/mortality guards
// (#5241), native-staking epic #5229. Per ADR 0018 §2, a signed extrinsic
// goes straight from the browser to a trusted RPC endpoint -- no
// metagraphed-owned relay, no new backend surface, so this file's only job is
// the browser-side signAndSend call and the client-side safety nets around it
// (the chain re-validates everything else; these are UX-and-double-spend
// guards, not the actual security boundary).
//
// Mortality (#5241): passing a plain number as `era` to signAndSend is NOT
// the same as constructing the on-chain MortalEra directly -- verified
// empirically against the installed @polkadot/types package (2026-07-14):
// `new GenericExtrinsicEra(registry, 64)` (a bare number, codec-level)
// throws, while @polkadot/api's own signAndSend option-preparation
// (submittable/createClass.js's makeEraOptions) treats a bare `era: N` in
// SIGNING options as the mortal *period* and combines it with the live
// current block it already fetched -- `{ era: N }` is the correct, documented
// way to request a mortal extrinsic through this API, not something this
// file needs to hand-construct. Omitting `era` entirely already defaults to
// mortal too (when a live header is available, which getApi() guarantees),
// but passing it explicitly keeps the safety property visible in code rather
// than resting on an internal library default no one here chose.

import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { Signer } from "@polkadot/api/types";
import type { DispatchError } from "@polkadot/types/interfaces";
import type { StakeCallParams } from "./chain-connection";

/** ~a few minutes at Bittensor's block time -- short enough that a stuck/abandoned signature can't be replayed much later (see the account-reap/nonce-reset risk in this module's references), long enough to comfortably survive normal signing latency. */
export const DEFAULT_MORTALITY_BLOCKS = 64;

export type BroadcastStatus =
  | "future"
  | "ready"
  | "broadcast"
  | "in-block"
  | "retracted"
  | "finality-timeout"
  | "finalized"
  | "usurped"
  | "dropped"
  | "invalid"
  | "error";

export interface BroadcastEvent {
  status: BroadcastStatus;
  txHash: string;
  blockHash?: string;
  /**
   * The raw on-chain DispatchError, present once the extrinsic reaches
   * in-block/finalized AND the call itself failed (a failed call is still
   * mined -- the transaction succeeded at the transaction-pool/block-
   * inclusion layer, only the pallet logic inside it reverted). Passed
   * through untouched -- decoding this into human copy is tx-errors.ts's
   * job (#5240), not this file's; this module only reports what the chain
   * said, verbatim.
   */
  dispatchError?: DispatchError;
}

/**
 * A stable (not cryptographic -- collision resistance for a single browser
 * session's worth of clicks is all this needs) hash of the call intent, the
 * signing account's next nonce, and a per-page-load session id. Two clicks
 * of the same submit button, for the same call, before the nonce advances,
 * produce the identical key -- exactly the "duplicate submission" this
 * exists to catch. Compute this and check hasAlreadySubmitted() BEFORE
 * prompting for a signature, not after.
 */
export function computeIdempotencyKey(
  params: StakeCallParams,
  nonce: number,
  sessionId: string,
): string {
  const stable = JSON.stringify(params, (_key, value) =>
    typeof value === "bigint" ? `bigint:${value.toString()}` : value,
  );
  return fnv1a(`${sessionId}:${nonce}:${stable}`);
}

// FNV-1a: fast, deterministic, no crypto dependency (nothing here needs to
// resist a deliberate collision attack, only accidental double-submission).
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const seenIdempotencyKeys = new Set<string>();

/** True if this exact call+nonce+session combination has already been submitted this page load. */
export function hasAlreadySubmitted(idempotencyKey: string): boolean {
  return seenIdempotencyKeys.has(idempotencyKey);
}

function mapExtrinsicStatus(status: {
  isFuture: boolean;
  isReady: boolean;
  isBroadcast: boolean;
  isInBlock: boolean;
  isRetracted: boolean;
  isFinalityTimeout: boolean;
  isFinalized: boolean;
  isUsurped: boolean;
  isDropped: boolean;
  isInvalid: boolean;
}): BroadcastStatus {
  if (status.isFuture) return "future";
  if (status.isReady) return "ready";
  if (status.isBroadcast) return "broadcast";
  if (status.isInBlock) return "in-block";
  if (status.isRetracted) return "retracted";
  if (status.isFinalityTimeout) return "finality-timeout";
  if (status.isFinalized) return "finalized";
  if (status.isUsurped) return "usurped";
  if (status.isDropped) return "dropped";
  if (status.isInvalid) return "invalid";
  return "error";
}

export interface SubmitStakeExtrinsicOptions {
  signerAddress: string;
  signer: Signer;
  /** From computeIdempotencyKey() -- required, not optional, so a caller can't accidentally skip the double-submit guard. */
  idempotencyKey: string;
  mortalityBlocks?: number;
  onStatus?: (event: BroadcastEvent) => void;
}

/**
 * Sign and broadcast a constructed extrinsic directly to this connection's
 * RPC endpoint (ADR 0018 §2 -- never through metagraphed's own backend).
 * Throws synchronously, before ever prompting for a signature, if
 * idempotencyKey has already been used this page load.
 */
export async function submitStakeExtrinsic(
  _api: ApiPromise,
  extrinsic: SubmittableExtrinsic<"promise">,
  {
    signerAddress,
    signer,
    idempotencyKey,
    mortalityBlocks = DEFAULT_MORTALITY_BLOCKS,
    onStatus,
  }: SubmitStakeExtrinsicOptions,
): Promise<{ txHash: string; unsubscribe: () => void }> {
  if (hasAlreadySubmitted(idempotencyKey)) {
    throw new Error("This transaction was already submitted -- refusing to resubmit.");
  }
  seenIdempotencyKeys.add(idempotencyKey);

  const unsubscribe = await extrinsic.signAndSend(
    signerAddress,
    { signer, era: mortalityBlocks },
    (result) => {
      onStatus?.({
        status: mapExtrinsicStatus(result.status),
        txHash: extrinsic.hash.toHex(),
        blockHash: result.status.isInBlock
          ? result.status.asInBlock.toHex()
          : result.status.isFinalized
            ? result.status.asFinalized.toHex()
            : undefined,
        dispatchError: result.dispatchError,
      });
    },
  );

  return { txHash: extrinsic.hash.toHex(), unsubscribe };
}
