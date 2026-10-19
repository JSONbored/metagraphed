import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { handleRequest } from "../workers/api.ts";
import {
  cleanDescription,
  createLocalArtifactEnv,
  loadNativeSnapshot,
  readJson,
  repoRoot,
  subnetLifecycle,
} from "../scripts/lib.ts";
import { parseJsonBody, type Row } from "./row-type.ts";
import { SuccessEnvelopeSchema } from "../schemas-src/envelope.ts";
import { SearchArtifactSchema } from "../schemas-src/routes/evidence-search.ts";

// search.json is R2-tier (built to dist/), with a public/ fallback.
function loadArtifact(relative: string): Promise<Row> {
  const candidates = [
    path.join(repoRoot, "dist/metagraph-r2/metagraph", relative),
    path.join(repoRoot, "public/metagraph", relative),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  return readJson(file!);
}

const search = await loadArtifact("search.json");
const subnetsArtifact = await loadArtifact("subnets.json");
const nativeSnapshot = await loadNativeSnapshot();

// Semantic invariants for the discovery layer (TS1/TS5): the search corpus must
// carry real subnet descriptions and must NOT be polluted by URL-fragment
// tokens — the regression that made "which subnet does X" unanswerable.

const env = createLocalArtifactEnv();

async function keywordSearch(query: string, limit = 5) {
  const res = await handleRequest(
    new Request(
      `https://api.metagraph.sh/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
    env as unknown as Env,
    {},
  );
  const body = await parseJsonBody(res, SuccessEnvelopeSchema);
  const data = body.data;
  assert.ok(data && typeof data === "object" && !Array.isArray(data));
  // Keep the legacy results/documents fallback, then validate the selected
  // documents against the same leaf the published search schema uses.
  const docs = data.results || data.documents || [];
  return SearchArtifactSchema.shape.documents
    .parse(docs)
    .filter((doc) => doc.type === "subnet");
}

describe("search quality (TS1 discovery)", () => {
  test("keyword search finds a subnet by its on-chain description", async () => {
    // Gittensor's chain description is "autonomous software development".
    const results = await keywordSearch("software development");
    assert.ok(
      results.some((doc) => doc.netuid === 74),
      "expected gittensor (74) for 'software development'",
    );
  });

  test("a capability query surfaces the subnet that advertises it", async () => {
    // SN95's chain description is a "Heterogeneous inference network".
    const results = await keywordSearch("inference");
    assert.ok(results.length > 0, "expected matches for 'inference'");
    assert.ok(
      results.some((doc) => doc.netuid === 95),
      "expected the inference-network subnet (95) for 'inference'",
    );
  });
});

describe("search corpus invariants", () => {
  const subnetDocs = (search.documents as Row[]).filter(
    (doc: Row) => doc.type === "subnet",
  );
  const subnets = subnetsArtifact.subnets;

  test("subnets with a description expose it as the search subtitle", () => {
    // The served subtitle is the *cleaned* description. Junk stubs some
    // deprecated subnets carry on-chain ("deprecated" on sn3/39/81) are filtered
    // to null by the build (cleanDescription) and fall back to the symbol, so we
    // reuse that same function to (a) exclude them and (b) compare against the
    // value the build would actually emit — keeping test + build in lockstep.
    const described = subnets
      .map((subnet: Row) => ({
        subnet,
        description: cleanDescription(subnet.description),
      }))
      .filter((entry: Row) => entry.description);
    assert.ok(
      described.length > 50,
      "expected many subnets to carry descriptions",
    );
    for (const { subnet, description } of described) {
      const doc = subnetDocs.find(
        (entry: Row) => entry.netuid === subnet.netuid,
      );
      assert.equal(
        doc!.subtitle,
        description,
        `subnet ${subnet.netuid} subtitle should be its cleaned description`,
      );
      assert.ok(
        !/^SN\d+\s/.test(doc!.subtitle),
        `subnet ${subnet.netuid} still has a placeholder subtitle`,
      );
    }
  });

  test("no subnet search tokens are URL fragments", () => {
    // Unambiguously-structural URL debris (the logo/website-URL shredding bug).
    // Short tokens like "io"/"com" are excluded — they legitimately occur in
    // product names (e.g. subnet 51 is literally named "lium.io").
    const urlJunk = new Set([
      "https",
      "http",
      "www",
      "githubusercontent",
      "amazonaws",
      "cloudfront",
      "avatars",
    ]);
    for (const doc of subnetDocs) {
      for (const token of doc.tokens) {
        assert.ok(
          !urlJunk.has(token),
          `subnet ${doc.netuid} token corpus contains URL fragment "${token}"`,
        );
      }
    }
  });
});

describe("registry lifecycle truth (TS4)", () => {
  const subnets = subnetsArtifact.subnets as Row[];
  const nativeByNetuid = new Map<number, Row>(
    (nativeSnapshot.subnets as Row[]).map((subnet): [number, Row] => [
      subnet.netuid,
      subnet,
    ]),
  );

  test("every subnet carries a valid lifecycle", () => {
    const valid = new Set(["active", "deprecated", "parked", "pending"]);
    for (const subnet of subnets) {
      assert.ok(
        valid.has(subnet.lifecycle),
        `subnet ${subnet.netuid} has invalid lifecycle "${subnet.lifecycle}"`,
      );
    }
  });

  test("artifact lifecycle follows the current captured identity, independently of registration status", () => {
    // A netuid can keep its registration while its owner changes the identity
    // from pending to a live product. Compare with the exact native capture
    // the build consumes, rather than pinning a netuid to a past identity.
    assert.ok(subnets.length > 0, "expected captured subnets to validate");
    for (const subnet of subnets) {
      const native = nativeByNetuid.get(subnet.netuid);
      assert.ok(
        native,
        `subnet ${subnet.netuid} has no captured native identity`,
      );
      assert.equal(
        subnet.lifecycle,
        subnetLifecycle(native),
        `subnet ${subnet.netuid} lifecycle must follow its captured identity`,
      );
      assert.equal(
        subnet.status,
        native.status,
        `subnet ${subnet.netuid} status must preserve chain registration`,
      );
    }
  });

  test("registered deprecated, parked and pending identities stay distinct from active products", () => {
    // Explicit fixtures keep every lifecycle covered even when a fresh network
    // capture contains no pending products. Registration is active in all cases.
    for (const [name, lifecycle] of [
      ["deprecated", "deprecated"],
      ["Parked", "parked"],
      ["pending...", "pending"],
      ["Cathedral", "active"],
      ["Pending Rewards", "active"],
    ]) {
      const native = {
        status: "active",
        chain_identity: {
          subnet_name: name,
          description: "patent pending; not deprecated",
        },
      };
      assert.equal(subnetLifecycle(native), lifecycle, name);
      assert.equal(native.status, "active", name);
    }
  });

  test("a registered pending subnet becomes active when its identity changes", () => {
    // Synthetic before/after captures of the same netuid reproduce the stale
    // pending assumption without claiming that its current identity is fixed.
    const pending = {
      netuid: 94,
      status: "active",
      chain_identity: { subnet_name: "pending..." },
    };
    const named = { ...pending, chain_identity: { subnet_name: "Cathedral" } };
    assert.equal(subnetLifecycle(pending), "pending");
    assert.equal(subnetLifecycle(named), "active");
    assert.equal(named.netuid, pending.netuid);
    assert.equal(named.status, "active");
  });
});
