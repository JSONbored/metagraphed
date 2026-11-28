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
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";
import { encodeAccountId32 } from "./ss58.ts";

/** The tables one capture writes, in one transaction. */
export const CHAIN_GAMMA_CAPTURE_TABLES = Object.freeze([
  "chain_gamma",
  "subnet_gamma",
  "gamma_deposits",
  "subnet_services",
  "tao_usd_oracle",
] as const);

/** How much of the per-subnet series is kept: the history route caps a read
 * at 1,024 rows a subnet, and a 15-minute capture fills that in ten days. */
export const SUBNET_GAMMA_RETENTION_MS = 30 * 86_400_000;
/** One bounded sweep per tick, like every capture lane's retention. */
export const SUBNET_GAMMA_PRUNE_MAX_ROWS = 5_000;

const RPC_TIMEOUT_MS = 15_000;
const KEYS_PER_PAGE = 1_000;
/** An enumerated map larger than this is read as incomplete, never truncated
 * silently: 20,000 deposits or services is far past mainnet's hundreds. */
const MAX_PAGES = 20;
const VALUES_PER_CALL = 500;
const MAX_NETUIDS = 1_024;
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
  totalNetworks: prefix("TotalNetworks"),
});

function hexBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex))
    throw new TypeError("storage value is not hex");
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}

/** A SCALE reader over one storage value: every read is bounds-checked, and a
 * value with bytes left over is refused, so a runtime that moved a shape is
 * read as unknown rather than as a wrong number. */
class Scale {
  private offset = 0;
  constructor(private readonly buffer: Uint8Array) {}
  private take(n: number): Uint8Array {
    if (this.offset + n > this.buffer.length)
      throw new RangeError("SCALE value is truncated");
    const out = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  bool(): boolean {
    const [byte] = this.take(1);
    if (byte > 1) throw new RangeError("SCALE bool is out of range");
    return byte === 1;
  }
  uint(width: number): bigint {
    const bytes = this.take(width);
    let value = 0n;
    for (let i = width - 1; i >= 0; i -= 1)
      value = (value << 8n) | BigInt(bytes[i]);
    return value;
  }
  compact(): bigint {
    const [first] = this.take(1);
    switch (first & 3) {
      case 0:
        return BigInt(first >> 2);
      case 1:
        return (BigInt(first) | (this.uint(1) << 8n)) >> 2n;
      case 2:
        return (BigInt(first) | (this.uint(3) << 8n)) >> 2n;
      default:
        return this.uint((first >> 2) + 4);
    }
  }
  bytes(): Uint8Array {
    const length = this.compact();
    if (length > 65_536n) throw new RangeError("SCALE bytes are too long");
    return this.take(Number(length));
  }
  account(): string {
    const address = encodeAccountId32(this.take(32));
    if (!address) throw new TypeError("account is not encodable");
    return address;
  }
  option<T>(read: () => T): T | null {
    const [tag] = this.take(1);
    if (tag === 0) return null;
    if (tag === 1) return read();
    throw new RangeError("SCALE option tag is out of range");
  }
  done(): void {
    if (this.offset !== this.buffer.length)
      throw new RangeError("SCALE value has trailing bytes");
  }
}

function decode<T>(hex: string, read: (scale: Scale) => T): T {
  const scale = new Scale(hexBytes(hex));
  const value = read(scale);
  scale.done();
  return value;
}

export const decodeBool = (hex: string) => decode(hex, (s) => s.bool());
export const decodeU64 = (hex: string) =>
  decode(hex, (s) => s.uint(8)).toString();
export const decodeU128 = (hex: string) =>
  decode(hex, (s) => s.uint(16)).toString();
export const decodeAccount = (hex: string) => decode(hex, (s) => s.account());

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

/** netuid as the 2-byte little-endian Identity key suffix. */
function netuidSuffix(netuid: number): string {
  return (
    (netuid & 0xff).toString(16).padStart(2, "0") +
    (netuid >> 8).toString(16).padStart(2, "0")
  );
}

function netuidAt(hex: string, at: number): number {
  return (
    parseInt(hex.slice(at, at + 2), 16) +
    parseInt(hex.slice(at + 2, at + 4), 16) * 256
  );
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
  const account = encodeAccountId32(hexBytes("0x" + rest.slice(36)));
  return account ? { netuid: netuidAt(rest, 0), account } : null;
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

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

async function storageAt(
  rpc: Rpc,
  keys: readonly string[],
  at: string,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (let i = 0; i < keys.length; i += VALUES_PER_CALL) {
    const result = await rpc("state_queryStorageAt", [
      keys.slice(i, i + VALUES_PER_CALL),
      at,
    ]);
    const changes = Array.isArray(result)
      ? (result[0] as { changes?: unknown } | undefined)?.changes
      : null;
    if (!Array.isArray(changes))
      throw new Error("state_queryStorageAt answered no changes");
    for (const change of changes) {
      if (
        Array.isArray(change) &&
        typeof change[0] === "string" &&
        typeof change[1] === "string"
      )
        values.set(change[0].toLowerCase(), change[1]);
    }
  }
  return values;
}

/** Every key of one map at `at`, or null when it is larger than the bound. */
async function enumerate(
  rpc: Rpc,
  itemPrefix: string,
  at: string,
): Promise<string[] | null> {
  const keys: string[] = [];
  let start = itemPrefix;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await rpc("state_getKeysPaged", [
      itemPrefix,
      KEYS_PER_PAGE,
      start,
      at,
    ]);
    if (!Array.isArray(result) || !result.every((k) => typeof k === "string"))
      throw new Error("state_getKeysPaged answered no keys");
    keys.push(...(result as string[]).map((k) => k.toLowerCase()));
    if (result.length < KEYS_PER_PAGE) return keys;
    start = result[result.length - 1] as string;
  }
  return null;
}

function decoded<T>(
  value: string | undefined,
  read: (hex: string) => T,
  miss: { undecoded: number },
): T | null {
  if (value === undefined) return null;
  try {
    return read(value);
  } catch {
    miss.undecoded += 1;
    return null;
  }
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
  const at = await rpc("chain_getFinalizedHead", []);
  if (typeof at !== "string") throw new Error("no finalized head");
  const header = (await rpc("chain_getHeader", [at])) as {
    number?: unknown;
  } | null;
  const block =
    typeof header?.number === "string" ? parseInt(header.number, 16) : NaN;
  if (!Number.isSafeInteger(block) || block < 0)
    throw new Error("finalized header has no number");
  const miss = { undecoded: 0 };

  const singles = await storageAt(
    rpc,
    [KEY.enabled, KEY.taoUsd, KEY.oracle, KEY.totalNetworks],
    at,
  );
  const total = Number(
    decoded(singles.get(KEY.totalNetworks), decodeU16, miss) ?? 0,
  );
  const netuids = Array.from(
    { length: Math.min(total, MAX_NETUIDS) },
    (_, n) => n,
  );
  const maps = [
    KEY.subnetEnabled,
    KEY.price,
    KEY.pending,
    KEY.whitelisted,
  ] as const;
  const perNetuid = await storageAt(
    rpc,
    maps.flatMap((item) => netuids.map((n) => item + netuidSuffix(n))),
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

  const subnets = netuids
    .map((netuid) => {
      const valueOf = (item: string) =>
        perNetuid.get(item + netuidSuffix(netuid));
      return {
        netuid,
        enabled: decoded(valueOf(KEY.subnetEnabled), decodeBool, miss),
        price: decoded(valueOf(KEY.price), decodeU128, miss),
        pending: decoded(valueOf(KEY.pending), decodeU64, miss),
        unconverted:
          unconvertedKeys === null
            ? null
            : (unconverted.get(netuid) ?? 0n).toString(),
        whitelisted: decoded(valueOf(KEY.whitelisted), decodeBool, miss),
      };
    })
    // A subnet no Gamma state names is not a row: absence of every value is
    // the chain's default, which the newest capture of a gamma subnet shows.
    .filter(
      (row) =>
        row.enabled !== null ||
        row.price !== null ||
        row.pending !== null ||
        row.whitelisted !== null ||
        (row.unconverted !== null && row.unconverted !== "0"),
    );

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
    enabled: decoded(singles.get(KEY.enabled), decodeBool, miss),
    subnets,
    services,
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

function decodeU16(hex: string): number {
  return Number(decode(hex, (s) => s.uint(2)));
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
