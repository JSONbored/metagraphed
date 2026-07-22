#!/usr/bin/env node
// Fetch the per-UID metagraph for every active subnet from Taostats (#1303, epic
// #1302) — the chain-level depth metagraphed lacked.
//
// Reads TAOSTATS_API_KEY from the env; the netuid list from the committed native
// snapshot (registry/native/finney-subnets.json). Output: a staging object with
// captured_at, refreshed_netuids (subnets successfully fetched), and neuron rows.
// The refresh-metagraph workflow signs and stages it to R2; the Worker's scheduled
// handler loads rows with parameterized INSERT OR REPLACE, then deletes prior-
// capture rows within refreshed subnets so deregistered UIDs do not linger.
//
// Units verified against /api/v1/economics ground truth (2026-06-21):
//   stake_tao    = total_alpha_stake / 1e9   (Σ matches economics total_stake_tao)
//   emission_tao = emission / 1e9
//   trust / validator_trust / consensus / incentive / dividends = 0..1 ratios.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

const TAOSTATS_BASE = "https://api.taostats.io/api/metagraph/latest/v1";
const RAO = 1e9;
const PAGE_LIMIT = 256; // max UIDs per subnet → single page per subnet
const OUT_PATH =
  process.env.METAGRAPH_NEURONS_JSON || "dist/metagraph-neurons.json";

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const tao = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n / RAO : null;
};
const bool = (v: unknown): 0 | 1 => (v ? 1 : 0);

function formatAxon(axon: unknown): string | null {
  if (!axon || typeof axon !== "object") return null;
  const a = axon as Row;
  const ip = a.ip ?? a.host ?? null;
  if (!ip) return null;
  return a.port ? `${ip}:${a.port}` : String(ip);
}

interface NeuronRow {
  netuid: number | null;
  uid: number | null;
  hotkey: string | null;
  coldkey: string | null;
  active: 0 | 1;
  validator_permit: 0 | 1;
  rank: number | null;
  trust: number | null;
  validator_trust: number | null;
  consensus: number | null;
  incentive: number | null;
  dividends: number | null;
  emission_tao: number | null;
  stake_tao: number | null;
  registered_at_block: number | null;
  is_immunity_period: 0 | 1;
  axon: string | null;
  block_number: number | null;
  captured_at: number;
}

// Map one raw Taostats neuron to the D1 `neurons` row shape. Pure + exported for
// tests. Defensive: any missing/odd field becomes null rather than failing.
export function normalizeNeuron(raw: Row, capturedAt: number): NeuronRow {
  const hotkey = raw?.hotkey as Row | undefined;
  const coldkey = raw?.coldkey as Row | undefined;
  return {
    netuid: num(raw?.netuid),
    uid: num(raw?.uid),
    hotkey: (hotkey?.ss58 as string | undefined) ?? null,
    coldkey: (coldkey?.ss58 as string | undefined) ?? null,
    active: bool(raw?.active),
    validator_permit: bool(raw?.validator_permit),
    rank: num(raw?.rank),
    trust: num(raw?.trust),
    validator_trust: num(raw?.validator_trust),
    consensus: num(raw?.consensus),
    incentive: num(raw?.incentive),
    dividends: num(raw?.dividends),
    emission_tao: tao(raw?.emission),
    stake_tao: tao(raw?.total_alpha_stake),
    registered_at_block: num(raw?.registered_at_block),
    is_immunity_period: bool(raw?.is_immunity_period),
    axon: formatAxon(raw?.axon),
    block_number: num(raw?.block_number),
    captured_at: capturedAt,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Taostats exposes no rate-limit headers and a tight per-key burst limit, so a
// 429 is expected under load. Respect Retry-After when present, else back off
// exponentially, and retry. The daily cron can afford the wait; coverage matters
// more than speed.
async function fetchSubnet(
  netuid: number,
  key: string,
  { maxRetries = 5, baseBackoffMs = 12000 } = {},
): Promise<Row[]> {
  const url = `${TAOSTATS_BASE}?netuid=${netuid}&limit=${PAGE_LIMIT}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: { Authorization: key, accept: "application/json" },
    });
    if (res.ok) {
      const json = (await res.json()) as Row;
      return Array.isArray(json?.data) ? (json.data as Row[]) : [];
    }
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseBackoffMs * (attempt + 1);
      process.stderr.write(
        `netuid ${netuid}: 429, backing off ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})\n`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`taostats netuid ${netuid} -> HTTP ${res.status}`);
  }
}

// Parse the optional METAGRAPH_FETCH_NETUIDS subset (testing). Exported + careful
// about the Number("") === 0 trap: an empty/unset value must yield [] (→ full
// network), NOT [0] (which would silently fetch only subnet 0, incl. in the cron).
export function parseNetuidSubset(raw: unknown): number[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

function readNetuids(): number[] {
  const subset = parseNetuidSubset(process.env.METAGRAPH_FETCH_NETUIDS);
  if (subset.length) return subset.sort((a, b) => a - b);
  const native = JSON.parse(
    readFileSync("registry/native/finney-subnets.json", "utf8"),
  );
  const subnets: Row[] = Array.isArray(native)
    ? native
    : native.subnets || native.data || [];
  return subnets
    .map((s) => s.netuid as number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const key = process.env.TAOSTATS_API_KEY;
  if (!key) {
    console.error("TAOSTATS_API_KEY is required");
    process.exit(1);
  }
  const netuids = readNetuids();
  const delayMs = Number(process.env.METAGRAPH_FETCH_DELAY_MS) || 1200;
  const capturedAt = Date.now();
  const rows: NeuronRow[] = [];
  const refreshedNetuids: number[] = [];
  let failures = 0;
  for (const netuid of netuids) {
    try {
      const neurons = await fetchSubnet(netuid, key);
      refreshedNetuids.push(netuid);
      for (const n of neurons) rows.push(normalizeNeuron(n, capturedAt));
      process.stderr.write(`netuid ${netuid}: ${neurons.length} neurons\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `netuid ${netuid}: FAIL ${(error as Error).message}\n`,
      );
    }
    await sleep(delayMs); // gentle throttle; fetchSubnet handles 429 backoff
  }
  // A daily refresh that lost most subnets to a transient outage should not wipe
  // the table — bail before writing if coverage collapsed.
  if (failures > netuids.length / 2) {
    console.error(
      `aborting: ${failures}/${netuids.length} subnet fetches failed`,
    );
    process.exit(1);
  }
  const valid = rows.filter(
    (r) => Number.isInteger(r.netuid) && Number.isInteger(r.uid),
  );
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify({
      captured_at: capturedAt,
      refreshed_netuids: refreshedNetuids,
      rows: valid,
    }),
  );
  console.log(
    `wrote ${valid.length} neurons across ${refreshedNetuids.length}/${netuids.length} subnets -> ${OUT_PATH}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
