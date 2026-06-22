#!/usr/bin/env node
// Fetch the per-UID metagraph for every active subnet from Taostats (#1303, epic
// #1302) — the chain-level depth metagraphed lacked.
//
// Reads TAOSTATS_API_KEY from the env; the netuid list from the committed native
// snapshot (registry/native/finney-subnets.json). Output: a JSON array of neuron
// rows that the refresh-metagraph workflow stages to R2; the Worker's scheduled
// handler then loads them into the metagraphed-health D1 `neurons` table with
// parameterized inserts (loadStagedNeurons), keyed (netuid, uid) so a re-run
// overwrites in place (slots are reused on-chain) and the table stays bounded.
//
// Units verified against /api/v1/economics ground truth (2026-06-21):
//   stake_tao    = total_alpha_stake / 1e9   (Σ matches economics total_stake_tao)
//   emission_tao = emission / 1e9
//   trust / validator_trust / consensus / incentive / dividends = 0..1 ratios.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAOSTATS_BASE = "https://api.taostats.io/api/metagraph/latest/v1";
const RAO = 1e9;
const PAGE_LIMIT = 256; // max UIDs per subnet → single page per subnet
const OUT_PATH =
  process.env.METAGRAPH_NEURONS_JSON || "dist/metagraph-neurons.json";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const tao = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n / RAO : null;
};
const bool = (v) => (v ? 1 : 0);

function formatAxon(axon) {
  if (!axon || typeof axon !== "object") return null;
  const ip = axon.ip ?? axon.host ?? null;
  if (!ip) return null;
  return axon.port ? `${ip}:${axon.port}` : String(ip);
}

// Map one raw Taostats neuron to the D1 `neurons` row shape. Pure + exported for
// tests. Defensive: any missing/odd field becomes null rather than failing.
export function normalizeNeuron(raw, capturedAt) {
  return {
    netuid: num(raw?.netuid),
    uid: num(raw?.uid),
    hotkey: raw?.hotkey?.ss58 ?? null,
    coldkey: raw?.coldkey?.ss58 ?? null,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Taostats exposes no rate-limit headers and a tight per-key burst limit, so a
// 429 is expected under load. Respect Retry-After when present, else back off
// exponentially, and retry. The daily cron can afford the wait; coverage matters
// more than speed.
async function fetchSubnet(
  netuid,
  key,
  { maxRetries = 5, baseBackoffMs = 12000 } = {},
) {
  const url = `${TAOSTATS_BASE}?netuid=${netuid}&limit=${PAGE_LIMIT}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: { Authorization: key, accept: "application/json" },
    });
    if (res.ok) {
      const json = await res.json();
      return Array.isArray(json?.data) ? json.data : [];
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
export function parseNetuidSubset(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

function readNetuids() {
  const subset = parseNetuidSubset(process.env.METAGRAPH_FETCH_NETUIDS);
  if (subset.length) return subset.sort((a, b) => a - b);
  const native = JSON.parse(
    readFileSync("registry/native/finney-subnets.json", "utf8"),
  );
  const subnets = Array.isArray(native)
    ? native
    : native.subnets || native.data || [];
  return subnets
    .map((s) => s.netuid)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

async function main() {
  const key = process.env.TAOSTATS_API_KEY;
  if (!key) {
    console.error("TAOSTATS_API_KEY is required");
    process.exit(1);
  }
  const netuids = readNetuids();
  const delayMs = Number(process.env.METAGRAPH_FETCH_DELAY_MS) || 1200;
  const capturedAt = Date.now();
  const rows = [];
  let failures = 0;
  for (const netuid of netuids) {
    try {
      const neurons = await fetchSubnet(netuid, key);
      for (const n of neurons) rows.push(normalizeNeuron(n, capturedAt));
      process.stderr.write(`netuid ${netuid}: ${neurons.length} neurons\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`netuid ${netuid}: FAIL ${error.message}\n`);
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
  writeFileSync(OUT_PATH, JSON.stringify(valid));
  console.log(
    `wrote ${valid.length} neurons across ${netuids.length - failures}/${netuids.length} subnets -> ${OUT_PATH}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
