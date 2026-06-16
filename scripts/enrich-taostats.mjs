#!/usr/bin/env node
// taostats enrichment engine — STEP 1: gap analysis (read-only, no writes).
// Fetches subnet identity from taostats and compares it to metagraphed's current
// served state, reporting where taostats can FILL A GAP (a field metagraphed is
// missing that taostats has). It never proposes overwriting a value metagraphed
// already has — taostats is a third-party source that sits BELOW native chain +
// curated overlays in the trust model. Every proposed fill is provenance-tagged
// `source: taostats`.
//
//   export TAOSTATS_API_KEY=...        (.env* is gitignored)
//   node scripts/enrich-taostats.mjs            # gap summary
//   node scripts/enrich-taostats.mjs --details  # per-subnet gaps too
//
// Next steps (not in this file yet): --write to stage overlay gap-fills on a
// branch + open a rolling PR for review; a separate live-metrics artifact.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const API_KEY = process.env.TAOSTATS_API_KEY;
const BASE = process.env.TAOSTATS_API_BASE || "https://api.taostats.io";
const AUTH_HEADER = process.env.TAOSTATS_AUTH_HEADER || "Authorization";
const DETAILS = process.argv.includes("--details");
const JSON_OUT = process.argv.includes("--json");

if (!API_KEY) {
  console.error(
    "✗ TAOSTATS_API_KEY is not set (see scripts/taostats-probe.mjs).",
  );
  process.exit(1);
}

// taostats identity field -> the metagraphed field it can gap-fill. `nested`
// targets live under social.{key}. Curated overlay always wins; this only fills
// when metagraphed's served value is empty.
const FIELD_MAP = [
  { mg: "source_repo", ts: "github_repo", kind: "url" },
  { mg: "website_url", ts: "subnet_url", kind: "url" },
  { mg: "logo_url", ts: "logo_url", kind: "url" },
  { mg: "discord", ts: "discord", kind: "string" },
  { mg: "description", ts: "description", kind: "string" },
  { mg: "social.x", ts: "twitter", kind: "social", nested: "x" },
  { mg: "categories", ts: "tags", kind: "array" },
];

async function fetchAllIdentities() {
  const out = new Map(); // netuid -> identity record
  let page = 1;
  for (;;) {
    const url = `${BASE}/api/subnet/identity/v1?limit=200&page=${page}`;
    const res = await fetch(url, {
      headers: { [AUTH_HEADER]: API_KEY, accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`taostats identity page ${page} -> HTTP ${res.status}`);
    }
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    for (const row of rows) {
      if (Number.isInteger(row?.netuid)) out.set(row.netuid, row);
    }
    const pg = body?.pagination || {};
    const next = pg.next_page ?? (rows.length === 200 ? page + 1 : null);
    if (!next || rows.length === 0) break;
    page = Number(next);
    if (page > 50) break; // safety
  }
  return out;
}

const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

function mgValue(subnet, field) {
  if (field.nested) return subnet.social?.[field.nested];
  return subnet[field.mg];
}

function tsValue(identity, field) {
  const raw = identity[field.ts];
  if (isEmpty(raw)) return null;
  if (
    field.kind === "url" &&
    typeof raw === "string" &&
    !/^https?:\/\//i.test(raw)
  ) {
    // taostats sometimes returns bare handles/paths; the real engine will run
    // these through normalizePublicHttpUrl. For analysis, keep as-is.
    return raw;
  }
  return raw;
}

function main() {
  const subnetsArtifact = JSON.parse(
    readFileSync(path.join(repoRoot, "public/metagraph/subnets.json"), "utf8"),
  );
  const subnets = subnetsArtifact.subnets || [];
  return fetchAllIdentities().then((identities) => {
    const gapsByField = Object.fromEntries(FIELD_MAP.map((f) => [f.mg, 0]));
    const perSubnet = [];
    let taostatsKnown = 0;

    for (const subnet of subnets) {
      const identity = identities.get(subnet.netuid);
      if (!identity) continue;
      taostatsKnown += 1;
      const gaps = [];
      for (const field of FIELD_MAP) {
        const have = mgValue(subnet, field);
        const ts = tsValue(identity, field);
        if (isEmpty(have) && !isEmpty(ts)) {
          gaps.push({ field: field.mg, fill: ts });
          gapsByField[field.mg] += 1;
        }
      }
      if (gaps.length)
        perSubnet.push({
          netuid: subnet.netuid,
          slug: subnet.slug,
          name: subnet.name,
          gaps,
        });
    }

    // Machine-readable output for the Claude enrichment routine to consume.
    if (JSON_OUT) {
      process.stdout.write(
        JSON.stringify(
          { matched: taostatsKnown, summary: gapsByField, subnets: perSubnet },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    console.log(
      `taostats gap analysis — ${subnets.length} metagraphed subnets, ` +
        `${taostatsKnown} matched in taostats identity.\n`,
    );
    console.log(
      "Gap-fills taostats could contribute (metagraphed empty + taostats has):",
    );
    for (const f of FIELD_MAP) {
      console.log(`  ${f.mg.padEnd(14)} ${gapsByField[f.mg]} subnet(s)`);
    }
    const totalFills = Object.values(gapsByField).reduce((a, b) => a + b, 0);
    console.log(
      `\n  → ${totalFills} total gap-fills across ${perSubnet.length} subnet(s).` +
        " All would be provenance-tagged source:taostats, gap-fill only.\n",
    );

    if (DETAILS) {
      for (const s of perSubnet.slice(0, 40)) {
        console.log(
          `  SN${s.netuid} ${s.name}: ` +
            s.gaps
              .map((g) => `${g.field}=${String(g.fill).slice(0, 48)}`)
              .join("  |  "),
        );
      }
      if (perSubnet.length > 40)
        console.log(`  …and ${perSubnet.length - 40} more.`);
    } else {
      console.log("Run with --details to see per-subnet gap-fills.");
    }
  });
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
