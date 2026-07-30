// One-off (idempotent, safe to re-run) backfill of the runtime-upgrade
// timeline: discovers every spec-version transition from an archive endpoint
// and reconciles a full `blocks` row at each boundary (#8752 follow-up).
//
// Why this exists: GET /api/v1/runtime derives its timeline from
// `MIN(block_number) GROUP BY spec_version` over `blocks` — so it can only be
// as complete as block coverage, and block coverage is islands: measured
// 2026-07-30, Postgres holds [0..3,000], [182,191..244,200],
// [4,600,000..4,600,299], then nothing until continuous coverage starts at
// 8,599,188. The endpoint's "23 transitions" are artifacts of island edges —
// the chain has run roughly 200 upgrades, and its "spec 424 @ 8,599,188"
// entry is the coverage start wearing a transition costume (v424 actually
// activated weeks earlier, in the uncovered region).
//
// Why boundary rows and not a full block backfill: the serving query needs
// only the FIRST block of each spec version to reproduce the complete
// timeline. ~200 fully-populated rows instead of 8.6M. The full historical
// block backfill (#8368) proceeds separately and will simply re-verify these
// rows when it arrives — every value written here is chain-derived, so a
// correct backfill pass finds nothing to change.
//
// RECONCILES, never trusts: an existing row at a boundary height is verified
// against chain truth (hash, spec_version, counts) and overwritten on any
// disagreement. A stored value is evidence that something wrote it, not that
// it is correct.
//
// Why an archive endpoint and not our own node: `chain_getBlockHash` +
// `state_getRuntimeVersion` at historical heights need archive state, but not
// OUR archive state — this runs today against any public archive and is
// deliberately not blocked on the self-hosted node reaching tip (#2111).
//
// Cost: binary search costs ~log2(range) lookups per boundary; ~200
// boundaries over 8.7M blocks is ~4,600 RPC calls, not 8.7M.
//
// Usage:
//   node scripts/backfill-runtime-transitions.ts [options]
//
//   --archive-url URL    archive RPC endpoint (default: $ARCHIVE_RPC_URL, then
//                        https://archive.chain.opentensor.ai)
//   --database-url URL   Postgres connection string (default: $DATABASE_URL)
//   --from BLOCK         first block to search from (default: 0)
//   --to BLOCK           last block to search to (default: current chain head)
//   --out PATH           also write the discovered boundary rows as JSON
//   --seed PATH          skip discovery: load boundary rows from a prior
//                        --out file (discovery is ~15 min; the reconcile is
//                        seconds — this lets one discovery serve both the
//                        dry-run and the --write pass)
//   --write              apply the upserts; default is a dry run that reports
//                        what would change and touches nothing
import path from "node:path";

export interface SpecTransition {
  block_number: number;
  spec_version: number;
}

// A fully chain-derived `blocks` row for one transition boundary. `author` is
// the one column left null: recovering it needs the Aura digest decode, which
// buys nothing for the timeline. `observed_at` is the block's own on-chain
// timestamp (the `timestamp.set` inherent), NOT the time this script ran —
// the endpoint surfaces it as the upgrade date.
export interface BoundaryRow {
  block_number: number;
  spec_version: number;
  block_hash: string;
  parent_hash: string;
  extrinsic_count: number;
  event_count: number | null;
  observed_at_ms: number;
}

export interface BackfillOptions {
  archiveUrl: string;
  databaseUrl: string;
  from: number;
  to: number | null;
  out: string | null;
  seed: string | null;
  write: boolean;
}

const DEFAULT_ARCHIVE_URL = "https://archive.chain.opentensor.ai";

export function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = {
    archiveUrl: process.env.ARCHIVE_RPC_URL || DEFAULT_ARCHIVE_URL,
    databaseUrl: process.env.DATABASE_URL || "",
    from: 0,
    to: null,
    out: null,
    seed: null,
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--archive-url") opts.archiveUrl = argv[++i];
    else if (arg === "--database-url") opts.databaseUrl = argv[++i];
    else if (arg === "--from") opts.from = Number(argv[++i]);
    else if (arg === "--to") opts.to = Number(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--seed") opts.seed = argv[++i];
    else if (arg === "--write") opts.write = true;
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return opts;
}

export function assertValidOptions(opts: BackfillOptions): void {
  if (!opts.archiveUrl) {
    throw new Error("--archive-url required (or set ARCHIVE_RPC_URL)");
  }
  if (!Number.isInteger(opts.from) || opts.from < 0) {
    throw new Error("--from must be a non-negative integer block number");
  }
  if (opts.to != null && (!Number.isInteger(opts.to) || opts.to < 0)) {
    throw new Error("--to must be a non-negative integer block number");
  }
  if (opts.to != null && opts.to <= opts.from) {
    throw new Error(
      `--to (${opts.to}) must be greater than --from (${opts.from})`,
    );
  }
  // A dry run against a database still only reads; only --write needs a
  // target it could damage. Same "refuse to guess a connection target" stance
  // as scripts/backfill-wallet-flow-daily.ts.
  if (opts.write && !opts.databaseUrl) {
    throw new Error(
      "DATABASE_URL required with --write (or pass --database-url) -- refusing to guess a connection target",
    );
  }
}

// SCALE compact-u64 decode from a byte array offset. Returns [value, bytes
// consumed] or null when malformed. Only the four standard modes; big-int
// mode caps at 8 payload bytes (a u64 moment never needs more).
export function decodeCompactU64(
  bytes: Uint8Array,
  offset: number,
): [bigint, number] | null {
  if (offset >= bytes.length) return null;
  const mode = bytes[offset] & 0b11;
  if (mode === 0b00) return [BigInt(bytes[offset] >> 2), 1];
  if (mode === 0b01) {
    if (offset + 2 > bytes.length) return null;
    return [BigInt((bytes[offset] | (bytes[offset + 1] << 8)) >>> 2), 2];
  }
  if (mode === 0b10) {
    if (offset + 4 > bytes.length) return null;
    const v =
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0;
    return [BigInt(v) >> 2n, 4];
  }
  const len = (bytes[offset] >> 2) + 4;
  if (len > 8 || offset + 1 + len > bytes.length) return null;
  let v = 0n;
  for (let i = offset + len; i > offset; i -= 1) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return [v, 1 + len];
}

// The block's on-chain timestamp in ms, decoded from the `timestamp.set`
// inherent — by convention the first extrinsic of every Substrate block.
// Unsigned v4 extrinsic layout: compact length ++ 0x04 ++ pallet index ++
// call index (0x00) ++ compact u64 moment. The pallet index is NOT hardcoded
// (it has moved across runtimes); instead the decoded value must land in a
// sane window — a wrong-pallet decode produces garbage that fails the range
// check rather than a silently wrong date.
const TIMESTAMP_MIN_MS = Date.parse("2020-01-01T00:00:00Z");
const TIMESTAMP_MAX_MS = Date.parse("2030-01-01T00:00:00Z");

export function decodeBlockTimestampMs(
  firstExtrinsicHex: string | null | undefined,
): number | null {
  if (typeof firstExtrinsicHex !== "string") return null;
  const hex = firstExtrinsicHex.replace(/^0x/, "");
  if (hex.length < 12 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const lengthPrefix = decodeCompactU64(bytes, 0);
  if (!lengthPrefix) return null;
  let at = lengthPrefix[1];
  // 0x04 = unsigned extrinsic format v4; 0x05 = bare extrinsic format v5 —
  // the chain switched formats mid-history (block 8.4M's inherent is
  // `0x280502…`, block 1M's is `0x280402…`, both verified live 2026-07-30),
  // so both must decode. The signed bit (0x84/0x85) still rejects: a signed
  // first extrinsic is not the timestamp inherent.
  if (bytes[at] !== 0x04 && bytes[at] !== 0x05) return null;
  at += 3; // version byte + pallet index + call index
  const moment = decodeCompactU64(bytes, at);
  if (!moment) return null;
  const ms = Number(moment[0]);
  if (
    !Number.isSafeInteger(ms) ||
    ms < TIMESTAMP_MIN_MS ||
    ms > TIMESTAMP_MAX_MS
  ) {
    return null;
  }
  return ms;
}

// Every block at which the runtime's spec_version differs from the block
// before it, plus `lowBlock` itself as the first known reading.
//
// Divide and conquer, not a scan: if the endpoints of a range share a
// spec_version there is no upgrade strictly inside it, so the range is
// skipped whole; ranges that differ are halved until each boundary is pinned
// to a single block. Call count scales with the number of UPGRADES (~200),
// not the number of blocks (~8.7M).
//
// Correctness note: a same-spec range is assumed upgrade-free. A spec_version
// introduced and fully reverted strictly inside one range would be missed —
// spec_versions increase monotonically across upgrades, so a same-spec range
// implies no upgrade in practice; recovering a rollback is not something this
// backfill claims to do.
export async function findSpecTransitions(
  lowBlock: number,
  highBlock: number,
  getSpecVersion: (block: number) => Promise<number>,
): Promise<SpecTransition[]> {
  const cache = new Map<number, number>();
  const specAt = async (block: number): Promise<number> => {
    const hit = cache.get(block);
    if (hit !== undefined) return hit;
    const spec = await getSpecVersion(block);
    cache.set(block, spec);
    return spec;
  };

  const lowSpec = await specAt(lowBlock);
  const highSpec = await specAt(highBlock);
  const boundaries: SpecTransition[] = [
    { block_number: lowBlock, spec_version: lowSpec },
  ];

  // Explicit stack rather than recursion: depth is log2(range) but pending
  // sub-range count is not, and await-recursion over ~200 boundaries is
  // needlessly fragile.
  const pending: [number, number, number, number][] = [
    [lowBlock, lowSpec, highBlock, highSpec],
  ];
  while (pending.length > 0) {
    const [lo, loSpec, hi, hiSpec] = pending.pop()!;
    if (loSpec === hiSpec) continue;
    if (hi - lo === 1) {
      boundaries.push({ block_number: hi, spec_version: hiSpec });
      continue;
    }
    const mid = Math.floor((lo + hi) / 2);
    const midSpec = await specAt(mid);
    pending.push([mid, midSpec, hi, hiSpec]);
    pending.push([lo, loSpec, mid, midSpec]);
  }

  boundaries.sort((a, b) => a.block_number - b.block_number);
  return boundaries;
}

// A seed file is still input from outside the process — validate every row's
// shape and ranges before treating it as chain truth. Same trust posture as
// the RPC responses.
export function parseSeedRows(text: string): BoundaryRow[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("seed file must be a JSON array");
  return parsed.map((row, i) => {
    const r = row as Record<string, unknown>;
    const blockNumber = Number(r.block_number);
    const specVersion = Number(r.spec_version);
    const extrinsicCount = Number(r.extrinsic_count);
    const observedAtMs = Number(r.observed_at_ms);
    const eventCount = r.event_count === null ? null : Number(r.event_count);
    if (
      !Number.isInteger(blockNumber) ||
      blockNumber < 0 ||
      !Number.isInteger(specVersion) ||
      specVersion < 0 ||
      !Number.isInteger(extrinsicCount) ||
      extrinsicCount < 0 ||
      (eventCount !== null &&
        (!Number.isInteger(eventCount) || eventCount < 0)) ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs <= 0 ||
      typeof r.block_hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(r.block_hash) ||
      typeof r.parent_hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(r.parent_hash)
    ) {
      throw new Error(`seed row ${i} is malformed: ${JSON.stringify(row)}`);
    }
    return {
      block_number: blockNumber,
      spec_version: specVersion,
      block_hash: r.block_hash,
      parent_hash: r.parent_hash,
      extrinsic_count: extrinsicCount,
      event_count: eventCount,
      observed_at_ms: observedAtMs,
    };
  });
}

interface ArchiveClient {
  call(method: string, params: unknown[]): Promise<unknown>;
}

// A transient failure worth retrying: rate limiting (the public archive
// throttles "historical work" aggressively — hit for real on the first
// full-range run), 5xx/429, and network-level fetch failures. A JSON-RPC
// error that is NOT rate limiting (unknown method, missing block) is
// permanent and re-thrown immediately — retrying a wrong request only burns
// the rate budget the retryable calls need.
export function isRetryableRpcError(message: string): boolean {
  return /rate limit|429|timeout|timed out|ECONNRESET|fetch failed|50[234]|too many/i.test(
    message,
  );
}

const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export function createArchiveClient(
  archiveUrl: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): ArchiveClient {
  const once = async (method: string, params: unknown[]): Promise<unknown> => {
    const resp = await fetchImpl(archiveUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!resp.ok) throw new Error(`${method} failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`${method} failed: ${body.error.message ?? "rpc error"}`);
    }
    return body.result;
  };
  return {
    async call(method: string, params: unknown[]): Promise<unknown> {
      let lastError: Error = new Error("unreachable");
      for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
          return await once(method, params);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (!isRetryableRpcError(lastError.message)) throw lastError;
          if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
          // Exponential backoff with full jitter, capped — the standard
          // shape for a shared rate-limited upstream.
          const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
          const wait = Math.floor(Math.random() * ceiling);
          console.warn(
            `retryable RPC failure (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}), backing off ${wait}ms: ${lastError.message}`,
          );
          await sleep(wait);
        }
      }
      throw lastError;
    },
  };
}

// twox128("System") ++ twox128("EventCount") — the per-block event count as a
// plain StorageValue, read at the boundary block's hash. Precomputed offline
// per the sudo-key.ts/network-parameters.ts precedent (twox128 needs XXHash64
// and this script has no reason to import the Worker's helper).
const SYSTEM_EVENT_COUNT_KEY =
  "0x26aa394eea5630e07c48ae0c9558cef70a98fdbe9ce6c55837576c60c7af3850";

// Full chain-derived row for one boundary. event_count is best-effort (a
// storage miss yields null, never a fabricated 0 — 0 events is a real
// on-chain value and must not be conflated with "could not read").
export async function fetchBoundaryRow(
  client: ArchiveClient,
  transition: SpecTransition,
): Promise<BoundaryRow> {
  const hash = await client.call("chain_getBlockHash", [
    transition.block_number,
  ]);
  if (typeof hash !== "string" || hash === "") {
    throw new Error(`no block hash at height ${transition.block_number}`);
  }
  const block = (await client.call("chain_getBlock", [hash])) as {
    block?: {
      header?: { parentHash?: unknown };
      extrinsics?: unknown[];
    };
  } | null;
  const parentHash = block?.block?.header?.parentHash;
  const extrinsics = block?.block?.extrinsics;
  if (typeof parentHash !== "string" || !Array.isArray(extrinsics)) {
    throw new Error(
      `malformed block body at height ${transition.block_number}`,
    );
  }
  let observedAtMs = decodeBlockTimestampMs(
    typeof extrinsics[0] === "string" ? extrinsics[0] : null,
  );
  // The genesis block carries no extrinsics, so it has no timestamp inherent
  // to decode (hit for real on the first full-range run). Block 1's moment is
  // the chain's own first recorded time — at most one block interval of
  // imprecision, still chain-derived, still reproducible. Only height 0 gets
  // this treatment: any OTHER block missing its inherent is malformed data
  // and stays a hard refusal.
  if (observedAtMs == null && transition.block_number === 0) {
    const firstHash = await client.call("chain_getBlockHash", [1]);
    if (typeof firstHash === "string" && firstHash !== "") {
      const firstBlock = (await client.call("chain_getBlock", [firstHash])) as {
        block?: { extrinsics?: unknown[] };
      } | null;
      const firstInherent = firstBlock?.block?.extrinsics?.[0];
      observedAtMs = decodeBlockTimestampMs(
        typeof firstInherent === "string" ? firstInherent : null,
      );
    }
  }
  if (observedAtMs == null) {
    throw new Error(
      `could not decode the timestamp inherent at height ${transition.block_number} -- refusing to write a row with a fabricated observed_at`,
    );
  }
  let eventCount: number | null = null;
  try {
    const raw = await client.call("state_getStorage", [
      SYSTEM_EVENT_COUNT_KEY,
      hash,
    ]);
    if (typeof raw === "string" && /^0x[0-9a-fA-F]{8}$/.test(raw)) {
      eventCount =
        Number.parseInt(raw.slice(2, 4), 16) |
        (Number.parseInt(raw.slice(4, 6), 16) << 8) |
        (Number.parseInt(raw.slice(6, 8), 16) << 16) |
        (Number.parseInt(raw.slice(8, 10), 16) << 24);
    }
  } catch {
    // best-effort; null is the honest value
  }
  return {
    block_number: transition.block_number,
    spec_version: transition.spec_version,
    block_hash: hash,
    parent_hash: parentHash,
    extrinsic_count: extrinsics.length,
    event_count: eventCount,
    observed_at_ms: observedAtMs,
  };
}

// The reconcile decision for one boundary against whatever Postgres currently
// holds there. Pure so it is testable without a database. An existing row is
// never trusted: any disagreement on hash, spec_version, or counts means
// overwrite. `insert` when the height has no row at all (the common case —
// coverage is islands).
export type ReconcileAction = "insert" | "overwrite" | "in_sync";

export interface ExistingRow {
  block_hash: string | null;
  spec_version: number | null;
  extrinsic_count: number | null;
  event_count: number | null;
}

export function reconcileAction(
  truth: BoundaryRow,
  existing: ExistingRow | undefined,
): ReconcileAction {
  if (existing === undefined) return "insert";
  if (
    existing.block_hash === truth.block_hash &&
    existing.spec_version === truth.spec_version &&
    existing.extrinsic_count === truth.extrinsic_count &&
    // A null stored event_count is stale-but-honest only if truth is also
    // unknown; when truth has a value, null must be upgraded.
    (existing.event_count === truth.event_count || truth.event_count === null)
  ) {
    return "in_sync";
  }
  return "overwrite";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  assertValidOptions(opts);

  const client = createArchiveClient(opts.archiveUrl);
  const readSpec = async (block: number): Promise<number> => {
    const hash = await client.call("chain_getBlockHash", [block]);
    if (typeof hash !== "string" || hash === "") {
      throw new Error(`no block hash at height ${block}`);
    }
    const version = (await client.call("state_getRuntimeVersion", [hash])) as {
      specVersion?: unknown;
    } | null;
    const spec = Number(version?.specVersion);
    if (!Number.isInteger(spec) || spec < 0) {
      throw new Error(`no specVersion at height ${block}`);
    }
    return spec;
  };

  let toBlock = opts.to;
  if (toBlock == null) {
    const header = (await client.call("chain_getHeader", [])) as {
      number?: string;
    } | null;
    toBlock = Number.parseInt(header?.number ?? "0x0", 16);
    if (!Number.isInteger(toBlock) || toBlock <= opts.from) {
      throw new Error("could not resolve chain head from the archive endpoint");
    }
  }

  let rows: BoundaryRow[];
  if (opts.seed) {
    const { readFileSync } = await import("node:fs");
    rows = parseSeedRows(readFileSync(opts.seed, "utf8"));
    console.log(
      `loaded ${rows.length} boundary rows from ${opts.seed} (discovery skipped)`,
    );
  } else {
    console.log(
      `searching for runtime transitions in [${opts.from}, ${toBlock}] via ${opts.archiveUrl}`,
    );
    const started = Date.now();
    const transitions = await findSpecTransitions(opts.from, toBlock, readSpec);
    console.log(
      `found ${transitions.length} transitions in ${((Date.now() - started) / 1000).toFixed(1)}s; fetching boundary rows`,
    );
    rows = [];
    for (const t of transitions) {
      rows.push(await fetchBoundaryRow(client, t));
    }
  }
  for (const r of rows) {
    console.log(
      `  spec ${r.spec_version} @ block ${r.block_number}  (${new Date(r.observed_at_ms).toISOString()})`,
    );
  }

  if (opts.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(opts.out, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`wrote ${opts.out}`);
  }

  if (!opts.databaseUrl) {
    console.log(
      "no DATABASE_URL -- discovery only, nothing inspected or written",
    );
    return;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(opts.databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
  });
  try {
    const blockNumbers = rows.map((r) => r.block_number);
    const existingRows = await sql<
      {
        block_number: string;
        block_hash: string | null;
        spec_version: number | null;
        extrinsic_count: number | null;
        event_count: number | null;
      }[]
    >`
      SELECT block_number, block_hash, spec_version, extrinsic_count, event_count
      FROM blocks WHERE block_number IN ${sql(blockNumbers)}`;
    const existing = new Map<number, ExistingRow>(
      existingRows.map((r) => [
        Number(r.block_number),
        {
          block_hash: r.block_hash,
          spec_version: r.spec_version,
          extrinsic_count: r.extrinsic_count,
          event_count: r.event_count,
        },
      ]),
    );

    const plan = rows.map((r) => ({
      row: r,
      action: reconcileAction(r, existing.get(r.block_number)),
    }));
    const counts = { insert: 0, overwrite: 0, in_sync: 0 };
    for (const p of plan) counts[p.action] += 1;
    console.log(
      `reconcile plan: ${counts.insert} insert, ${counts.overwrite} overwrite, ${counts.in_sync} in sync`,
    );
    for (const p of plan) {
      if (p.action === "overwrite") {
        const was = existing.get(p.row.block_number);
        console.log(
          `  overwrite @ ${p.row.block_number}: stored spec=${was?.spec_version} hash=${was?.block_hash?.slice(0, 10)}… -> chain spec=${p.row.spec_version} hash=${p.row.block_hash.slice(0, 10)}…`,
        );
      }
    }

    if (!opts.write) {
      console.log("[dry-run] re-run with --write to apply");
      return;
    }

    // DELETE + INSERT per boundary, in one transaction each, rather than ON
    // CONFLICT: `blocks` keys on (block_number, observed_at) — the Timescale
    // partition column is part of the PK — so a conflict target on
    // block_number alone does not exist, and a composite-target upsert would
    // MISS an existing row whose observed_at disagrees with chain truth and
    // insert a duplicate block_number beside it. The reconcile stance is that
    // chain truth replaces whatever is there, including a wrong observed_at.
    let applied = 0;
    for (const p of plan) {
      if (p.action === "in_sync") continue;
      const r = p.row;
      const observedAt = new Date(r.observed_at_ms).toISOString();
      await sql.begin(async (tx) => {
        await tx`DELETE FROM blocks WHERE block_number = ${r.block_number}`;
        await tx`
          INSERT INTO blocks (block_number, observed_at, block_hash, parent_hash, extrinsic_count, event_count, spec_version)
          VALUES (${r.block_number}, ${observedAt}, ${r.block_hash}, ${r.parent_hash}, ${r.extrinsic_count}, ${r.event_count}, ${r.spec_version})`;
      });
      applied += 1;
    }
    console.log(`applied ${applied} row(s)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Entrypoint guard so the pure exports above can be imported by tests without
// running the backfill, mirroring scripts/backfill-wallet-flow-daily.ts.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  await main();
}
