// POSTs a metagraph snapshot to /api/v1/internal/neurons-sync (#9146).
//
// RESTORED FROM THE INDEXER BOX. The neurons family was the only LIVE-refreshed
// data left on it: apps/indexer-rs' poller read the chain and POSTed to this
// same route. That box is being wiped, and its last snapshot landed at
// 2026-08-02T07:50Z -- so without this, `neurons` simply stops advancing and
// every metagraph route freezes at whatever the final box run wrote.
//
// The split matches sample-emission-gate.yml's, which restored a box timer the
// same way: **the producer keeps all chain I/O, the Worker route keeps all
// persistence.** scripts/fetch-metagraph-native.py already owns the chain read
// (one get_all_metagraphs_info call plus the two SubtensorModule storage maps
// MetagraphInfo omits) and writes NEURON_INSERT_COLUMNS-shaped rows; this file
// only ships them. Nothing here reimplements a decode, a unit conversion, or
// the prune -- the route's existing handler does all three, against D1
// (src/neurons-d1-write.ts) as of #9157.
//
// CHUNKING IS NOT OPTIONAL. The route caps a request at NEURONS_SYNC_MAX_ROWS
// (50,000) and NEURONS_SYNC_MAX_BODY_BYTES (32 MB), and a full mainnet snapshot
// is ~30k rows -- comfortably one request today, but a chain that grows past
// either bound would start failing the whole sync rather than half of it. So
// this chunks by BOTH row count and serialized bytes, and sizes each chunk
// before sending rather than discovering the limit from a 413.
//
// The per-netuid prune the route runs is keyed on each row's own captured_at,
// NOT on a batch-wide value (src/neurons-d1-write.ts) -- which is exactly what
// makes chunking safe: splitting one snapshot across N requests cannot make an
// earlier chunk's rows look stale to a later chunk's prune.

const SYNC_URL =
  process.env.NEURONS_SYNC_URL ||
  "https://api.metagraph.sh/api/v1/internal/neurons-sync";
const SYNC_TOKEN = process.env.NEURONS_SYNC_SECRET;
const INPUT =
  process.env.METAGRAPH_NEURONS_JSON || "dist/metagraph-neurons.json";

// Mirrors workers/data-api.ts's NEURONS_SYNC_MAX_ROWS / _MAX_BODY_BYTES. Held
// under the route's real caps rather than at them: the route measures the
// encoded body, and a chunk sized to exactly 32 MB here would fail there.
export const MAX_ROWS_PER_REQUEST = 20_000;
const MAX_BODY_BYTES = 24_000_000;
const REQUEST_TIMEOUT_MS = 120_000;

type Row = Record<string, unknown>;

export function chunkRows(rows: Row[]): Row[][] {
  const chunks: Row[][] = [];
  let current: Row[] = [];
  let currentBytes = 2; // the enclosing "[]"
  for (const row of rows) {
    // +1 for the joining comma. Measured per row rather than estimated: row
    // width varies a lot (axon strings, null-heavy rows), so an average would
    // under-count exactly the snapshots most at risk of tripping the cap.
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_ROWS_PER_REQUEST ||
        currentBytes + rowBytes > MAX_BODY_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function postChunk(
  rows: Row[],
  index: number,
  total: number,
): Promise<Row> {
  const resp = await fetch(SYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-neurons-sync-token": SYNC_TOKEN as string,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(
      `neurons-sync chunk ${index + 1}/${total}: HTTP ${resp.status} ${detail}`,
    );
  }
  return (await resp.json()) as Row;
}

async function main(): Promise<void> {
  if (!SYNC_TOKEN) {
    throw new Error(
      "NEURONS_SYNC_SECRET is required: the shared secret for POST /api/v1/internal/neurons-sync.",
    );
  }

  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(await readFile(INPUT, "utf8")) as unknown;
  const rows = Array.isArray(parsed)
    ? (parsed as Row[])
    : Array.isArray((parsed as Row)?.rows)
      ? ((parsed as Row).rows as Row[])
      : null;
  if (!rows) {
    throw new Error(`${INPUT} must be a JSON array of neuron rows`);
  }
  // An empty snapshot is a FAILED chain read, not an empty chain -- and the
  // route's prune would delete every live UID if it were sent one. Refuse.
  if (rows.length === 0) {
    throw new Error(
      `${INPUT} contains zero rows; refusing to sync an empty snapshot (the route prunes UIDs absent from it).`,
    );
  }

  const chunks = chunkRows(rows);
  let written = 0;
  for (const [index, chunk] of chunks.entries()) {
    const summary = await postChunk(chunk, index, chunks.length);
    written += Number(summary.rows ?? summary.written ?? chunk.length);
  }

  // Same stdout contract as the other restored lanes, so the workflow log
  // reads like the box run it replaces.
  console.log(
    JSON.stringify({
      step: "neurons-sync",
      status: "synced",
      rows: rows.length,
      chunks: chunks.length,
      written,
      netuids: new Set(rows.map((row) => row.netuid)).size,
    }),
  );
}

// Importable for tests (the chunker is the part with real edge cases); only
// runs the sync when invoked directly, matching apply-migrations.ts's guard.
const { fileURLToPath } = await import("node:url");
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      `sync-neurons failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
  });
}
