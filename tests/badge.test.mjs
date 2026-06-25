import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleBadgeRequest,
  renderBadge,
  scoreColor,
  gradeColor,
  parseBadgePath,
  parseBadgeOptions,
  formatUptimePercent,
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

// Fake reliability loader keyed by the set of netuids it's asked to score —
// stands in for the live D1 surface_uptime_daily rollup (loadReliabilityAggregate).
function makeLoadReliability(byNetuids) {
  return ({ netuids }) =>
    Promise.resolve(
      byNetuids[[...netuids].sort((a, b) => a - b).join(",")] ?? null,
    );
}

const RELIABILITY = {
  7: { score: 99, grade: "A", uptime_ratio: 0.9983 }, // subnet 7
  3: { score: 100, grade: "A", uptime_ratio: 0.99996 }, // subnet 3: just under 1
  "7,12": { score: 88, grade: "D", uptime_ratio: 0.88 }, // provider datura
};

async function badge(pathname, { method = "GET" } = {}) {
  const url = new URL(`https://api.metagraph.sh${pathname}`);
  const res = await handleBadgeRequest(new Request(url, { method }), {}, url, {
    readArtifact: makeReadArtifact({
      "/metagraph/subnets.json": SUBNETS,
      "/metagraph/providers.json": PROVIDERS,
    }),
    loadReliability: makeLoadReliability(RELIABILITY),
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
    const svg = renderBadge('"><script>x</script>', "#000", { label: "a&b" });
    assert.ok(!svg.includes("<script>"));
    assert.match(svg, /&lt;script&gt;/);
    assert.match(svg, /a&amp;b/);
  });

  test("renderBadge label cap does not split a surrogate pair", () => {
    // 39 ASCII + a 2-code-unit emoji makes the emoji straddle the 40-unit cap.
    const label = "x".repeat(39) + "😀" + "yyyy";
    const svg = renderBadge("ok", "#2ea44f", { label });
    // No lone surrogate (high not followed by low, or low not preceded by high).
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(
      !loneSurrogate.test(svg),
      "SVG label must not contain a lone surrogate",
    );
  });

  test("renderBadge sizes emoji / CJK labels at least as wide as a capital", () => {
    // sanitizeLabel admits emoji, but textWidth used to size every non-ASCII
    // glyph at the 6.5px lowercase default — narrower than the 8px capital `W`,
    // so an emoji label clipped its own segment (#1650).
    const widthOf = (svg) => Number(svg.match(/width="(\d+)"/)[1]);
    const capW = widthOf(renderBadge("ok", "#000", { label: "W" }));
    const emoji = widthOf(renderBadge("ok", "#000", { label: "😀" }));
    const cjk = widthOf(renderBadge("ok", "#000", { label: "字" }));
    assert.ok(
      emoji >= capW,
      `emoji width ${emoji} should be >= W width ${capW}`,
    );
    assert.ok(cjk >= capW, `CJK width ${cjk} should be >= W width ${capW}`);
  });

  test("renderBadge style=flat-square drops the gradient + rounding", () => {
    const flat = renderBadge("92/100", "#2ea44f");
    assert.match(flat, /linearGradient/);
    assert.match(flat, /rx="3"/);
    const square = renderBadge("92/100", "#2ea44f", { style: "flat-square" });
    assert.ok(!square.includes("linearGradient"));
    assert.ok(!square.includes('fill="url(#s)"'));
    assert.match(square, /rx="0"/);
    // Still a valid two-segment badge with both text layers.
    assert.ok((square.match(/<text /g) || []).length === 4);
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

  test("gradeColor maps A–F to bands aligned with the grade cutoffs", () => {
    assert.equal(gradeColor("A"), "#2ea44f");
    assert.equal(gradeColor("B"), "#97ca00");
    assert.equal(gradeColor("C"), "#a4a61d");
    assert.equal(gradeColor("D"), "#dfb317");
    assert.equal(gradeColor("F"), "#e05d44");
    assert.equal(gradeColor(undefined), "#9f9f9f"); // unknown / no data
    assert.equal(gradeColor("Z"), "#9f9f9f");
  });

  test("parseBadgeOptions allow-lists metric/style + sanitizes label", () => {
    const sp = (q) => new URL(`https://x/?${q}`).searchParams;
    // metric: readiness default; uptime + reliability both map to reliability.
    assert.equal(parseBadgeOptions(sp("")).metric, "readiness");
    assert.equal(parseBadgeOptions(sp("metric=UPTIME")).metric, "reliability");
    assert.equal(
      parseBadgeOptions(sp("metric=reliability")).metric,
      "reliability",
    );
    assert.equal(parseBadgeOptions(sp("metric=GRADE")).metric, "grade");
    assert.equal(parseBadgeOptions(sp("metric=bogus")).metric, "readiness");
    // style: flat default; flat-square allowed; anything else → flat.
    assert.equal(parseBadgeOptions(sp("")).style, "flat");
    assert.equal(
      parseBadgeOptions(sp("style=flat-square")).style,
      "flat-square",
    );
    assert.equal(parseBadgeOptions(sp("style=plastic")).style, "flat");
    // label: default brand; override kept; control chars stripped; capped; blank→brand.
    assert.equal(parseBadgeOptions(sp("")).label, "metagraphed");
    assert.equal(parseBadgeOptions(sp("label=uptime")).label, "uptime");
    assert.equal(parseBadgeOptions(sp("label=a%09%00b")).label, "ab");
    assert.equal(
      parseBadgeOptions(sp("label=" + "x".repeat(60))).label.length,
      40,
    );
    assert.equal(parseBadgeOptions(sp("label=%20%20")).label, "metagraphed");
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

  test("badge response is CORS-open + keeps cache/nosniff", async () => {
    const { res } = await badge("/api/v1/subnets/7/badge.svg");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("cache-control"), /max-age=3600/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    // Headers are uniform across metric/entity (n/a included).
    const { res: na } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=uptime",
    );
    assert.equal(na.headers.get("access-control-allow-origin"), "*");
  });
});

describe("formatUptimePercent", () => {
  test("floors the ratio so a sub-100% value never reads 100% (#1721)", () => {
    assert.equal(formatUptimePercent(0.99996), "99.99%"); // not "100%"
    assert.equal(formatUptimePercent(0.999999), "99.99%");
    assert.equal(formatUptimePercent(1), "100%"); // only an exact 1
    assert.equal(formatUptimePercent(0.9983), "99.83%");
    assert.equal(formatUptimePercent(0.88), "88%");
    assert.equal(formatUptimePercent(0), "0%");
    assert.equal(formatUptimePercent(null), "0%"); // non-numeric → 0
  });
});

describe("badge — uptime / reliability metric", () => {
  test("subnet uptime renders the window % colored by the A grade", async () => {
    const { text } = await badge("/api/v1/subnets/7/badge.svg?metric=uptime");
    assert.match(text, /99\.83%/); // 0.9983 → trimmed percent
    assert.match(text, /#2ea44f/); // grade A → green
    assert.ok(!text.includes("/100")); // not the readiness rendering
  });

  test("a sub-100% ratio is floored, never rounded up to 100% (#1721)", async () => {
    const { text } = await badge("/api/v1/subnets/3/badge.svg?metric=uptime");
    // 0.99996 floors to 99.99% — the value must not overstate as a perfect 100%.
    assert.match(text, /aria-label="metagraphed: 99\.99%"/);
  });

  test("metric=reliability is an alias for uptime", async () => {
    const { text } = await badge(
      "/api/v1/subnets/7/badge.svg?metric=reliability",
    );
    assert.match(text, /99\.83%/);
  });

  test("provider uptime is the rollup across all its subnets (one query)", async () => {
    const { text } = await badge(
      "/api/v1/providers/datura/badge.svg?metric=uptime",
    );
    assert.match(text, /88%/); // 0.88 → "88%"
    assert.match(text, /#dfb317/); // grade D → yellow
  });

  test("unknown subnet uptime degrades to n/a (gray, still 200)", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=uptime",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
  });

  test("provider with no reliability data is n/a", async () => {
    const { text } = await badge(
      "/api/v1/providers/byid/badge.svg?metric=uptime",
    );
    assert.match(text, /n\/a/);
  });

  test("label override applies to the uptime variant too", async () => {
    const { text } = await badge(
      "/api/v1/subnets/7/badge.svg?metric=uptime&label=uptime",
    );
    assert.match(text, /aria-label="uptime: 99\.83%"/);
  });
});

describe("badge — grade metric", () => {
  test("subnet grade renders the A–F letter, colored by the grade band", async () => {
    const { text } = await badge("/api/v1/subnets/7/badge.svg?metric=grade");
    assert.match(text, /aria-label="metagraphed: A"/); // the letter itself
    assert.match(text, /#2ea44f/); // grade A → green
    assert.ok(!text.includes("99.83")); // not the uptime % rendering
    assert.ok(!text.includes("/100")); // not the readiness rendering
  });

  test("provider grade is the rollup grade across its subnets", async () => {
    const { text } = await badge(
      "/api/v1/providers/datura/badge.svg?metric=grade",
    );
    assert.match(text, /aria-label="metagraphed: D"/);
    assert.match(text, /#dfb317/); // grade D → yellow
  });

  test("unknown subnet grade degrades to n/a (gray, still 200)", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=grade",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
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
