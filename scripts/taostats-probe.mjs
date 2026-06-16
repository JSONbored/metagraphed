#!/usr/bin/env node
// taostats API probe (read-only) — the FIRST step of the taostats enrichment
// engine (the deterministic fetcher that will gap-fill registry identity,
// discover providers/owners, and detect new subnets, opening provenance-tagged
// PRs for review). The taostats docs obscure the exact endpoint paths + response
// field names, so before writing the engine we confirm them against the live API
// with YOUR key. This script makes ONLY GET requests, writes nothing, and never
// prints the key.
//
// Usage:
//   export TAOSTATS_API_KEY=...        # never commit this; .env* is gitignored
//   node scripts/taostats-probe.mjs            # probe all capabilities, 1 sample each
//   node scripts/taostats-probe.mjs --netuid 1 # probe against a specific subnet
//   node scripts/taostats-probe.mjs --full     # print full first-item JSON, not just keys
//
// Output per capability: the first candidate path that returns 2xx, the HTTP
// status, any rate-limit headers, the response's top-level keys, and the field
// names of the first item (so we can map taostats → registry fields precisely).

const API_KEY = process.env.TAOSTATS_API_KEY;
const BASE = process.env.TAOSTATS_API_BASE || "https://api.taostats.io";
// taostats authenticates with the raw key in the Authorization header (no
// "Bearer "). Override if your account differs.
const AUTH_HEADER = process.env.TAOSTATS_AUTH_HEADER || "Authorization";

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const netuidArg = args.indexOf("--netuid");
const NETUID = netuidArg >= 0 ? Number(args[netuidArg + 1]) : 1;

if (!API_KEY) {
  console.error(
    "✗ TAOSTATS_API_KEY is not set.\n" +
      "  Get one at https://taostats.io/pro then:  export TAOSTATS_API_KEY=...\n" +
      "  (Do not paste it in chat or commit it — .env* is gitignored.)",
  );
  process.exit(1);
}

// Candidate paths per capability. taostats versions paths (…/v1) and split some
// under /api/dtao/. We try each in order and report the first that works, so the
// probe DISCOVERS the live paths rather than assuming them.
const CAPABILITIES = [
  {
    name: "subnets-list (identity + metadata for all subnets)",
    paths: [
      "/api/subnet/latest/v1",
      "/api/dtao/subnet/latest/v1",
      "/api/subnet/v1?limit=5",
      "/api/dtao/subnet/identity/latest/v1?limit=5",
    ],
  },
  {
    name: "subnet-identity (name / github / url / description)",
    paths: [
      `/api/subnet/identity/v1?netuid=${NETUID}`,
      `/api/dtao/subnet_identity/v1?netuid=${NETUID}`,
      `/api/dtao/subnet/identity/latest/v1?netuid=${NETUID}`,
    ],
  },
  {
    name: "subnet-owner",
    paths: [
      `/api/subnet/owner/v1?netuid=${NETUID}`,
      `/api/dtao/subnet/owner/v1?netuid=${NETUID}`,
    ],
  },
  {
    name: "validators-in-subnet",
    paths: [
      `/api/validator/latest/v1?netuid=${NETUID}&limit=3`,
      `/api/dtao/validator/latest/v1?netuid=${NETUID}&limit=3`,
      `/api/metagraph/latest/v1?netuid=${NETUID}&limit=3`,
    ],
  },
  {
    name: "subnet-emission / metrics",
    paths: [
      `/api/subnet/emission/v1?netuid=${NETUID}`,
      `/api/dtao/subnet_emission/v1?netuid=${NETUID}`,
      `/api/dtao/pool/latest/v1?netuid=${NETUID}`,
    ],
  },
  {
    name: "subnet-registrations (new-subnet detection)",
    paths: [
      "/api/subnet/registration/v1?limit=5",
      "/api/dtao/subnet_registration/v1?limit=5",
    ],
  },
];

function fieldNames(value) {
  if (Array.isArray(value)) {
    return value.length
      ? `array[${value.length}] of { ${fieldNames(value[0])} }`
      : "array[0]";
  }
  if (value && typeof value === "object") {
    return Object.keys(value).join(", ");
  }
  return typeof value;
}

// taostats list responses are usually { data: [...], pagination: {...} }. Pull
// the first record whatever the envelope.
function firstRecord(body) {
  if (Array.isArray(body)) return body[0];
  if (body && Array.isArray(body.data)) return body.data[0];
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) {
      if (Array.isArray(v) && v.length) return v[0];
    }
  }
  return body;
}

async function probe(path) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { [AUTH_HEADER]: API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) };
  }
  const rl = {
    limit:
      res.headers.get("x-ratelimit-limit") ||
      res.headers.get("ratelimit-limit"),
    remaining:
      res.headers.get("x-ratelimit-remaining") ||
      res.headers.get("ratelimit-remaining"),
  };
  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { _nonJson: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, rl, body };
}

console.log(
  `taostats probe → ${BASE}  (netuid ${NETUID}, auth via ${AUTH_HEADER})\n`,
);

let firstOk = false;
for (const cap of CAPABILITIES) {
  console.log(`## ${cap.name}`);
  let hit = false;
  for (const path of cap.paths) {
    const r = await probe(path);
    if (r.status === 0) {
      console.log(`   ✗ ${path} — request failed: ${r.error}`);
      continue;
    }
    const rlNote = r.rl?.limit
      ? `  [ratelimit ${r.rl.remaining}/${r.rl.limit}]`
      : "";
    if (r.ok) {
      firstOk = true;
      hit = true;
      const rec = firstRecord(r.body);
      console.log(`   ✓ ${r.status} ${path}${rlNote}`);
      console.log(`     envelope keys: ${fieldNames(r.body)}`);
      console.log(`     first record:  ${fieldNames(rec)}`);
      if (FULL)
        console.log(
          `     sample: ${JSON.stringify(rec, null, 2).slice(0, 1200)}`,
        );
      break; // first working path per capability is enough
    }
    // 401/403 → auth/plan problem; 404 → wrong path (try next). Report either way.
    console.log(`   · ${r.status} ${path}${rlNote}`);
  }
  if (!hit)
    console.log(
      "   (no candidate path returned 2xx — share this so I can adjust)",
    );
  console.log("");
}

if (!firstOk) {
  console.error(
    "No endpoint returned 2xx. If everything was 401/403 the key/plan or the auth\n" +
      "header is the issue (try TAOSTATS_AUTH_HEADER=Authorization or your account's\n" +
      "documented header). If 404, the paths differ — paste the output and I'll fix them.",
  );
  process.exit(2);
}
console.log(
  "Done. Paste this output back and I'll finalize scripts/enrich-taostats.mjs\n" +
    "against the real field names (gap-fill only, provenance-tagged, PRs for review).",
);
