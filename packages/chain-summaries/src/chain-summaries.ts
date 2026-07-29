// #8371: a deterministic one-line "action sentence" over the decode
// infrastructure #4319/#8322 already shipped -- "SubtensorModule.
// commit_timelocked_mechanism_weights" + a raw arg table becomes "Validator
// 5GQi…sQQ committed time-locked weights for SN89, revealing at round
// 30,777,610." A pallet.method with no template returns null; callers keep
// today's raw rendering rather than ever guessing at meaning.
//
// Template selection is grounded in real observed volume (GET /api/v1/
// chain/calls?group_by=module_function and GET /api/v1/chain-events/stats),
// not assumption -- see chain-summaries.coverage.ts for the measured
// coverage script. Every call template below was checked against a real
// decoded call_args example before being written.

import { asDecodedCall, callArgValue, type DecodedCall } from "./extrinsics";
import { summarizeChainEvent } from "./chain-event-summary";
import { formatTao, shortHash } from "./format";

export interface SummaryContext {
  /** The extrinsic's signer, or the account that authored a chain event. */
  signer?: string | null;
}

/** "SN64", or null when netuid can't be read. */
function subnetLabel(netuid: unknown): string | null {
  const n = parseNetuidLike(netuid);
  return n == null ? null : `SN${n}`;
}

/**
 * `netuid` arrives as a plain number at an extrinsic's top level but as a
 * hex string (`"0x04"`) inside a nested call's `call_args` (the Utility
 * batch and Proxy.proxy wrappers carry their inner call's args in the flat
 * indexer-rs shape, which doesn't re-decode hex-encoded small integers) --
 * checked live against a real Proxy -> Utility.force_batch -> Proxy.proxy ->
 * SubtensorModule.swap_stake_limit payload.
 */
function parseNetuidLike(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const n = value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Truncated address for inline sentence use, or a neutral placeholder. */
function addressLabel(ss58: unknown): string {
  if (typeof ss58 !== "string" || !ss58) return "an account";
  return shortHash(ss58) ?? ss58;
}

/** Rao (the chain's base unit) → a formatted τ amount, or null when unreadable. */
function amountLabel(rao: unknown): string | null {
  const n = typeof rao === "number" ? rao : typeof rao === "string" ? Number(rao) : null;
  if (n == null || !Number.isFinite(n)) return null;
  return formatTao(n / 1e9);
}

function fmtNumber(value: unknown): string | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  return n == null || !Number.isFinite(n) ? null : n.toLocaleString("en-US");
}

type CallTemplate = (args: unknown, ctx: SummaryContext) => string | null;

/** `{signer} <verb> {amount} <prep> {hotkey} on SN{netuid}` -- shared by every stake add/remove call, which all carry the same (hotkey, netuid, amount) core regardless of their `_limit`/`_full_limit` suffix. */
function stakeMoveTemplate(verb: string, prep: string, amountKey: string): CallTemplate {
  return (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const amount = amountLabel(callArgValue(callArgs, amountKey));
    const hotkey = callArgValue(callArgs, "hotkey");
    if (!netuid || !amount) return null;
    return `${addressLabel(ctx.signer)} ${verb} ${amount} ${prep} ${addressLabel(hotkey)} on ${netuid}.`;
  };
}

function transferTemplate(verb: string): CallTemplate {
  return (callArgs, ctx) => {
    const amount = amountLabel(callArgValue(callArgs, "value"));
    const dest = callArgValue(callArgs, "dest");
    if (!amount) return null;
    return `${addressLabel(ctx.signer)} ${verb} ${amount} to ${addressLabel(dest)}.`;
  };
}

function timelockedWeightsTemplate(): CallTemplate {
  return (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const round = fmtNumber(callArgValue(callArgs, "reveal_round"));
    if (!netuid || !round) return null;
    return `${addressLabel(ctx.signer)} committed time-locked weights for ${netuid}, revealing at round ${round}.`;
  };
}

/** A wrapper call (Utility.batch*, Proxy.proxy) that recurses into its inner call(s). */
function describeInner(call: DecodedCall | null, ctx: SummaryContext): string {
  if (!call) return "an unrecognized call";
  const summary = summarizeCall(call.call_module, call.call_function, call.call_args, ctx);
  return summary ?? `${call.call_module}.${call.call_function}`;
}

const CALL_TEMPLATES: Record<string, CallTemplate> = {
  "SubtensorModule.commit_timelocked_mechanism_weights": timelockedWeightsTemplate(),
  "SubtensorModule.commit_timelocked_weights": timelockedWeightsTemplate(),
  "SubtensorModule.commit_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid ? `${addressLabel(ctx.signer)} committed weights for ${netuid}.` : null;
  },
  "SubtensorModule.reveal_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid ? `${addressLabel(ctx.signer)} revealed weights for ${netuid}.` : null;
  },
  "SubtensorModule.set_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const dests = callArgValue(callArgs, "dests");
    const count = Array.isArray(dests) ? dests.length : null;
    if (!netuid) return null;
    return count != null
      ? `${addressLabel(ctx.signer)} set weights for ${netuid} across ${count} neurons.`
      : `${addressLabel(ctx.signer)} set weights for ${netuid}.`;
  },
  "SubtensorModule.set_mechanism_weights": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    const dests = callArgValue(callArgs, "dests");
    const count = Array.isArray(dests) ? dests.length : null;
    if (!netuid) return null;
    return count != null
      ? `${addressLabel(ctx.signer)} set weights for ${netuid} across ${count} neurons.`
      : `${addressLabel(ctx.signer)} set weights for ${netuid}.`;
  },
  "Drand.write_pulse": (callArgs) => {
    const payload = callArgValue(callArgs, "pulses_payload");
    const pulses =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>).pulses : null;
    const first = Array.isArray(pulses) ? pulses[0] : null;
    const round =
      first && typeof first === "object"
        ? fmtNumber((first as Record<string, unknown>).round)
        : null;
    return round
      ? `Recorded a randomness beacon pulse (round ${round}).`
      : "Recorded a randomness beacon pulse.";
  },
  "Ethereum.transact": () => "Submitted an EVM transaction.",
  "Commitments.set_commitment": (callArgs, ctx) => {
    const netuid = subnetLabel(callArgValue(callArgs, "netuid"));
    return netuid
      ? `${addressLabel(ctx.signer)} published a commitment for ${netuid}.`
      : `${addressLabel(ctx.signer)} published a commitment.`;
  },
  "MevShield.submit_encrypted": (_args, ctx) =>
    `${addressLabel(ctx.signer)} submitted an encrypted MEV-shield bid.`,
  "MevShield.announce_next_key": (_args, ctx) =>
    `${addressLabel(ctx.signer)} announced the next MEV-shield key.`,
  "Timestamp.set": () => "Set the chain timestamp.",
  "SubtensorModule.add_stake": stakeMoveTemplate("staked", "to", "amount_staked"),
  "SubtensorModule.add_stake_limit": stakeMoveTemplate("staked", "to", "amount_staked"),
  "SubtensorModule.remove_stake": stakeMoveTemplate("unstaked", "from", "amount_unstaked"),
  "SubtensorModule.remove_stake_limit": stakeMoveTemplate("unstaked", "from", "amount_unstaked"),
  "SubtensorModule.remove_stake_full_limit": stakeMoveTemplate(
    "unstaked",
    "from",
    "amount_unstaked",
  ),
  "Balances.transfer_keep_alive": transferTemplate("transferred"),
  "Balances.transfer_allow_death": transferTemplate("transferred"),
  "Balances.transfer_all": (_args, ctx) => {
    const dest = callArgValue(_args, "dest");
    return `${addressLabel(ctx.signer)} transferred their full balance to ${addressLabel(dest)}.`;
  },
  "Utility.batch_all": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Utility.batch": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Utility.force_batch": (callArgs, ctx) => batchSentence(callArgs, ctx),
  "Proxy.proxy": (callArgs, ctx) => {
    const real = callArgValue(callArgs, "real");
    const inner = asDecodedCall(callArgValue(callArgs, "call"));
    return `${addressLabel(ctx.signer)} acted as proxy for ${addressLabel(real)}: ${describeInner(inner, { signer: typeof real === "string" ? real : ctx.signer })}`;
  },
  "System.set_heap_pages": (callArgs) => {
    const pages = fmtNumber(callArgValue(callArgs, "pages"));
    return pages
      ? `Set the node heap page allocation to ${pages}.`
      : "Set the node heap page allocation.";
  },
  "System.remark": (_args, ctx) => `${addressLabel(ctx.signer)} submitted an on-chain remark.`,
};

function batchSentence(callArgs: unknown, ctx: SummaryContext): string | null {
  const calls = callArgValue(callArgs, "calls");
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const first = asDecodedCall(calls[0]);
  const firstSentence = describeInner(first, ctx);
  const more = calls.length - 1;
  return more > 0
    ? `${addressLabel(ctx.signer)} submitted a batch of ${calls.length} calls: ${firstSentence} (+${more} more).`
    : `${addressLabel(ctx.signer)} submitted a batch of 1 call: ${firstSentence}`;
}

/**
 * A one-line action sentence for a decoded extrinsic call, or null when no
 * template covers this pallet.method -- callers keep today's raw
 * `module.function` rendering in that case, never a guessed sentence.
 */
export function summarizeCall(
  callModule: string | null | undefined,
  callFunction: string | null | undefined,
  callArgs: unknown,
  ctx: SummaryContext = {},
): string | null {
  if (!callModule || !callFunction) return null;
  const template = CALL_TEMPLATES[`${callModule}.${callFunction}`];
  if (!template) return null;
  try {
    return template(callArgs, ctx);
  } catch {
    return null;
  }
}

type EventTemplate = (args: unknown) => string | null;

/**
 * Some `chain_events` (a raw, unnamed-field wire tier -- distinct from
 * `account_events`, which is fully keyed) arrive as a plain positional
 * array rather than a `{field: value}` object -- confirmed live for
 * WeightsSet, StakeAdded/Removed, NeuronRegistered, and both Timelocked*
 * events, each with its own field order. `summarizeChainEvent` only reads
 * keyed objects, so these need direct index access instead.
 */
function asPositionalArgs(args: unknown): unknown[] | null {
  return Array.isArray(args) ? args : null;
}

/** SCALE scalars arrive wrapped in a single-element array (`netuid: [102]`); same unwrap chain-event-summary.ts's own `unwrap()` does. */
function unwrapScalar(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function positionalNetuid(value: unknown): string | null {
  return subnetLabel(unwrapScalar(value));
}

/** `{who} <verb> {amount}` for the many single-account balance-delta events. */
function amountOnlyEvent(verb: string): EventTemplate {
  return (args) => {
    const s = summarizeChainEvent(args);
    const amount = s.amountTao == null ? null : formatTao(s.amountTao);
    if (!amount) return null;
    return s.from
      ? `${addressLabel(s.from)} ${verb} ${amount}.`
      : `${verb[0]?.toUpperCase()}${verb.slice(1)} ${amount}.`;
  };
}

/** A plain "<something happened> for SN{netuid}" event with no amount. */
function netuidOnlyEvent(sentence: string): EventTemplate {
  return (args) => {
    const s = summarizeChainEvent(args);
    return s.netuid == null ? null : `${sentence} SN${s.netuid}.`;
  };
}

/**
 * `[coldkey, hotkey, [amount], [amount2], [netuid], version]` -- the real
 * positional shape shared by StakeAdded/StakeRemoved (confirmed live), read
 * by index since neither has field names on the wire.
 */
function positionalStakeEvent(verb: string): EventTemplate {
  return (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const hotkey = typeof a[1] === "string" ? (a[1] as string) : null;
    const amount = amountLabel(unwrapScalar(a[2]));
    const netuid = positionalNetuid(a[4]);
    if (!hotkey || !amount || !netuid) return null;
    return `${addressLabel(hotkey)} ${verb} ${amount} on ${netuid}.`;
  };
}

const EVENT_TEMPLATES: Record<string, EventTemplate> = {
  "Balances.Transfer": (args) => {
    const s = summarizeChainEvent(args);
    const amount = s.amountTao == null ? null : formatTao(s.amountTao);
    if (!amount || !s.from) return null;
    return s.to
      ? `Transferred ${amount} from ${addressLabel(s.from)} to ${addressLabel(s.to)}.`
      : `Transferred ${amount} from ${addressLabel(s.from)}.`;
  },
  "Balances.Deposit": amountOnlyEvent("received a deposit of"),
  "Balances.Withdraw": amountOnlyEvent("withdrew"),
  "Balances.Issued": amountOnlyEvent("triggered the issuance of"),
  "Balances.Endowed": (args) => {
    // Real shape: {account, free_balance} -- "free_balance" isn't in
    // summarizeChainEvent's shared AMOUNT_KEYS (that list is reused by
    // every other event template + the raw events table's own Amount
    // column, so it's read directly here instead of widening it).
    const s = summarizeChainEvent(args);
    const record = args && typeof args === "object" && !Array.isArray(args) ? args : null;
    const amount = amountLabel(
      unwrapScalar((record as Record<string, unknown> | null)?.free_balance),
    );
    return s.from && amount ? `${addressLabel(s.from)} was endowed with ${amount}.` : null;
  },
  "TransactionPayment.TransactionFeePaid": amountOnlyEvent("paid a transaction fee of"),
  "System.ExtrinsicSuccess": () => "Extrinsic executed successfully.",
  "System.ExtrinsicFailed": () => "Extrinsic failed.",
  "System.NewAccount": () => "A new account was created.",
  "System.KilledAccount": () => "An account was removed.",
  // Real args: [[netuid], version_key] -- positional, no field names.
  "SubtensorModule.WeightsSet": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    return netuid ? `Weights were set for ${netuid}.` : null;
  },
  // Real args: [who, [mecid], commit_hash, reveal_round] -- mecid isn't a
  // netuid (confirmed too large for the netuid domain in live samples), so
  // this doesn't claim a subnet it can't actually name.
  "SubtensorModule.TimelockedWeightsCommitted": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const who = typeof a[0] === "string" ? (a[0] as string) : null;
    const round = fmtNumber(a[3]);
    if (!who || !round) return null;
    return `${addressLabel(who)} committed time-locked weights, revealing at round ${round}.`;
  },
  // Real args: [[netuid], who].
  "SubtensorModule.TimelockedWeightsRevealed": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    const who = typeof a[1] === "string" ? (a[1] as string) : null;
    if (!netuid || !who) return null;
    return `${addressLabel(who)} revealed time-locked weights for ${netuid}.`;
  },
  // Real args: [[netuid], uid, hotkey].
  "SubtensorModule.NeuronRegistered": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const netuid = positionalNetuid(a[0]);
    const hotkey = typeof a[2] === "string" ? (a[2] as string) : null;
    if (!netuid) return null;
    return hotkey
      ? `${addressLabel(hotkey)} registered a neuron on ${netuid}.`
      : `A neuron registered on ${netuid}.`;
  },
  // Real args: {coldkey} -- no netuid field on this event at all.
  "SubtensorModule.RootClaimed": (args) => {
    const s = summarizeChainEvent(args);
    return s.from ? `${addressLabel(s.from)} claimed root.` : null;
  },
  // Real args: [coldkey, hotkey, [amount], [amount2], [netuid], version] --
  // positional, both add/remove share this exact shape.
  "SubtensorModule.StakeRemoved": positionalStakeEvent("unstaked"),
  "SubtensorModule.StakeAdded": positionalStakeEvent("staked"),
  // Real args: {owner, hotkey, netuid, incentive, destination} -- "incentive"
  // isn't in summarizeChainEvent's shared AMOUNT_KEYS (see Balances.Endowed's
  // own note), so this reads it directly rather than widening that list.
  "SubtensorModule.AutoStakeAdded": (args) => {
    const record = args && typeof args === "object" && !Array.isArray(args) ? args : null;
    if (!record) return null;
    const r = record as Record<string, unknown>;
    const hotkey = typeof r.hotkey === "string" ? r.hotkey : null;
    const netuid = subnetLabel(unwrapScalar(r.netuid));
    const amount = amountLabel(unwrapScalar(r.incentive));
    if (!hotkey || !netuid || !amount) return null;
    return `${addressLabel(hotkey)} auto-staked ${amount} on ${netuid}.`;
  },
  // StakeMoved/StakeSwapped carry origin AND destination netuids in a
  // positional shape distinct from StakeRemoved/Added's -- no template
  // registered rather than guessing which position means what; raw
  // rendering stays correct for these two.
  // Real args: [from_coldkey, to_coldkey, hotkey, [netuid], [dest_netuid], [amount]].
  "SubtensorModule.StakeTransferred": (args) => {
    const a = asPositionalArgs(args);
    if (!a) return null;
    const from = typeof a[0] === "string" ? (a[0] as string) : null;
    const to = typeof a[1] === "string" ? (a[1] as string) : null;
    const netuid = positionalNetuid(a[3]);
    const amount = amountLabel(unwrapScalar(a[5]));
    if (!from || !netuid || !amount) return null;
    return to
      ? `${addressLabel(from)} transferred ${amount} of stake to ${addressLabel(to)} on ${netuid}.`
      : `${addressLabel(from)} transferred ${amount} of stake on ${netuid}.`;
  },
  "SubtensorModule.IncentiveAlphaEmittedToMiners": netuidOnlyEvent(
    "Incentive alpha was emitted to miners on",
  ),
  "Drand.NewPulse": () => "A new randomness beacon pulse was recorded.",
  "Ethereum.Executed": () => "An EVM transaction was executed.",
  "Utility.ItemCompleted": () => "A batched call completed.",
  "Utility.BatchCompleted": () => "A batch of calls completed.",
  "MevShield.EncryptedSubmitted": () => "An encrypted MEV-shield bid was submitted.",
  "Commitments.Commitment": netuidOnlyEvent("A commitment was published for"),
  "Proxy.ProxyExecuted": () => "A proxied call was executed.",
};

/**
 * A one-line action sentence for a decoded chain event, or null when no
 * template covers this pallet.method.
 */
export function summarizeEvent(
  pallet: string | null | undefined,
  method: string | null | undefined,
  args: unknown,
): string | null {
  if (!pallet || !method) return null;
  const template = EVENT_TEMPLATES[`${pallet}.${method}`];
  if (!template) return null;
  try {
    return template(args);
  } catch {
    return null;
  }
}

/** Every `pallet.method` key this module can produce a sentence for -- used by the coverage script. */
export function summarizableCallKeys(): string[] {
  return Object.keys(CALL_TEMPLATES);
}

/** Every `pallet.method` key this module can produce a sentence for -- used by the coverage script. */
export function summarizableEventKeys(): string[] {
  return Object.keys(EVENT_TEMPLATES);
}
