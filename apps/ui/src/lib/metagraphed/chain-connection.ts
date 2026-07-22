// The one boundary that touches @polkadot/api directly (#5237, native-staking
// epic #5229). Mirrors wallet-injected.ts's SSR-safety pattern exactly: every
// function here reaches @polkadot/api via a dynamic import() inside a
// client-only-guarded function body, never a static top-level import --
// @polkadot/util-crypto (a transitive dep, shared with @polkadot/extension-
// dapp) triggers WASM init as an import-time side effect, so a static import
// anywhere would put it on the SSR bundle regardless of whether it's called.
// See wallet-injected.ts's header comment and apps/ui/vite.config.ts's Nitro
// rollup:before hook (which externalizes the whole @polkadot/* tree from the
// Cloudflare Workers server build by prefix, so a static import here would
// still fail the build even before it fails at runtime).
//
// Per ADR 0018 §2, this connects directly to a trusted, already-public RPC
// endpoint (workers/config.ts's TRUSTED_RPC_UPSTREAM_ORIGINS) -- signed
// extrinsics never transit metagraphed's own backend.

import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type {
  AddStakeLimitParams,
  RemoveStakeLimitParams,
  SwapStakeLimitParams,
  MoveStakeParams,
} from "./stake-extrinsics";
import type { IncreaseTakeParams, DecreaseTakeParams } from "./take-extrinsics";
import { asRao, type Rao } from "./units";

export type StakeCallParams =
  | AddStakeLimitParams
  | RemoveStakeLimitParams
  | SwapStakeLimitParams
  | MoveStakeParams
  | IncreaseTakeParams
  | DecreaseTakeParams;

/**
 * The official Bittensor entrypoint -- matches ADR 0018 §2's "the same shape
 * Polkadot.js Apps itself uses." Callers may pass any other entry from
 * TRUSTED_RPC_UPSTREAM_ORIGINS explicitly (e.g. the broadcast path in #5238
 * may prefer a different one for submission specifically).
 */
export const DEFAULT_RPC_ENDPOINT = "wss://entrypoint-finney.opentensor.ai";

let cachedApi: Promise<ApiPromise> | null = null;

/**
 * Connect (once, cached) to a trusted RPC endpoint and return the live,
 * metadata-aware ApiPromise. Client-only -- throws under SSR rather than
 * silently returning something unusable, since every caller of this function
 * is itself already a client-only code path (a connect button, a confirm
 * screen) with nothing sensible to do with an SSR fallback.
 */
export async function getApi(endpoint: string = DEFAULT_RPC_ENDPOINT): Promise<ApiPromise> {
  if (typeof window === "undefined") {
    throw new Error("getApi() is client-only and must not be called during SSR");
  }
  if (!cachedApi) {
    cachedApi = (async () => {
      const { ApiPromise, WsProvider } = await import("@polkadot/api");
      const provider = new WsProvider(endpoint);
      return ApiPromise.create({ provider });
    })();
  }
  return cachedApi;
}

// subtensor is a custom runtime with no published @polkadot/api-augment-style
// declaration-merging package, so ApiPromise's generic `consts`/`query` proxy
// types resolve to the base `Codec` rather than a pallet-specific interface --
// a real gap in the ecosystem's type coverage for this chain, not something
// fixable from this repo. `.toBigInt()` is a standard method every numeric
// SCALE codec (u64/u128/Compact<...>) implements; these two narrow, local
// interfaces name only the one method/field each call site actually uses,
// rather than reaching for a blanket `any` that would silently swallow a
// genuine shape mismatch elsewhere in the same expression.
interface BigIntCodec {
  toBigInt(): bigint;
}
interface AccountInfoCodec {
  data: { free: BigIntCodec };
}
interface NumberCodec {
  toNumber(): number;
}
// LastRateLimitedBlock is StorageMap<Identity, RateLimitKey<AccountId>, u64> --
// a single generic map keyed by an enum whose exact shape subtensor's own
// on-chain metadata supplies at connection time (RateLimitKey isn't a
// standard substrate primitive, so there's no static type for it the way
// there is for e.g. AccountId). Empirically confirmed against live mainnet
// (2026-07-15) that passing the enum as a plain `{ VariantName: value }`
// object -- the same shape @polkadot/api accepts for any enum-typed query
// argument once the runtime metadata describes it -- resolves correctly.
interface SubtensorQueryApi {
  query: {
    subtensorModule: {
      maxDelegateTake(): Promise<NumberCodec>;
      minDelegateTake(): Promise<NumberCodec>;
      txDelegateTakeRateLimit(): Promise<NumberCodec>;
      delegates(hotkey: string): Promise<NumberCodec>;
      lastRateLimitedBlock(key: { LastTxBlockDelegateTake: string }): Promise<NumberCodec>;
    };
  };
}

/**
 * The network's live minimum stake floor (rao), read from the pallet's own
 * `InitialMinStake` constant -- a real `#[pallet::constant]` in subtensor's
 * Config trait (verified against pallets/subtensor/src/macros/config.rs, live
 * 2026-07-14), never hardcoded client-side. A stale hardcoded guess could
 * silently accept an amount the chain would reject (AmountTooLow), or reject
 * a valid one -- querying the real value has no such drift risk.
 */
export async function getMinStake(api: ApiPromise): Promise<Rao> {
  const raw = api.consts.subtensorModule.initialMinStake as unknown as BigIntCodec;
  return asRao(raw.toBigInt());
}

/** The coldkey's spendable free balance (rao) -- for validateStakeInputs' availableBalanceRao. */
export async function getFreeBalance(api: ApiPromise, coldkeySs58: string): Promise<Rao> {
  const account = (await api.query.system.account(coldkeySs58)) as unknown as AccountInfoCodec;
  return asRao(account.data.free.toBigInt());
}

/**
 * The next unused transaction index (nonce) for an account, including any
 * still-pending transactions in the node's tx pool -- for
 * computeIdempotencyKey's nonce input. This is a standard substrate RPC
 * (system_accountNextIndex, aka `system.accountNextIndex`), fully typed via
 * @polkadot/api-augment unlike subtensor's own custom pallet surface, so no
 * narrow local interface cast is needed here.
 */
export async function getNextNonce(api: ApiPromise, ss58: string): Promise<number> {
  const index = await api.rpc.system.accountNextIndex(ss58);
  return index.toNumber();
}

/** The live current block height, for computing a delegate-take cooldown remainder against getLastTxBlockDelegateTake. */
export async function getCurrentBlock(api: ApiPromise): Promise<number> {
  const header = await api.rpc.chain.getHeader();
  return header.number.toNumber();
}

/**
 * Live take (commission) bounds and rate-limit period -- all three are real
 * StorageValues (not `#[pallet::constant]`s), confirmed live against mainnet
 * 2026-07-15 (maxDelegateTake=11796 [18%], minDelegateTake=0,
 * txDelegateTakeRateLimit=216000 blocks) -- same never-hardcode rule as
 * getMinStake, since governance could change any of these post-genesis.
 */
export async function getMaxDelegateTake(api: ApiPromise): Promise<number> {
  const raw = await (api as unknown as SubtensorQueryApi).query.subtensorModule.maxDelegateTake();
  return raw.toNumber();
}

export async function getMinDelegateTake(api: ApiPromise): Promise<number> {
  const raw = await (api as unknown as SubtensorQueryApi).query.subtensorModule.minDelegateTake();
  return raw.toNumber();
}

export async function getTxDelegateTakeRateLimit(api: ApiPromise): Promise<number> {
  const raw = await (
    api as unknown as SubtensorQueryApi
  ).query.subtensorModule.txDelegateTakeRateLimit();
  return raw.toNumber();
}

/**
 * This hotkey's current take (PerU16 parts). `Delegates` is a `ValueQuery`
 * map -- a hotkey that has never explicitly set a take still returns a real
 * number (the pallet's own default), never "not found". do_increase_take/
 * do_decrease_take use `try_get` internally and only enforce the strictly-
 * greater/less-than-current check when a value was explicitly written
 * before -- that Option-vs-default distinction isn't visible through this
 * convenience query, so validateTakeInputs (take-extrinsics.ts) applies the
 * strictly-monotonic check unconditionally. That's strictly more
 * conservative than the chain, never less: the one edge case this can
 * wrongly block is a hotkey's very first take change landing exactly on the
 * pallet's default value, which the chain would actually allow -- a rare,
 * UX-only over-caution, not a fund-safety gap.
 */
export async function getCurrentTakeParts(api: ApiPromise, hotkey: string): Promise<number> {
  const raw = await (api as unknown as SubtensorQueryApi).query.subtensorModule.delegates(hotkey);
  return raw.toNumber();
}

/**
 * The block this hotkey's take was last changed at (increase OR decrease --
 * decrease_take writes this timestamp too, even though it never itself gates
 * on it; see take-extrinsics.ts's header comment). 0 means "never changed" --
 * the ValueQuery default for an unwritten map entry, and also
 * isDelegateTakeRateLimited's own "never limited" sentinel.
 */
export async function getLastTxBlockDelegateTake(api: ApiPromise, hotkey: string): Promise<number> {
  const raw = await (
    api as unknown as SubtensorQueryApi
  ).query.subtensorModule.lastRateLimitedBlock({ LastTxBlockDelegateTake: hotkey });
  return raw.toNumber();
}

/**
 * Turn a pure params object (from stake-extrinsics.ts's builders) into a
 * signable SubmittableExtrinsic against this connection's runtime metadata.
 * The parameter ORDER passed to each api.tx.subtensorModule.* call below must
 * exactly match stake-extrinsics.ts's own verified-against-pallet-source
 * order -- this function is the only place that order is spent, so a
 * mismatch here is silent and would only surface as a chain-side decode
 * failure or, worse, a differently-shaped call succeeding by accident.
 */
export function buildExtrinsic(
  api: ApiPromise,
  params: StakeCallParams,
): SubmittableExtrinsic<"promise"> {
  switch (params.call) {
    case "add_stake_limit":
      return api.tx.subtensorModule.addStakeLimit(
        params.hotkey,
        params.netuid,
        params.amountStaked,
        params.limitPrice,
        params.allowPartial,
      );
    case "remove_stake_limit":
      return api.tx.subtensorModule.removeStakeLimit(
        params.hotkey,
        params.netuid,
        params.amountUnstaked,
        params.limitPrice,
        params.allowPartial,
      );
    case "swap_stake_limit":
      return api.tx.subtensorModule.swapStakeLimit(
        params.hotkey,
        params.originNetuid,
        params.destinationNetuid,
        params.alphaAmount,
        params.limitPrice,
        params.allowPartial,
      );
    case "move_stake":
      return api.tx.subtensorModule.moveStake(
        params.originHotkey,
        params.destinationHotkey,
        params.netuid,
        params.netuid,
        params.alphaAmount,
      );
    case "increase_take":
      return api.tx.subtensorModule.increaseTake(params.hotkey, params.take);
    case "decrease_take":
      return api.tx.subtensorModule.decreaseTake(params.hotkey, params.take);
  }
}
