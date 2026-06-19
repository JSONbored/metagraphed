import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleBadgeRequest,
  renderBadge,
  scoreColor,
  parseBadgePath,
} from "../src/badge.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const SUBNETS = {
  subnets: [
    { netuid: 7, integration_readiness: 92 },
    { netuid: 12, integration_readiness: 40 },
    { netuid: 3, integration_readiness: 0 },
    { netuid: 9 }, // no score
  ],
};
const PROVIDERS = {
  providers: [
    { slug: "datura", netuids: [7, 12] }, // mean(92,40) = 66
    { id: "byid", netuids: [9] }, // only a scoreless subnet → n/a
  ],
};

function makeReadArtifact(fixtures) {
  return (_env, path) =>
    Promise.resolve(
      Object.prototype.hasOwnProperty.call(fixtures, path)
        ? { ok: true, data: fixtures[path] }
        : { ok: false, code: "artifact_not_found" },
    );
}

async function badge(pathname, { method = "GET" } = {}) {
  const url = new URL(`https://api.metagraph.sh${pathname}`);
  const res = await handleBadgeRequest(new Request(url, { method }), {}, url, {
    readArtifact: makeReadArtifact({
      "/metagraph/subnets.json": SUBNETS,
      "/metagraph/providers.json": PROVIDERS,
    }),
  });
  return { res, text: await res.text() };
}

describe("badge — rendering", () => {
  test("renderBadge produces a valid two-segment SVG with the message", () => {
    const svg = renderBadge("92/100", "#2ea44f");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="metagraphed: 92\/100"/);
    assert.match(svg, /fill="#2ea44f"/);
    assert.ok((svg.match(/<text /g) || []).length === 4); // label + msg, each w/ shadow
  });

  test("renderBadge escapes message + label (SVG injection-safe)", () => {
    const svg = renderBadge('"><script>x</script>', "#000", "a&b");
    assert.ok(!svg.includes("<script>"));
    assert.match(svg, /&lt;script&gt;/);
    assert.match(svg, /a&amp;b/);
  });

  test("scoreColor thresholds (green / amber / red / gray)", () => {
    assert.equal(scoreColor(92), "#2ea44f");
    assert.equal(scoreColor(80), "#2ea44f");
    assert.equal(scoreColor(50), "#dfb317");
    assert.equal(scoreColor(49), "#e05d44");
    assert.equal(scoreColor(0), "#e05d44");
    assert.equal(scoreColor(null), "#9f9f9f");
    assert.equal(scoreColor(NaN), "#9f9f9f");
  });

  test("parseBadgePath resolves subnet/provider + rejects others", () => {
    assert.deepEqual(parseBadgePath("/api/v1/subnets/7/badge.svg"), {
      kind: "subnet",
      netuid: 7,
    });
    assert.deepEqual(parseBadgePath("/api/v1/providers/Datura/badge.svg"), {
      kind: "provider",
      slug: "datura",
    });
    assert.equal(parseBadgePath("/api/v1/subnets/7"), null);
    assert.equal(parseBadgePath("/api/v1/subnets/abc/badge.svg"), null);
  });
});

describe("badge — handleBadgeRequest", () => {
  test("subnet badge shows the real score + score color + svg headers", async () => {
    const { res, text } = await badge("/api/v1/subnets/7/badge.svg");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(res.headers.get("cache-control"), /max-age=3600/);
    assert.match(text, /92\/100/);
    assert.match(text, /#2ea44f/); // green (>= 80)
  });

  test("a low score gets the red color", async () => {
    const { text } = await badge("/api/v1/subnets/3/badge.svg");
    assert.match(text, /0\/100/);
    assert.match(text, /#e05d44/);
  });

  test("unknown subnet degrades to an n/a badge (still 200)", async () => {
    const { res, text } = await badge("/api/v1/subnets/999/badge.svg");
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
  });

  test("a subnet with no score is n/a", async () => {
    const { text } = await badge("/api/v1/subnets/9/badge.svg");
    assert.match(text, /n\/a/);
  });

  test("provider badge is the mean readiness across its subnets", async () => {
    const { text } = await badge("/api/v1/providers/datura/badge.svg");
    assert.match(text, /66\/100/); // round(mean(92, 40))
    assert.match(text, /#dfb317/); // amber (50..79)
  });

  test("provider with only scoreless subnets is n/a", async () => {
    const { text } = await badge("/api/v1/providers/byid/badge.svg");
    assert.match(text, /n\/a/);
  });

  test("HEAD returns headers with no body", async () => {
    const { res, text } = await badge("/api/v1/subnets/7/badge.svg", {
      method: "HEAD",
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    assert.equal(text, "");
  });
});

describe("badge — Worker dispatch integration", () => {
  test("handleRequest routes /api/v1/subnets/{netuid}/badge.svg to a badge", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/badge.svg"),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await res.text(), /<svg /);
  });
});
