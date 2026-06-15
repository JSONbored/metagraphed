import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { handleRequest } from "../workers/api.mjs";
import {
  cleanDescription,
  createLocalArtifactEnv,
  readJson,
  repoRoot,
} from "../scripts/lib.mjs";

// search.json is R2-tier (built to dist/), with a public/ fallback.
function loadArtifact(relative) {
  const candidates = [
    path.join(repoRoot, "dist/metagraph-r2/metagraph", relative),
    path.join(repoRoot, "public/metagraph", relative),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  return readJson(file);
}

const search = await loadArtifact("search.json");
const subnetsArtifact = await loadArtifact("subnets.json");

// Semantic invariants for the discovery layer (TS1/TS5): the search corpus must
// carry real subnet descriptions and must NOT be polluted by URL-fragment
// tokens — the regression that made "which subnet does X" unanswerable.

const env = createLocalArtifactEnv();

async function keywordSearch(query, limit = 5) {
  const res = await handleRequest(
    new Request(
      `https://api.metagraph.sh/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
    env,
    {},
  );
  const body = await res.json();
  const docs = body.data.results || body.data.documents || [];
  return docs.filter((doc) => doc.type === "subnet");
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
  const subnetDocs = search.documents.filter((doc) => doc.type === "subnet");
  const subnets = subnetsArtifact.subnets;

  test("subnets with a description expose it as the search subtitle", () => {
    // The served subtitle is the *cleaned* description. Junk stubs some
    // deprecated subnets carry on-chain ("deprecated" on sn3/39/81) are filtered
    // to null by the build (cleanDescription) and fall back to the symbol, so we
    // reuse that same function to (a) exclude them and (b) compare against the
    // value the build would actually emit — keeping test + build in lockstep.
    const described = subnets
      .map((subnet) => ({
        subnet,
        description: cleanDescription(subnet.description),
      }))
      .filter((entry) => entry.description);
    assert.ok(
      described.length > 50,
      "expected many subnets to carry descriptions",
    );
    for (const { subnet, description } of described) {
      const doc = subnetDocs.find((entry) => entry.netuid === subnet.netuid);
      assert.equal(
        doc.subtitle,
        description,
        `subnet ${subnet.netuid} subtitle should be its cleaned description`,
      );
      assert.ok(
        !/^SN\d+\s/.test(doc.subtitle),
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
  const subnets = subnetsArtifact.subnets;
  const byNetuid = new Map(subnets.map((subnet) => [subnet.netuid, subnet]));

  test("every subnet carries a valid lifecycle", () => {
    const valid = new Set(["active", "deprecated", "parked", "pending"]);
    for (const subnet of subnets) {
      assert.ok(
        valid.has(subnet.lifecycle),
        `subnet ${subnet.netuid} has invalid lifecycle "${subnet.lifecycle}"`,
      );
    }
  });

  test("chain-deprecated/parked/pending subnets are not reported as live", () => {
    // netuids 3/39/81 are chain-deprecated, 73 Parked, 58 Pending — they must
    // NOT carry lifecycle "active" (the bug: shown as active).
    for (const netuid of [3, 39, 81]) {
      assert.equal(byNetuid.get(netuid)?.lifecycle, "deprecated");
    }
    assert.equal(byNetuid.get(73)?.lifecycle, "parked");
    assert.equal(byNetuid.get(58)?.lifecycle, "pending");
  });

  test("lifecycle is distinct from chain-registration status", () => {
    // status stays the chain-registration truth ("active"); lifecycle carries
    // the team's declared state.
    const deprecated = byNetuid.get(3);
    assert.equal(deprecated.lifecycle, "deprecated");
    assert.equal(deprecated.status, "active");
  });
});
