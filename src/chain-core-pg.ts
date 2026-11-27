import { decodeSs58 } from "./ss58.ts";
import type { ChainDetailSyncRows } from "./chain-detail-sync-payload.ts";

/**
 * The chain core's writer (ADR 0029, phase 1; migration 0057).
 *
 * One chain-detail batch becomes typed rows in one transaction: accounts are
 * resolved to their surrogate id, calls and event kinds to their dimension
 * id, hashes to bytes and TAO and alpha amounts to integer rao. A re-sent
 * block changes nothing, and a block whose hash disagrees with the one
 * already held refuses the whole batch -- only finalized blocks are written,
 * so a disagreement is a defect, never a reorg to repair.
 *
 * Every value crosses as text and is cast in SQL. Rao amounts exceed
 * JavaScript's safe integers (21M TAO is 2.1e16 rao), and hex text decodes to
 * bytea the same way on every driver.
 */

type Row = Record<string, unknown>;

export interface ChainCoreTransaction {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
}

export interface ChainCoreDatabase {
  transaction<T>(
    callback: (tx: ChainCoreTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ChainCoreWriteOutcome {
  blocks: number;
  extrinsics: number;
  events: number;
  accountEvents: number;
  accounts: number;
  coverage: { from: number; through: number } | null;
}

/** The four families of one chain-detail batch. */
export type ChainCoreRows = Pick<
  ChainDetailSyncRows,
  "blockRows" | "extrinsicRows" | "chainEventRows" | "accountEventRows"
>;

export interface ChainCoreStore {
  write(network: string, rows: ChainCoreRows): Promise<ChainCoreWriteOutcome>;
}

/** The families a batch writes together; their coverage moves together. */
export const CHAIN_CORE_FAMILIES = Object.freeze([
  "blocks",
  "extrinsics",
  "events",
  "account_events",
] as const);

const PHASES: Readonly<Record<string, number>> = Object.freeze({
  Initialization: 0,
  ApplyExtrinsic: 1,
  Finalization: 2,
});

/** A pallet-derived account's fee and emission bookkeeping is not indexed. */
const PALLET_BOOKKEEPING = new Set(["Deposit", "Withdraw"]);
const PALLET_PREFIX = [0x6d, 0x6f, 0x64, 0x6c]; // "modl"

const RAO_DECIMAL = /^(-?)(\d+)(?:\.(\d{1,9}))?$/;

/** An exact decimal TAO (or alpha) string as integer rao text; null stays null. */
export function decimalToRao(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError("amount must be a string");
  const match = RAO_DECIMAL.exec(value);
  if (!match) throw new RangeError(`amount is not exact to the rao: ${value}`);
  const [, sign, whole, fraction = ""] = match;
  const rao = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  return (sign && rao !== 0n ? -rao : rao).toString();
}

function hexBytes(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError("hash must be 0x + 64 hex");
  return value.slice(2).toLowerCase();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The block's own time, from its Timestamp.set inherent, as epoch ms text. */
export function producedAtMs(extrinsics: readonly Row[]): string | null {
  const inherent = extrinsics.find(
    (row) => row.call_module === "Timestamp" && row.call_function === "set",
  );
  if (!inherent || typeof inherent.call_args !== "string") return null;
  let args: unknown;
  try {
    args = JSON.parse(inherent.call_args);
  } catch {
    return null;
  }
  if (!Array.isArray(args)) return null;
  const now = args.find(
    (arg) => arg && typeof arg === "object" && (arg as Row).name === "now",
  ) as Row | undefined;
  const value = now?.value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) return value;
  return null;
}

interface Contiguous {
  from: number;
  through: number;
}

/**
 * Merge a batch's blocks into a family's coverage: a run that touches the
 * record extends it on either side, a run past a gap replaces it (the record
 * is the newest complete range, so it never claims across a gap), and an
 * older disconnected run leaves it alone.
 */
export function mergeCoverage(
  existing: Contiguous | null,
  blocks: readonly number[],
): Contiguous | null {
  const sorted = [...new Set(blocks)].sort((a, b) => a - b);
  let record = existing ? { ...existing } : null;
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    index += 1;
    if (!record) record = { from: start, through: end };
    else if (start <= record.through + 1 && end >= record.from - 1)
      record = {
        from: Math.min(record.from, start),
        through: Math.max(record.through, end),
      };
    else if (start > record.through + 1) record = { from: start, through: end };
  }
  return record;
}

/** Account ss58 -> { hex public key, pallet } for every address a batch names. */
function resolveAddresses(rows: ChainCoreRows) {
  const addresses = new Map<string, { key: string; pallet: boolean }>();
  const add = (value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value !== "string") throw new TypeError("address must be text");
    if (addresses.has(value)) return;
    const decoded = decodeSs58(value);
    if (!decoded || decoded.publicKey.length !== 32)
      throw new TypeError(`not an SS58 account address: ${value}`);
    addresses.set(value, {
      key: hex(decoded.publicKey),
      pallet: PALLET_PREFIX.every((b, i) => decoded.publicKey[i] === b),
    });
  };
  for (const row of rows.extrinsicRows) add(row.signer);
  for (const row of rows.accountEventRows) {
    add(row.coldkey);
    add(row.hotkey);
  }
  return addresses;
}

function pairs(rows: readonly Row[], pallet: string, name: string) {
  const seen = new Map<string, [string, string]>();
  for (const row of rows) {
    const p = row[pallet];
    const n = row[name];
    if (typeof p === "string" && typeof n === "string")
      seen.set(`${p}.${n}`, [p, n]);
  }
  return [...seen.values()];
}

async function dimension(
  tx: ChainCoreTransaction,
  table: "calls" | "event_kinds",
  id: "call" | "kind",
  entries: readonly [string, string][],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  if (entries.length === 0) return ids;
  const pallets = entries.map(([p]) => p);
  const names = entries.map(([, n]) => n);
  await tx.query(
    // Only the missing ones: ON CONFLICT alone would draw an identity value
    // for every row it skips, and a smallint id would run out in hours.
    `INSERT INTO chain.${table} (pallet, name)
     SELECT p, n FROM unnest(?::text[], ?::text[]) AS t(p, n)
     WHERE NOT EXISTS (SELECT FROM chain.${table} d WHERE d.pallet = t.p AND d.name = t.n)
     ON CONFLICT (pallet, name) DO NOTHING`,
    [pallets, names],
  );
  const held = await tx.query<{ id: number; pallet: string; name: string }>(
    `SELECT d.${id} AS id, d.pallet, d.name FROM chain.${table} d
     JOIN unnest(?::text[], ?::text[]) AS t(p, n) ON d.pallet = t.p AND d.name = t.n`,
    [pallets, names],
  );
  for (const row of held) ids.set(`${row.pallet}.${row.name}`, Number(row.id));
  return ids;
}

function required<T>(map: Map<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`unresolved ${what}: ${key}`);
  return value;
}

/** Write one batch. Throws on any refusal, leaving nothing written. */
export async function writeChainCoreBatch(
  tx: ChainCoreTransaction,
  network: string,
  rows: ChainCoreRows,
): Promise<ChainCoreWriteOutcome> {
  const blocks = rows.blockRows;
  if (blocks.length === 0)
    return {
      blocks: 0,
      extrinsics: 0,
      events: 0,
      accountEvents: 0,
      accounts: 0,
      coverage: null,
    };
  const numbers = blocks.map((row) => Number(row.block_number));
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  await tx.query("SELECT chain.ensure_partitions(?, ?, ?)", [
    network,
    String(first),
    String(last),
  ]);

  // Accounts.
  const addresses = resolveAddresses(rows);
  const firstSeen = new Map<string, number>();
  const see = (value: unknown, block: unknown) => {
    if (typeof value !== "string") return;
    const at = Number(block);
    if (!firstSeen.has(value) || at < firstSeen.get(value)!)
      firstSeen.set(value, at);
  };
  for (const row of rows.extrinsicRows) see(row.signer, row.block_number);
  for (const row of rows.accountEventRows) {
    see(row.coldkey, row.block_number);
    see(row.hotkey, row.block_number);
  }
  const ss58 = [...addresses.keys()];
  const accounts = new Map<string, number>();
  if (ss58.length > 0) {
    await tx.query(
      `INSERT INTO chain.accounts (public_key, ss58, first_network_id, first_block)
       SELECT decode(k, 'hex'), s, ?, b FROM unnest(?::text[], ?::text[], ?::bigint[]) AS t(k, s, b)
       WHERE NOT EXISTS (SELECT FROM chain.accounts a WHERE a.ss58 = t.s)
       ON CONFLICT (public_key) DO NOTHING`,
      [
        network,
        ss58.map((s) => addresses.get(s)!.key),
        ss58,
        ss58.map((s) => String(firstSeen.get(s) ?? first)),
      ],
    );
    const held = await tx.query<{ account: string | number; ss58: string }>(
      "SELECT account, ss58 FROM chain.accounts WHERE ss58 = ANY(?::text[])",
      [ss58],
    );
    for (const row of held) accounts.set(row.ss58, Number(row.account));
  }
  const account = (value: unknown) =>
    typeof value === "string" ? required(accounts, value, "account") : null;

  // Dimensions.
  const calls = await dimension(
    tx,
    "calls",
    "call",
    pairs(rows.extrinsicRows, "call_module", "call_function"),
  );
  const kinds = await dimension(
    tx,
    "event_kinds",
    "kind",
    pairs(rows.chainEventRows, "pallet", "method"),
  );

  // Blocks, with the per-block facts the rows below total to.
  const extrinsicsByBlock = new Map<number, Row[]>();
  for (const row of rows.extrinsicRows) {
    const at = Number(row.block_number);
    extrinsicsByBlock.set(at, [...(extrinsicsByBlock.get(at) ?? []), row]);
  }
  const eventCount = new Map<number, number>();
  for (const row of rows.chainEventRows) {
    const at = Number(row.block_number);
    eventCount.set(at, (eventCount.get(at) ?? 0) + 1);
  }
  const total = (list: readonly Row[], key: string) =>
    list
      .reduce((sum, row) => sum + BigInt(decimalToRao(row[key]) ?? "0"), 0n)
      .toString();
  const blockHashes = blocks.map((row) => hexBytes(row.block_hash)!);
  await tx.query(
    `INSERT INTO chain.blocks (network_id, block_number, block_hash, spec_version, produced_at,
       extrinsic_count, event_count, fee_rao, tip_rao, observed_at)
     SELECT ?, n, decode(h, 'hex'), v, to_timestamp(p::numeric / 1000), x, e, f, tp, to_timestamp(o::numeric / 1000)
     FROM unnest(?::bigint[], ?::text[], ?::integer[], ?::bigint[], ?::integer[], ?::integer[],
       ?::bigint[], ?::bigint[], ?::bigint[]) AS t(n, h, v, p, x, e, f, tp, o)
     ON CONFLICT (network_id, block_number) DO NOTHING`,
    [
      network,
      numbers.map(String),
      blockHashes,
      blocks.map((row) => String(row.spec_version)),
      blocks.map((row) =>
        producedAtMs(extrinsicsByBlock.get(Number(row.block_number)) ?? []),
      ),
      blocks.map((row) =>
        String(extrinsicsByBlock.get(Number(row.block_number))?.length ?? 0),
      ),
      blocks.map((row) =>
        String(eventCount.get(Number(row.block_number)) ?? 0),
      ),
      blocks.map((row) =>
        total(extrinsicsByBlock.get(Number(row.block_number)) ?? [], "fee_tao"),
      ),
      blocks.map((row) =>
        total(extrinsicsByBlock.get(Number(row.block_number)) ?? [], "tip_tao"),
      ),
      blocks.map((row) => String(row.observed_at)),
    ],
  );
  const disagreeing = await tx.query<{ block_number: string | number }>(
    `SELECT b.block_number FROM chain.blocks b
     JOIN unnest(?::bigint[], ?::text[]) AS t(n, h) ON b.block_number = t.n
     WHERE b.network_id = ? AND b.block_hash <> decode(t.h, 'hex')`,
    [numbers.map(String), blockHashes, network],
  );
  if (disagreeing.length > 0)
    throw new Error(
      `block ${disagreeing[0].block_number} is already held with a different hash`,
    );

  // Extrinsics.
  const xt = rows.extrinsicRows;
  if (xt.length > 0)
    await tx.query(
      `INSERT INTO chain.extrinsics (network_id, block_number, extrinsic_index, extrinsic_hash, signer,
         call, success, fee_rao, tip_rao, args)
       SELECT ?, n, i, decode(h, 'hex'), s, c, ok, f, tp, a::jsonb
       FROM unnest(?::bigint[], ?::integer[], ?::text[], ?::bigint[], ?::smallint[], ?::boolean[],
         ?::bigint[], ?::bigint[], ?::text[]) AS t(n, i, h, s, c, ok, f, tp, a)
       ON CONFLICT DO NOTHING`,
      [
        network,
        xt.map((row) => String(row.block_number)),
        xt.map((row) => String(row.extrinsic_index)),
        xt.map((row) => hexBytes(row.extrinsic_hash)),
        xt.map((row) => {
          const id = account(row.signer);
          return id === null ? null : String(id);
        }),
        xt.map((row) =>
          typeof row.call_module === "string" &&
          typeof row.call_function === "string"
            ? String(
                required(
                  calls,
                  `${row.call_module}.${row.call_function}`,
                  "call",
                ),
              )
            : null,
        ),
        xt.map((row) =>
          row.success === null || row.success === undefined
            ? null
            : Boolean(row.success),
        ),
        xt.map((row) => decimalToRao(row.fee_tao)),
        xt.map((row) => decimalToRao(row.tip_tao)),
        xt.map((row) =>
          typeof row.call_args === "string" ? row.call_args : null,
        ),
      ],
    );

  // Events, and the kind each account event inherits from its own event.
  const ev = rows.chainEventRows;
  const eventKind = new Map<string, number>();
  for (const row of ev)
    eventKind.set(
      `${row.block_number}:${row.event_index}`,
      required(kinds, `${row.pallet}.${row.method}`, "event kind"),
    );
  if (ev.length > 0)
    await tx.query(
      `INSERT INTO chain.events (network_id, block_number, event_index, kind, phase, extrinsic_index, args)
       SELECT ?, n, i, k, ph, x, a::jsonb
       FROM unnest(?::bigint[], ?::integer[], ?::smallint[], ?::smallint[], ?::integer[], ?::text[])
         AS t(n, i, k, ph, x, a)
       ON CONFLICT DO NOTHING`,
      [
        network,
        ev.map((row) => String(row.block_number)),
        ev.map((row) => String(row.event_index)),
        ev.map((row) =>
          String(eventKind.get(`${row.block_number}:${row.event_index}`)),
        ),
        ev.map((row) => {
          const phase = PHASES[String(row.phase)];
          if (phase === undefined)
            throw new TypeError(`unknown phase: ${String(row.phase)}`);
          return String(phase);
        }),
        ev.map((row) =>
          row.extrinsic_index === null || row.extrinsic_index === undefined
            ? null
            : String(row.extrinsic_index),
        ),
        ev.map((row) => (typeof row.args === "string" ? row.args : null)),
      ],
    );

  // The account index, without pallet accounts' fee and emission bookkeeping.
  const indexed = rows.accountEventRows.filter((row) => {
    if (!PALLET_BOOKKEEPING.has(String(row.event_kind))) return true;
    const keys = [row.coldkey, row.hotkey].filter(
      (value): value is string => typeof value === "string",
    );
    return !keys.every((value) => addresses.get(value)?.pallet);
  });
  if (indexed.length > 0)
    await tx.query(
      `INSERT INTO chain.account_events (network_id, block_number, event_index, extrinsic_index, kind,
         coldkey, hotkey, netuid, uid, amount_rao, alpha_rao)
       SELECT ?, n, i, x, k, c, h, s, u, a, al
       FROM unnest(?::bigint[], ?::integer[], ?::integer[], ?::smallint[], ?::bigint[], ?::bigint[],
         ?::integer[], ?::integer[], ?::bigint[], ?::bigint[]) AS t(n, i, x, k, c, h, s, u, a, al)
       ON CONFLICT DO NOTHING`,
      [
        network,
        indexed.map((row) => String(row.block_number)),
        indexed.map((row) => String(row.event_index)),
        indexed.map((row) =>
          row.extrinsic_index === null || row.extrinsic_index === undefined
            ? null
            : String(row.extrinsic_index),
        ),
        indexed.map((row) =>
          String(
            required(
              eventKind,
              `${row.block_number}:${row.event_index}`,
              "account event's chain event",
            ),
          ),
        ),
        indexed.map((row) => {
          const id = account(row.coldkey);
          return id === null ? null : String(id);
        }),
        indexed.map((row) => {
          const id = account(row.hotkey);
          return id === null ? null : String(id);
        }),
        indexed.map((row) =>
          row.netuid === null || row.netuid === undefined
            ? null
            : String(row.netuid),
        ),
        indexed.map((row) =>
          row.uid === null || row.uid === undefined ? null : String(row.uid),
        ),
        indexed.map((row) => decimalToRao(row.amount_tao)),
        indexed.map((row) => decimalToRao(row.alpha_amount)),
      ],
    );

  // Coverage: the newest contiguous range each family holds completely.
  const held = await tx.query<{
    family: string;
    complete_from: string | number;
    complete_through: string | number;
  }>(
    `SELECT family, complete_from, complete_through FROM chain.coverage
     WHERE network_id = ? FOR UPDATE`,
    [network],
  );
  const existing = new Map(
    held.map((row) => [
      row.family,
      {
        from: Number(row.complete_from),
        through: Number(row.complete_through),
      },
    ]),
  );
  let coverage: Contiguous | null = null;
  for (const family of CHAIN_CORE_FAMILIES) {
    const merged = mergeCoverage(existing.get(family) ?? null, numbers);
    if (!merged) continue;
    if (family === "blocks") coverage = merged;
    await tx.query(
      `INSERT INTO chain.coverage (network_id, family, complete_from, complete_through)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (network_id, family) DO UPDATE
       SET complete_from = excluded.complete_from, complete_through = excluded.complete_through,
         updated_at = transaction_timestamp()`,
      [network, family, String(merged.from), String(merged.through)],
    );
  }

  return {
    blocks: blocks.length,
    extrinsics: xt.length,
    events: ev.length,
    accountEvents: indexed.length,
    accounts: ss58.length,
    coverage,
  };
}

/** The chain core over a database with transactions (the chain source). */
export function createPgChainCore(database: ChainCoreDatabase): ChainCoreStore {
  return Object.freeze({
    write: (network: string, rows: ChainCoreRows) =>
      database.transaction((tx) => writeChainCoreBatch(tx, network, rows)),
  });
}
