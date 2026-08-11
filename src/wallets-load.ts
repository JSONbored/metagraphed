// #10488: compose the money map from the pieces that already exist.
//
// The accrual is #10484's, the disposition #10485's, the activity #10486's, the
// attribution the registry's. Nothing is computed twice and nothing is decided
// here -- this module is the seam that puts them in one response.
//
// NEVER 404s AND NEVER 500s. Every subnet has an owner; almost none has a
// declared treasury. A subnet with nothing attributed answers with an empty
// wallet list, which is a different fact from "this subnet does not exist" and
// must not be served as an error.
import {
  computeOwnerCutAccrual,
  type OwnerCutAccrual,
} from "./owner-cut-accrual.ts";
import {
  classifyOwnerCutDisposition,
  type DispositionResult,
} from "./owner-cut-disposition.ts";
import {
  aggregateWalletActivity,
  type WalletActivity,
  type WalletFlowRow,
} from "./wallet-activity.ts";

/** The activity block as SERVED: the aggregate minus the two fields that
 * restate their parent. */
type ServedWalletActivity = Omit<WalletActivity, "address" | "window_days">;

// Registry/artifact rows are read for shaping only, never trusted for control
// flow. Mirrors the readJson precedent elsewhere.
import type { SubnetEconomics as SubnetEconomicsRow } from "../schemas-src/shared.ts";

type Row = Record<string, unknown>;

/** The row under an untyped value, or null -- a nested artifact object. */
function rowOf(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

export const SUBNET_WALLETS_FIELD_SOURCES = {
  "wallets[].ss58": { kind: "measured", storage: null },
  "wallets[].role": { kind: "measured", storage: null },
  "wallets[].chain_derived": { kind: "measured", storage: null },
  "wallets[].activity": { kind: "measured", storage: null },
} as const;

export const SUBNET_OWNER_CUT_FIELD_SOURCES = {
  owner_coldkey: { kind: "measured", storage: "SubtensorModule.SubnetOwner" },
  owner_hotkey: { kind: "measured", storage: "SubtensorModule.SubnetOwner" },
  // The share itself is reconstructed: the storage item is UNSET on chain, so
  // the effective value is the runtime default rather than a read (#10484).
  "accrual.owner_cut": { kind: "reconstructed", storage: null },
  "accrual.alpha": { kind: "reconstructed", storage: null },
  "accrual.tao": { kind: "reconstructed", storage: null },
  "accrual.usd": { kind: "reconstructed", storage: null },
  "disposition.buckets": { kind: "reconstructed", storage: null },
} as const;

export interface SubnetWalletRow {
  ss58: string;
  role: string;
  chain_derived: boolean;
  name?: string | null;
  source_urls: string[];
  unspendable_proof_basis?: string | null;
  activity: ServedWalletActivity;
}

/**
 * The wallets for one subnet: the chain-derived owner keys first, then whatever
 * the registry declares.
 *
 * The owner keys are ALWAYS included when the economics row carries them, even
 * with no activity -- "this is who owns it, and nothing moved" is the baseline
 * answer, and a response that omitted them would leave a reader unable to tell
 * an unattributed subnet from an unowned one.
 */
export function subnetWalletRows(
  netuid: number,
  economics: Row | null,
  entities: Row[] | null | undefined,
  rowsByAddress: Map<string, WalletFlowRow[]> | null | undefined,
  { window_days = 30 }: { window_days?: number } = {},
): SubnetWalletRow[] {
  const out: SubnetWalletRow[] = [];
  // Project away `address` and `window_days`: the first repeats the wallet's
  // own ss58 and the second the response's, and a field that restates its
  // parent is one more thing that can disagree with it.
  const activityFor = (ss58: string) => {
    const {
      address: _address,
      window_days: _window,
      ...activity
    } = aggregateWalletActivity(ss58, rowsByAddress?.get(ss58) ?? [], {
      window_days,
    });
    return activity;
  };

  // Chain-derived, and flagged so a consumer can tell it from an attribution
  // without knowing our schema. No source_urls: the chain is the source, and an
  // empty array here means "needs none" rather than "none was provided".
  const seen = new Set<string>();
  for (const key of ["owner_coldkey", "owner_hotkey"] as const) {
    const ss58 = economics?.[key];
    if (typeof ss58 !== "string" || !ss58 || seen.has(ss58)) continue;
    seen.add(ss58);
    out.push({
      ss58,
      role: "owner",
      chain_derived: true,
      source_urls: [],
      activity: activityFor(ss58),
    });
  }

  for (const entity of Array.isArray(entities) ? entities : []) {
    const ss58 = entity?.ss58;
    if (typeof ss58 !== "string" || !ss58) continue;
    if (Number(entity?.netuid) !== netuid) continue;
    // `owner` is not a declarable category; the schema rejects it, and honouring
    // one here would let a hand-declared entry impersonate a chain read.
    const role = String(entity?.category ?? "");
    if (!role || role === "owner") continue;
    if (seen.has(ss58)) continue;
    seen.add(ss58);
    out.push({
      ss58,
      role,
      chain_derived: false,
      name: typeof entity?.name === "string" ? entity.name : null,
      source_urls: Array.isArray(entity?.source_urls)
        ? entity.source_urls.map(String)
        : [],
      unspendable_proof_basis: ((proof) =>
        typeof proof?.basis === "string" ? proof.basis : null)(
        rowOf(entity?.unspendable_proof),
      ),
      activity: activityFor(ss58),
    });
  }
  return out;
}

export interface LoadSubnetOwnerCutInput {
  netuid: number;
  window_days?: number;
  /** The subnet's economics card, typed to the contract rather than to a bag:
   *  `alpha_out_emission` and `alpha_price_tao` are read straight out of it
   *  and handed to a calculation that takes numbers (#10782).
   *
   *  `Partial`, because this reads FOUR of its ~39 members and each read is
   *  already null-tolerant -- an absent emission nulls the accrual with a
   *  reason rather than failing. Every name is still checked against the
   *  contract, so a typo is a compile error; only the arity is relaxed. */
  economics: Partial<SubnetEconomicsRow> | null;
  /** network-parameters' `subnet_owner_cut_effective`. Null makes the accrual
   * null rather than silently 18% (#10484). */
  owner_cut: number | null;
  usd_per_tao?: number | null;
  /** The subnet's own hyperparameter. Null means unread, not false. */
  owner_cut_enabled?: boolean | null;
  /** Standing stake on the owner hotkey, from the HOTKEY-SCOPED portfolio view
   * -- /positions is the nominator side and reads zero for most owners. */
  held_alpha?: number | null;
  unstaked_alpha?: number | null;
  transferred_alpha?: number | null;
  burned_alpha?: number | null;
  /** Did we actually read the flow streams? Absent means the disposition is
   * unresolved rather than held. */
  flows_observed?: boolean;
}

export interface SubnetOwnerCutView {
  netuid: number;
  window_days: number;
  owner_coldkey: string | null;
  owner_hotkey: string | null;
  accrual: Omit<OwnerCutAccrual, "netuid" | "window_days">;
  disposition: Omit<DispositionResult, "netuid" | "window_days">;
}

/** Compose the owner-cut body. Never throws on a missing piece. */
export function loadSubnetOwnerCut(
  input: LoadSubnetOwnerCutInput,
): SubnetOwnerCutView {
  const window_days = input.window_days ?? 30;
  const accrual = computeOwnerCutAccrual({
    netuid: input.netuid,
    alpha_out_per_block: input.economics?.alpha_out_emission,
    alpha_price_tao: input.economics?.alpha_price_tao,
    usd_per_tao: input.usd_per_tao ?? null,
    owner_cut: input.owner_cut,
    owner_cut_enabled: input.owner_cut_enabled ?? null,
    window_days,
  });
  const disposition = classifyOwnerCutDisposition({
    netuid: input.netuid,
    window_days,
    accrued_alpha: accrual.alpha,
    held_alpha: input.held_alpha ?? null,
    unstaked_alpha: input.unstaked_alpha ?? null,
    transferred_alpha: input.transferred_alpha ?? null,
    burned_alpha: input.burned_alpha ?? null,
    flows_observed: input.flows_observed,
  });
  const owner = (key: keyof SubnetEconomicsRow): string | null => {
    const value = input.economics?.[key];
    return typeof value === "string" && value ? value : null;
  };
  // Same projection as the wallet activity above: both sub-objects restate the
  // netuid and window they sit inside, and a field that repeats its parent is
  // one more thing that can disagree with it.
  const { netuid: _an, window_days: _aw, ...accrualBody } = accrual;
  const { netuid: _dn, window_days: _dw, ...dispositionBody } = disposition;
  return {
    netuid: input.netuid,
    window_days,
    owner_coldkey: owner("owner_coldkey"),
    owner_hotkey: owner("owner_hotkey"),
    accrual: accrualBody,
    disposition: dispositionBody,
  };
}
