import { describe, expect, it } from "vitest";
import { summarizeCall, summarizeEvent } from "./chain-summaries";

// #8371: measures summarizeCall/summarizeEvent's real coverage against a
// live sample of recent production data -- the issue's own requirement
// ("run the template table against the most recent 10,000 indexed
// extrinsics + events; ≥95% must produce a sentence"), not a synthetic
// fixture count. Skipped by default (no network dependency in the normal
// suite/CI); run explicitly with:
//
//   RUN_COVERAGE=1 npx vitest run src/lib/metagraphed/chain-summaries.coverage.test.ts
//
// Coverage numbers move as chain activity shifts, so this asserts the
// ≥95% bar rather than an exact percentage -- a regression below that bar
// is the signal worth failing on, not day-to-day drift.

const RUN = process.env.RUN_COVERAGE === "1";
const API_BASE = "https://api.metagraph.sh";
const TARGET = 10_000;
const PAGE_SIZE = 100;

interface Tally {
  total: number;
  covered: number;
  misses: Map<string, number>;
}

function record(tally: Tally, key: string, summary: string | null) {
  tally.total++;
  if (summary != null) tally.covered++;
  else tally.misses.set(key, (tally.misses.get(key) ?? 0) + 1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries up to 3x on a 429 (rate limit), backing off each time. */
async function fetchWithRetry(url: string): Promise<Response> {
  let res = await fetch(url);
  for (let attempt = 1; res.status === 429 && attempt <= 3; attempt++) {
    await sleep(attempt * 1500);
    res = await fetch(url);
  }
  return res;
}

async function measureExtrinsics(): Promise<Tally> {
  const tally: Tally = { total: 0, covered: 0, misses: new Map() };
  let offset = 0;
  while (tally.total < TARGET) {
    const res = await fetchWithRetry(
      `${API_BASE}/api/v1/extrinsics?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!res.ok) throw new Error(`extrinsics fetch failed: ${res.status}`);
    const body = (await res.json()) as { data?: { extrinsics?: unknown[] } };
    const rows = (body.data?.extrinsics ?? []) as Array<{
      call_module?: string | null;
      call_function?: string | null;
      call_args?: unknown;
      signer?: string | null;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = `${row.call_module ?? "?"}.${row.call_function ?? "?"}`;
      const summary = summarizeCall(row.call_module, row.call_function, row.call_args, {
        signer: row.signer,
      });
      record(tally, key, summary);
    }
    offset += PAGE_SIZE;
  }
  return tally;
}

async function measureEvents(): Promise<Tally> {
  const tally: Tally = { total: 0, covered: 0, misses: new Map() };
  let cursor = "";
  while (tally.total < TARGET) {
    const url = `${API_BASE}/api/v1/chain-events?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`chain-events fetch failed: ${res.status}`);
    const body = (await res.json()) as {
      data?: { events?: unknown[]; next_cursor?: string | null };
    };
    const rows = (body.data?.events ?? []) as Array<{
      pallet?: string | null;
      method?: string | null;
      args?: unknown;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = `${row.pallet ?? "?"}.${row.method ?? "?"}`;
      record(tally, key, summarizeEvent(row.pallet, row.method, row.args));
    }
    const next = body.data?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return tally;
}

function report(label: string, tally: Tally) {
  const pct = tally.total === 0 ? 0 : (tally.covered / tally.total) * 100;
  console.log(`\n${label}: ${tally.covered}/${tally.total} (${pct.toFixed(2)}%)`);
  const top = [...tally.misses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length > 0) {
    console.log("  Top uncovered:");
    for (const [key, count] of top) console.log(`    ${key}: ${count}`);
  }
}

describe.skipIf(!RUN)("chain-summaries coverage (live, opt-in)", () => {
  it("measures >=95% coverage against the most recent ~10k extrinsics + events", async () => {
    const extrinsics = await measureExtrinsics();
    const events = await measureEvents();
    report("Extrinsics", extrinsics);
    report("Chain events", events);
    const total = extrinsics.total + events.total;
    const covered = extrinsics.covered + events.covered;
    const pct = total === 0 ? 0 : (covered / total) * 100;
    console.log(`\nCombined: ${covered}/${total} (${pct.toFixed(2)}%)`);
    expect(pct).toBeGreaterThanOrEqual(95);
  }, 300_000);
});
