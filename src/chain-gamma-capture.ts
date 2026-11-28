// The Gamma subsystem, the on-chain service registry and the TAO/USD oracle,
// captured from chain storage.
//
// Migrations 0047 and 0048 gave this state its tables and the serving tier its
// readers (REST, GraphQL, MCP) at runtime v490, and left the writers to an
// engine that never ran: every route answered 200 with `captured_at: null`
// while mainnet carried live deposits, prices and services. This lane fills
// them from the runtime's own storage, read at ONE finalized block so every row
// of a capture describes the same chain state.
//
// THE SHAPES ARE v497's, read from the runtime (opentensor/subtensor
// `pallets/subtensor/src/lib.rs`), not v490's that the tables were drawn for:
//
//   GammaEnabled                    bool
//   SubnetGammaEnabled              Identity(NetUid) -> bool
//   SubnetGammaPrice                Identity(NetUid) -> U64F64 (raw bits)
//   PendingGammaEmission            Identity(NetUid) -> AlphaBalance (u64)
//   SubnetGammaEmissionWhitelisted  Identity(NetUid) -> bool
//   UnconvertedGammaEmission        (Identity NetUid, Identity NetUid) -> u64
//   GammaDeposits                   (Identity NetUid, Blake2_128Concat hotkey)
//                                     -> { coldkey, balance: u64,
//                                          daily_spend_cap: Option<{ cap: u64,
//                                            bucket: (u64, u64) }> }
//   Services                        (Identity NetUid, Blake2_128Concat hotkey)
//                                     -> { url: Bytes }
//   TaoUsdPrice                     { accepted: u64, feed: u64, fed_at: u64 }
//   TaoUsdPriceOracle               AccountId
//   MechanismCountCurrent           Twox64Concat(NetUid) -> MechId (u8),
//                                     default 1
//   MechanismEmissionSplit          Twox64Concat(NetUid) -> Option<Vec<u16>>,
//                                     parts of u16::MAX, one per mechanism
//   SubnetEpochConsensus            Identity(NetUid) -> EpochConsensus,
//                                     default Yuma
//
// A mechanism's share is the runtime's own (`split_emissions`): the stored
// split when it names one part per mechanism, otherwise an even split. Its
// consensus is the subnet's epoch consensus, which every mechanism runs.
//
// Every per-subnet item and GammaEnabled is a ValueQuery: a key the block does
// not hold reads as the runtime's default (false, or zero), which is a value
// like any other and is captured as one. NULL is left for what does not
// decode, never for what the chain simply defaults. The subnets are the ones
// SubnetState lists, the same set the emission capture reads.
//
// Where v497 moved a shape the v490 column cannot hold, the column is left
// NULL rather than filled with something else under its name:
// `SubnetGammaEmission` is now a list of (target, share) pairs, so
// `subnet_gamma.emission` stays NULL until a column carries the shares;
// `UnconvertedGammaEmission` is now per target, so the column carries the
// subnet's total across its targets; a deposit has no spender any more, so
// `spender` is NULL.

import { chainRpc } from "./chain-rpc.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  rpcUrlForNetwork,
} from "./chain-network.ts";
import {
  bytesToHex,
  storageMapPrefix,
  twox64ConcatU16StorageKey,
} from "./twox-storage-key.ts";
import { decodeEpochConsensus } from "./subnet-emission-capture.ts";
import { encodeAccountId32 } from "./ss58.ts";
import {
  decode,
  decoded,
  enumerate,
  finalizedAt,
  hexBytes,
  netuidAt,
  netuidSuffix,
  RPC_TIMEOUT_MS,
  type Rpc,
  storageAt,
  subnetNetuids,
} from "./chain-storage-read.ts";

/** The tables one capture writes, in one transaction. */
export const CHAIN_GAMMA_CAPTURE_TABLES = Object.freeze([
  "chain_gamma",
  "subnet_gamma",
  "gamma_deposits",
  "subnet_services",
  "subnet_mechanisms",
  "tao_usd_oracle",
] as const);

/** How much of the per-subnet series is kept: the history route caps a read
 * at 1,024 rows a subnet, and a 15-minute capture fills that in ten days. */
export const SUBNET_GAMMA_RETENTION_MS = 30 * 86_400_000;
/** One bounded sweep per tick, like every capture lane's retention. */
export const SUBNET_GAMMA_PRUNE_MAX_ROWS = 5_000;

/** TaoUsdPrice is in gamma units per TAO, and gamma is 10^9 units a dollar. */
const GAMMA_UNITS_PER_USD = 1e9;

const prefix = (item: string) =>
  bytesToHex(storageMapPrefix("SubtensorModule", item));
const KEY = Object.freeze({
  enabled: prefix("GammaEnabled"),
  subnetEnabled: prefix("SubnetGammaEnabled"),
  price: prefix("SubnetGammaPrice"),
  pending: prefix("PendingGammaEmission"),
  whitelisted: prefix("SubnetGammaEmissionWhitelisted"),
  unconverted: prefix("UnconvertedGammaEmission"),
  deposits: prefix("GammaDeposits"),
  services: prefix("Services"),
  taoUsd: prefix("TaoUsdPrice"),
  oracle: prefix("TaoUsdPriceOracle"),
  consensus: prefix("SubnetEpochConsensus"),
});
const mechanismKey = (item: string, netuid: number) =>
  twox64ConcatU16StorageKey("SubtensorModule", item, netuid);
/** u16::MAX: a whole subnet's emission in mechanism split parts. */
const SPLIT_PARTS_ONE = 65_535;

export const decodeBool = (hex: string) => decode(hex, (s) => s.bool());
export const decodeU64 = (hex: string) =>
  decode(hex, (s) => s.uint(8)).toString();
export const decodeU128 = (hex: string) =>
  decode(hex, (s) => s.uint(16)).toString();
export const decodeAccount = (hex: string) => decode(hex, (s) => s.account());
/** A MechId: one byte. */
export const decodeMechanismCount = (hex: string) =>
  decode(hex, (s) => Number(s.uint(1)));
/** A mechanism split: one u16 part of u16::MAX per mechanism. */
export const decodeMechanismSplit = (hex: string) =>
  decode(hex, (s) =>
    Array.from({ length: s.length(256) }, () => Number(s.uint(2))),
  );

/** Each mechanism's share of its subnet's emission, as the runtime splits it:
 * the stored split when it has one part per mechanism, else an even split. */
export function mechanismShares(
  count: number,
  split: readonly number[] | null,
): number[] {
  if (split !== null && split.length === count)
    return split.map((part) => part / SPLIT_PARTS_ONE);
  return Array.from({ length: count }, () => 1 / count);
}

/** A service's URL, which the chain stores as raw bytes: refused unless it is
 * UTF-8 text, because a route serves it as a link. */
export function decodeServiceUrl(hex: string): string {
  const bytes = decode(hex, (s) => s.bytes());
  // Invalid UTF-8 decodes to U+FFFD, which no URL the chain stores contains.
  const url = new TextDecoder().decode(bytes);
  if (
    !url ||
    url.includes("\uFFFD") ||
    [...url].some((char) => char.charCodeAt(0) < 0x20)
  )
    throw new TypeError("service URL is not printable text");
  return url;
}

export interface GammaDepositValue {
  coldkey: string;
  balance: string;
  /** The deposit's daily cap, or null for no cap. */
  dailyCap: string | null;
}

export function decodeGammaDeposit(hex: string): GammaDepositValue {
  return decode(hex, (s) => {
    const coldkey = s.account();
    const balance = s.uint(8).toString();
    const dailyCap = s.option(() => {
      const cap = s.uint(8).toString();
      s.uint(8); // bucket: what the cap allows,
      s.uint(8); // and the block it was reckoned at
      return cap;
    });
    return { coldkey, balance, dailyCap };
  });
}

export interface TaoUsdPriceValue {
  accepted: string;
  feed: string;
  fedAt: number;
}

export function decodeTaoUsdPrice(hex: string): TaoUsdPriceValue {
  return decode(hex, (s) => ({
    accepted: s.uint(8).toString(),
    feed: s.uint(8).toString(),
    fedAt: Number(s.uint(8)),
  }));
}

/** The (netuid, account) of a (Identity NetUid, Blake2_128Concat AccountId)
 * key: the netuid follows the prefix, the account is the key's last 32 bytes. */
export function netuidAccountFromKey(
  key: string,
  itemPrefix: string,
): { netuid: number; account: string } | null {
  if (!key.startsWith(itemPrefix)) return null;
  const rest = key.slice(itemPrefix.length);
  if (!/^[0-9a-fA-F]{100}$/.test(rest)) return null;
  // The tail is 64 hex digits, so the account always encodes (see account()).
  return {
    netuid: netuidAt(rest, 0),
    account: encodeAccountId32(hexBytes("0x" + rest.slice(36)))!,
  };
}

export interface ChainGammaSnapshot {
  block: number;
  enabled: boolean | null;
  subnets: {
    netuid: number;
    enabled: boolean | null;
    price: string | null;
    pending: string | null;
    unconverted: string | null;
    whitelisted: boolean | null;
  }[];
  /** null when the map could not be read whole: a partial listing must not
   * delete or close what it simply did not reach. */
  services: { netuid: number; hotkey: string; url: string }[] | null;
  /** Every listed subnet's mechanisms, or null when one did not decode, so a
   * capture never deletes the rows of a subnet it could not read. */
  mechanisms:
    | {
        netuid: number;
        mechid: number;
        share: number;
        consensus: string | null;
      }[]
    | null;
  deposits:
    | {
        netuid: number;
        hotkey: string;
        coldkey: string;
        balance: string;
        dailyCap: string | null;
      }[]
    | null;
  oracle: {
    accepted: string;
    feed: string;
    fedAt: number;
    oracle: string | null;
  } | null;
  /** Values that did not decode, counted rather than guessed at. */
  undecoded: number;
}

/** One finalized block's Gamma, service and oracle state. Throws on an RPC
 * failure; the capture turns that into a reason. */
export async function loadChainGammaSnapshot(
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  rpc: Rpc = (method, params) =>
    chainRpc(rpcUrlForNetwork(network), method, params, {
      timeoutMs: RPC_TIMEOUT_MS,
    }),
): Promise<ChainGammaSnapshot> {
  const { at, block } = await finalizedAt(rpc);
  const miss = { undecoded: 0 };

  const singles = await storageAt(
    rpc,
    [KEY.enabled, KEY.taoUsd, KEY.oracle],
    at,
  );
  const netuids = await subnetNetuids(rpc, at);
  const maps = [
    KEY.subnetEnabled,
    KEY.price,
    KEY.pending,
    KEY.whitelisted,
  ] as const;
  const perNetuid = await storageAt(
    rpc,
    [
      ...maps.flatMap((item) => netuids.map((n) => item + netuidSuffix(n))),
      ...netuids.map((n) => KEY.consensus + netuidSuffix(n)),
      ...netuids.flatMap((n) => [
        mechanismKey("MechanismCountCurrent", n),
        mechanismKey("MechanismEmissionSplit", n),
      ]),
    ],
    at,
  );

  const [unconvertedKeys, depositKeys, serviceKeys] = await Promise.all([
    enumerate(rpc, KEY.unconverted, at),
    enumerate(rpc, KEY.deposits, at),
    enumerate(rpc, KEY.services, at),
  ]);
  const listed = await storageAt(
    rpc,
    [
      ...(unconvertedKeys ?? []),
      ...(depositKeys ?? []),
      ...(serviceKeys ?? []),
    ],
    at,
  );

  // The subnet's unconverted total across its targets.
  const unconverted = new Map<number, bigint>();
  for (const key of unconvertedKeys ?? []) {
    const value = decoded(listed.get(key), decodeU64, miss);
    if (value === null) continue;
    const netuid = netuidAt(key, KEY.unconverted.length);
    unconverted.set(netuid, (unconverted.get(netuid) ?? 0n) + BigInt(value));
  }

  const subnets = netuids.map((netuid) => {
    const held = <T>(item: string, read: (hex: string) => T, fallback: T) =>
      valueQuery(
        perNetuid.get(item + netuidSuffix(netuid)),
        read,
        fallback,
        miss,
      );
    return {
      netuid,
      enabled: held(KEY.subnetEnabled, decodeBool, false),
      price: held(KEY.price, decodeU128, "0"),
      pending: held(KEY.pending, decodeU64, "0"),
      unconverted:
        unconvertedKeys === null
          ? null
          : (unconverted.get(netuid) ?? 0n).toString(),
      whitelisted: held(KEY.whitelisted, decodeBool, false),
    };
  });

  const mechanisms = mechanismsOf(netuids, perNetuid, miss);

  const pairs = <T>(
    keys: string[] | null,
    itemPrefix: string,
    read: (hex: string) => T,
  ) => {
    if (keys === null) return null;
    const out: { netuid: number; account: string; value: T }[] = [];
    for (const key of keys) {
      const id = netuidAccountFromKey(key, itemPrefix);
      const raw = listed.get(key);
      // A key this module cannot parse, or a value gone between the listing
      // and the read, is one undecoded entry; a value that does not decode is
      // counted where it is read.
      if (!id || raw === undefined) {
        miss.undecoded += 1;
        continue;
      }
      const value = decoded(raw, read, miss);
      if (value !== null) out.push({ ...id, value });
    }
    return out;
  };
  const services =
    pairs(serviceKeys, KEY.services, decodeServiceUrl)?.map((s) => ({
      netuid: s.netuid,
      hotkey: s.account,
      url: s.value,
    })) ?? null;
  const deposits =
    pairs(depositKeys, KEY.deposits, decodeGammaDeposit)?.map((d) => ({
      netuid: d.netuid,
      hotkey: d.account,
      ...d.value,
    })) ?? null;

  const price = decoded(singles.get(KEY.taoUsd), decodeTaoUsdPrice, miss);
  return {
    block,
    enabled: valueQuery(singles.get(KEY.enabled), decodeBool, false, miss),
    subnets,
    services,
    mechanisms,
    deposits,
    oracle: price
      ? {
          ...price,
          oracle: decoded(singles.get(KEY.oracle), decodeAccount, miss),
        }
      : null,
    undecoded: miss.undecoded,
  };
}

/** Each listed subnet's mechanisms from one block's reads, or null when any
 * value did not decode (counted). */
function mechanismsOf(
  netuids: readonly number[],
  values: Map<string, string>,
  miss: { undecoded: number },
): ChainGammaSnapshot["mechanisms"] {
  const out: NonNullable<ChainGammaSnapshot["mechanisms"]> = [];
  const before = miss.undecoded;
  for (const netuid of netuids) {
    const count = valueQuery(
      values.get(mechanismKey("MechanismCountCurrent", netuid).toLowerCase()),
      decodeMechanismCount,
      1,
      miss,
    );
    const splitHex = values.get(
      mechanismKey("MechanismEmissionSplit", netuid).toLowerCase(),
    );
    const split =
      splitHex === undefined
        ? null
        : decoded(splitHex, decodeMechanismSplit, miss);
    const consensus = valueQuery(
      values.get(KEY.consensus + netuidSuffix(netuid)),
      decodeEpochConsensus,
      "yuma",
      miss,
    );
    if (count === null || count < 1 || (splitHex !== undefined && !split)) {
      if (count !== null && count < 1) miss.undecoded += 1;
      continue;
    }
    mechanismShares(count, split).forEach((share, mechid) =>
      out.push({ netuid, mechid, share, consensus }),
    );
  }
  return miss.undecoded === before ? out : null;
}

/** A ValueQuery's value: the runtime's default when the block holds no key,
 * the decoded value otherwise, and null (counted) when it does not decode. */
function valueQuery<T>(
  value: string | undefined,
  read: (hex: string) => T,
  fallback: T,
  miss: { undecoded: number },
): T | null {
  return value === undefined ? fallback : decoded(value, read, miss);
}

/** The statements one capture writes, in order, for one transaction. Pure. */
export function chainGammaStatements(
  snapshot: ChainGammaSnapshot,
  capturedAt: number,
): { text: string; values: unknown[] }[] {
  const out: { text: string; values: unknown[] }[] = [];
  if (snapshot.enabled !== null)
    out.push({
      text: "INSERT INTO chain_gamma (enabled, captured_at) VALUES (?, ?) ON CONFLICT (captured_at) DO NOTHING",
      values: [snapshot.enabled, capturedAt],
    });
  for (const s of snapshot.subnets)
    out.push({
      text:
        "INSERT INTO subnet_gamma (netuid, enabled, price, emission, pending_emission, " +
        "unconverted_emission, whitelisted, captured_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?) " +
        "ON CONFLICT (netuid, captured_at) DO NOTHING",
      values: [
        s.netuid,
        s.enabled,
        s.price,
        s.pending,
        s.unconverted,
        s.whitelisted,
        capturedAt,
      ],
    });
  if (snapshot.services !== null) {
    for (const s of snapshot.services)
      out.push({
        text:
          "INSERT INTO subnet_services (netuid, hotkey, service_url, set_at, captured_at) " +
          "VALUES (?, ?, ?, NULL, ?) ON CONFLICT (netuid, hotkey) DO UPDATE SET " +
          "service_url = EXCLUDED.service_url, captured_at = EXCLUDED.captured_at",
        values: [s.netuid, s.hotkey, s.url, capturedAt],
      });
    // A whole listing proves what is gone: a removed service deletes its row.
    out.push({
      text: "DELETE FROM subnet_services WHERE captured_at < ?",
      values: [capturedAt],
    });
  }
  if (snapshot.mechanisms !== null) {
    for (const m of snapshot.mechanisms)
      out.push({
        text:
          "INSERT INTO subnet_mechanisms (netuid, mechid, emission_split, consensus_mode, " +
          "captured_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (netuid, mechid) DO UPDATE SET " +
          "emission_split = EXCLUDED.emission_split, consensus_mode = EXCLUDED.consensus_mode, " +
          "captured_at = EXCLUDED.captured_at",
        values: [m.netuid, m.mechid, m.share, m.consensus, capturedAt],
      });
    // Every listed subnet was read: a mechanism or subnet gone deletes its row.
    out.push({
      text: "DELETE FROM subnet_mechanisms WHERE captured_at < ?",
      values: [capturedAt],
    });
  }
  if (snapshot.deposits !== null) {
    for (const d of snapshot.deposits)
      out.push({
        text:
          "INSERT INTO gamma_deposits (coldkey, hotkey, netuid, balance, spender, daily_cap, " +
          "closed_at, captured_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?) " +
          "ON CONFLICT (coldkey, hotkey, netuid) DO UPDATE SET balance = EXCLUDED.balance, " +
          "daily_cap = EXCLUDED.daily_cap, closed_at = NULL, captured_at = EXCLUDED.captured_at",
        values: [
          d.coldkey,
          d.hotkey,
          d.netuid,
          d.balance,
          d.dailyCap,
          capturedAt,
        ],
      });
    // A deposit a whole listing no longer holds was closed by this block.
    out.push({
      text: "UPDATE gamma_deposits SET closed_at = ? WHERE closed_at IS NULL AND captured_at < ?",
      values: [snapshot.block, capturedAt],
    });
  }
  if (snapshot.oracle !== null) {
    const usd = Number(snapshot.oracle.accepted) / GAMMA_UNITS_PER_USD;
    out.push({
      text:
        "INSERT INTO tao_usd_oracle (block_number, usd_per_tao, price_raw, oracle, observed_at, " +
        "captured_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (block_number) DO NOTHING",
      values: [
        snapshot.oracle.fedAt,
        usd > 0 ? usd : null,
        snapshot.oracle.accepted,
        snapshot.oracle.oracle,
        capturedAt,
        capturedAt,
      ],
    });
  }
  return out;
}

/** The minimal producer-store surface (src/producer-store.ts), structural so
 * tests inject a plain object. */
export interface ChainGammaDb {
  run?(text: string, values?: unknown[]): Promise<{ changes: number }>;
  transaction?(
    statements: readonly { text: string; values?: unknown[] }[],
  ): Promise<{ changes: number }[]>;
}

/**
 * Persist one capture, and keep the series bounded. Never throws: a capture
 * that could take down the cron it rides would be worse than a gap. Returns
 * what happened for the lane's verdict.
 */
export async function captureChainGamma(
  _env: unknown,
  {
    db,
    now = Date.now,
    network,
    load = loadChainGammaSnapshot,
  }: {
    db?: ChainGammaDb | null;
    now?: () => number;
    network?: ChainNetworkId;
    load?: typeof loadChainGammaSnapshot;
  } = {},
): Promise<{
  ok: boolean;
  captured: number;
  undecoded: number;
  reason?: string;
}> {
  if (!db?.transaction || !db?.run)
    return { ok: false, captured: 0, undecoded: 0, reason: "no_store_binding" };
  let snapshot: ChainGammaSnapshot;
  try {
    snapshot = await load(network);
  } catch (error) {
    return {
      ok: false,
      captured: 0,
      undecoded: 0,
      reason: `chain_read_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  const capturedAt = now();
  let captured: number;
  try {
    const results = await db.transaction(
      chainGammaStatements(snapshot, capturedAt),
    );
    captured = results.reduce((sum, r) => sum + r.changes, 0);
  } catch (error) {
    return {
      ok: false,
      captured: 0,
      undecoded: snapshot.undecoded,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  try {
    await db.run(
      `DELETE FROM subnet_gamma WHERE (netuid, captured_at) IN (
        SELECT netuid, captured_at FROM subnet_gamma
        WHERE captured_at < ? ORDER BY captured_at LIMIT ?)`,
      [capturedAt - SUBNET_GAMMA_RETENTION_MS, SUBNET_GAMMA_PRUNE_MAX_ROWS],
    );
  } catch {
    // Retention is housekeeping; the capture is what matters.
  }
  return {
    ok: snapshot.undecoded === 0,
    captured,
    undecoded: snapshot.undecoded,
    ...(snapshot.undecoded === 0
      ? {}
      : { reason: `undecoded: ${snapshot.undecoded}` }),
  };
}
