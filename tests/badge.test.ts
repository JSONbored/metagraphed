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
} from "../src/badge.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { StorageReadResult } from "../workers/storage.ts";
import { mockEnv, type Row } from "./row-type.ts";

type ReadArtifact = (env: Env, path: string) => Promise<StorageReadResult>;

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
const PROFILES = {
  profiles: [
    { netuid: 7, completeness_score: 85 },
    { netuid: 12, completeness_score: 55 },
    { netuid: 3, completeness_score: 20 },
    // netuid 9 omitted → n/a
  ],
};

function makeReadArtifact(fixtures: Row) {
  return ((_env: Row, path: string) =>
    Promise.resolve(
      Object.prototype.hasOwnProperty.call(fixtures, path)
        ? { ok: true, data: fixtures[path] }
        : { ok: false, code: "artifact_not_found" },
    )) as unknown as ReadArtifact;
}

// Fake reliability loader keyed by the set of netuids it's asked to score —
// stands in for the live D1 surface_uptime_daily rollup (loadReliabilityAggregate).
function makeLoadReliability(byNetuids: Row) {
  return ({ netuids }: { netuids: number[] }) =>
    Promise.resolve(
      byNetuids[[...netuids].sort((a, b) => a - b).join(",")] ?? null,
    );
}

const RELIABILITY = {
  7: { score: 99, grade: "A", uptime_ratio: 0.9983 }, // subnet 7
  "7,12": { score: 88, grade: "D", uptime_ratio: 0.88 }, // provider datura
};

// Per-subnet surfaces artifacts for the apis metric. Callable kinds are
// subnet-api / openapi / sse / data-artifact; docs/website/etc. don't count.
const SURFACES = {
  "/metagraph/surfaces/7.json": {
    surfaces: [
      { kind: "subnet-api" },
      { kind: "openapi" },
      { kind: "docs" },
      { kind: "website" },
    ],
  }, // 2 callable
  "/metagraph/surfaces/12.json": { surfaces: [{ kind: "sse" }] }, // 1 callable
  "/metagraph/surfaces/3.json": { surfaces: [{ kind: "docs" }] }, // 0 callable
  // netuid 9 has no surfaces artifact → n/a
};

async function badge(
  pathname: string,
  { method = "GET", fixtures = {} }: { method?: string; fixtures?: Row } = {},
) {
  const url = new URL(`https://api.metagraph.sh${pathname}`);
  const res = await handleBadgeRequest(
    new Request(url, { method }),
    mockEnv(),
    url,
    {
      readArtifact: makeReadArtifact({
        "/metagraph/subnets.json": SUBNETS,
        "/metagraph/providers.json": PROVIDERS,
        "/metagraph/profiles.json": PROFILES,
        ...SURFACES,
        ...fixtures,
      }),
      loadReliability: makeLoadReliability(RELIABILITY),
    },
  );
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
    const widthOf = (svg: string) => Number(svg.match(/width="(\d+)"/)![1]);
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

  test("renderBadge flat + flat-square output is unchanged (regression)", () => {
    const flatGolden =
      '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="20" role="img" aria-label="metagraphed: 92/100">\n' +
      "<title>metagraphed: 92/100</title>\n" +
      '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>\n' +
      '<clipPath id="r"><rect width="144" height="20" rx="3" fill="#fff"/></clipPath>\n' +
      '<g clip-path="url(#r)">\n' +
      '<rect width="85" height="20" fill="#555"/>\n' +
      '<rect x="85" width="59" height="20" fill="#2ea44f"/>\n' +
      '<rect width="144" height="20" fill="url(#s)"/>\n' +
      "</g>\n" +
      '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">\n' +
      '<text x="42.5" y="15" fill="#010101" fill-opacity=".3">metagraphed</text>\n' +
      '<text x="42.5" y="14">metagraphed</text>\n' +
      '<text x="114.5" y="15" fill="#010101" fill-opacity=".3">92/100</text>\n' +
      '<text x="114.5" y="14">92/100</text>\n' +
      "</g>\n" +
      "</svg>\n";
    const squareGolden =
      '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="20" role="img" aria-label="metagraphed: 92/100">\n' +
      "<title>metagraphed: 92/100</title>\n" +
      '<clipPath id="r"><rect width="144" height="20" rx="0" fill="#fff"/></clipPath>\n' +
      '<g clip-path="url(#r)">\n' +
      '<rect width="85" height="20" fill="#555"/>\n' +
      '<rect x="85" width="59" height="20" fill="#2ea44f"/>\n' +
      "</g>\n" +
      '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">\n' +
      '<text x="42.5" y="15" fill="#010101" fill-opacity=".3">metagraphed</text>\n' +
      '<text x="42.5" y="14">metagraphed</text>\n' +
      '<text x="114.5" y="15" fill="#010101" fill-opacity=".3">92/100</text>\n' +
      '<text x="114.5" y="14">92/100</text>\n' +
      "</g>\n" +
      "</svg>\n";
    assert.equal(renderBadge("92/100", "#2ea44f"), flatGolden);
    assert.equal(
      renderBadge("92/100", "#2ea44f", { style: "flat-square" }),
      squareGolden,
    );
  });

  test("renderBadge style=for-the-badge is taller, uppercase, bold, and matte", () => {
    const svg = renderBadge("92/100", "#2ea44f", { style: "for-the-badge" });
    assert.match(svg, /height="28"/);
    assert.match(svg, /font-weight="bold"/);
    assert.match(svg, /font-size="10"/);
    assert.match(svg, /rx="0"/);
    assert.ok(!svg.includes("linearGradient"));
    assert.match(svg, /aria-label="METAGRAPHED: 92\/100"/);
    assert.match(svg, />METAGRAPHED</);
    assert.match(svg, />92\/100</);
    assert.match(svg, /textLength="\d+"/);
    assert.match(svg, /lengthAdjust="spacing"/);
    assert.ok((svg.match(/<text /g) || []).length === 2);
  });

  test("renderBadge for-the-badge uppercases mixed-case labels", () => {
    const svg = renderBadge("ok", "#2ea44f", {
      style: "for-the-badge",
      label: "My Label",
    });
    assert.match(svg, /aria-label="MY LABEL: OK"/);
  });

  test("renderBadge for-the-badge width branches cover narrow, wide, CJK, and accented glyphs", () => {
    const widthOf = (svg: string) => Number(svg.match(/width="(\d+)"/)![1]);
    const narrow = widthOf(
      renderBadge(".", "#000", { style: "for-the-badge", label: "." }),
    );
    const wide = widthOf(
      renderBadge("@", "#000", { style: "for-the-badge", label: "@" }),
    );
    const punct = widthOf(
      renderBadge("-", "#000", { style: "for-the-badge", label: "-" }),
    );
    const cjk = widthOf(
      renderBadge("字", "#000", { style: "for-the-badge", label: "字" }),
    );
    const accent = widthOf(
      renderBadge("é", "#000", { style: "for-the-badge", label: "é" }),
    );
    assert.ok(wide > narrow, "MW%@ glyphs should out-measure narrow ilj");
    assert.ok(
      punct > narrow,
      "punctuation should use the lowercase-width branch",
    );
    assert.ok(cjk >= wide, "CJK should use the wide code-point branch");
    assert.ok(
      accent >= narrow,
      "accented Latin should use the non-ASCII branch",
    );
  });

  test("renderBadge for-the-badge escapes injected markup", () => {
    const svg = renderBadge('"><x', "#000", {
      style: "for-the-badge",
      label: "a&b",
    });
    assert.ok(!svg.includes("<x>"));
    assert.match(svg, /&lt;X/);
    assert.match(svg, /A&amp;B/);
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
    const sp = (q: string) => new URL(`https://x/?${q}`).searchParams;
    // metric: readiness default; uptime + reliability both map to reliability.
    assert.equal(parseBadgeOptions(sp("")).metric, "readiness");
    assert.equal(parseBadgeOptions(sp("metric=UPTIME")).metric, "reliability");
    assert.equal(
      parseBadgeOptions(sp("metric=reliability")).metric,
      "reliability",
    );
    assert.equal(parseBadgeOptions(sp("metric=GRADE")).metric, "grade");
    assert.equal(parseBadgeOptions(sp("metric=APIS")).metric, "apis");
    assert.equal(
      parseBadgeOptions(sp("metric=COMPLETENESS")).metric,
      "completeness",
    );
    assert.equal(
      parseBadgeOptions(sp("metric=coverage")).metric,
      "completeness",
    );
    assert.equal(parseBadgeOptions(sp("metric=bogus")).metric, "readiness");
    // style: flat default; flat-square allowed; anything else → flat.
    assert.equal(parseBadgeOptions(sp("")).style, "flat");
    assert.equal(
      parseBadgeOptions(sp("style=flat-square")).style,
      "flat-square",
    );
    assert.equal(
      parseBadgeOptions(sp("style=for-the-badge")).style,
      "for-the-badge",
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
    assert.match(res.headers.get("content-type")!, /image\/svg\+xml/);
    assert.match(res.headers.get("cache-control")!, /max-age=3600/);
    assert.match(text, /92\/100/);
    assert.match(text, /#2ea44f/); // green (>= 80)
  });

  test("style=for-the-badge renders through handleBadgeRequest", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/7/badge.svg?style=for-the-badge",
    );
    assert.equal(res.status, 200);
    assert.match(text, /height="28"/);
    assert.match(text, /92\/100/);
    assert.match(text, /METAGRAPHED/);
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
    assert.match(res.headers.get("content-type")!, /image\/svg\+xml/);
    assert.equal(text, "");
  });

  test("badge response is CORS-open + keeps cache/nosniff", async () => {
    const { res } = await badge("/api/v1/subnets/7/badge.svg");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("cache-control")!, /max-age=3600/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    // Headers are uniform across metric/entity (n/a included).
    const { res: na } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=uptime",
    );
    assert.equal(na.headers.get("access-control-allow-origin"), "*");
  });
});

describe("badge — uptime / reliability metric", () => {
  test("subnet uptime renders the window % colored by the A grade", async () => {
    const { text } = await badge("/api/v1/subnets/7/badge.svg?metric=uptime");
    assert.match(text, /99\.83%/); // 0.9983 → trimmed percent
    assert.match(text, /#2ea44f/); // grade A → green
    assert.ok(!text.includes("/100")); // not the readiness rendering
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

  test("provider uptime is n/a when only some subnets have in-window uptime rows", async () => {
    const url = new URL(
      "https://api.metagraph.sh/api/v1/providers/partial/badge.svg?metric=uptime",
    );
    const res = await handleBadgeRequest(new Request(url), mockEnv(), url, {
      readArtifact: makeReadArtifact({
        "/metagraph/providers.json": {
          providers: [{ slug: "partial", netuids: [7, 9] }],
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /n\/a/);
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

describe("badge — apis metric", () => {
  test("subnet apis counts only callable surface kinds, informational blue", async () => {
    const { text } = await badge("/api/v1/subnets/7/badge.svg?metric=apis");
    // surfaces/7 = subnet-api + openapi (callable) + docs + website (not) → 2
    assert.match(text, /aria-label="metagraphed: 2 apis"/);
    assert.match(text, /#007ec6/); // informational blue for >0
    assert.ok(!text.includes("/100")); // not the readiness rendering
  });

  test("singular 'api' when exactly one callable surface", async () => {
    const { text } = await badge("/api/v1/subnets/12/badge.svg?metric=apis");
    assert.match(text, /aria-label="metagraphed: 1 api"/);
    assert.match(text, /#007ec6/);
  });

  test("zero callable surfaces renders '0 apis' in gray", async () => {
    const { text } = await badge("/api/v1/subnets/3/badge.svg?metric=apis");
    assert.match(text, /aria-label="metagraphed: 0 apis"/);
    assert.match(text, /#9f9f9f/); // gray for none
  });

  test("provider apis sums callable surfaces across its subnets", async () => {
    const { text } = await badge(
      "/api/v1/providers/datura/badge.svg?metric=apis",
    );
    // datura = netuids [7, 12] → 2 + 1 = 3
    assert.match(text, /aria-label="metagraphed: 3 apis"/);
    assert.match(text, /#007ec6/);
  });

  test("a subnet with no surfaces artifact degrades to n/a (still 200)", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/9/badge.svg?metric=apis",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
  });

  test("unknown subnet apis degrades to n/a (gray, still 200)", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=apis",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
  });

  test("unknown provider apis degrades to n/a", async () => {
    const { res, text } = await badge(
      "/api/v1/providers/nobody/badge.svg?metric=apis",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
  });

  test("provider with empty netuids is n/a", async () => {
    const { text } = await badge(
      "/api/v1/providers/empty/badge.svg?metric=apis",
      {
        fixtures: {
          "/metagraph/providers.json": {
            providers: [{ slug: "empty", netuids: [] }],
          },
        },
      },
    );
    assert.match(text, /n\/a/);
  });

  test("provider with no surfaces artifacts is n/a", async () => {
    const { text } = await badge(
      "/api/v1/providers/byid/badge.svg?metric=apis",
    );
    assert.match(text, /n\/a/);
  });

  test("apis metric survives a readArtifact throw (readData catch)", async () => {
    const url = new URL(
      "https://api.metagraph.sh/api/v1/subnets/7/badge.svg?metric=apis",
    );
    const res = await handleBadgeRequest(new Request(url), mockEnv(), url, {
      readArtifact: () => {
        throw new Error("artifact read failed");
      },
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /n\/a/);
  });
});

describe("badge — completeness metric", () => {
  test("subnet completeness renders the profile score + score color", async () => {
    const { text } = await badge(
      "/api/v1/subnets/7/badge.svg?metric=completeness",
    );
    assert.match(text, /85\/100/);
    assert.match(text, /#2ea44f/); // green (>= 80)
    assert.ok(!text.includes("92/100")); // not the readiness rendering
  });

  test("metric=coverage is an alias for completeness", async () => {
    const { text } = await badge("/api/v1/subnets/7/badge.svg?metric=coverage");
    assert.match(text, /85\/100/);
  });

  test("a low completeness score gets the red color", async () => {
    const { text } = await badge(
      "/api/v1/subnets/3/badge.svg?metric=completeness",
    );
    assert.match(text, /20\/100/);
    assert.match(text, /#e05d44/);
  });

  test("provider completeness is the mean across its subnets", async () => {
    const { text } = await badge(
      "/api/v1/providers/datura/badge.svg?metric=completeness",
    );
    assert.match(text, /70\/100/); // round(mean(85, 55))
    assert.match(text, /#dfb317/); // amber (50..79)
  });

  test("unknown subnet completeness degrades to n/a (gray, still 200)", async () => {
    const { res, text } = await badge(
      "/api/v1/subnets/999/badge.svg?metric=completeness",
    );
    assert.equal(res.status, 200);
    assert.match(text, /n\/a/);
    assert.match(text, /#9f9f9f/);
  });

  test("a subnet with no profile row is n/a", async () => {
    const { text } = await badge(
      "/api/v1/subnets/9/badge.svg?metric=completeness",
    );
    assert.match(text, /n\/a/);
  });

  test("provider with only scoreless subnets is n/a", async () => {
    const { text } = await badge(
      "/api/v1/providers/byid/badge.svg?metric=completeness",
    );
    assert.match(text, /n\/a/);
  });
});

describe("badge — Worker dispatch integration", () => {
  test("handleRequest routes /api/v1/subnets/{netuid}/badge.svg to a badge", async () => {
    const env = createLocalArtifactEnv();
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/badge.svg"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /image\/svg\+xml/);
    assert.match(await res.text(), /<svg /);
  });
});

describe("badge — formatUptimePercent", () => {
  test("documented contract: trims to two decimals", () => {
    assert.equal(formatUptimePercent(0.9983), "99.83%");
    assert.equal(formatUptimePercent(0.5), "50%");
    assert.equal(formatUptimePercent(0), "0%");
  });

  test("only an exact full ratio renders 100%", () => {
    assert.equal(formatUptimePercent(1), "100%");
  });

  test("a sub-1 ratio never rounds up to a perfect 100% (#1721)", () => {
    assert.equal(formatUptimePercent(0.99996), "99.99%");
    assert.equal(formatUptimePercent(0.99995), "99.99%");
    assert.equal(formatUptimePercent(0.999999), "99.99%");
  });

  test("a non-numeric ratio degrades to 0%", () => {
    assert.equal(formatUptimePercent(undefined), "0%");
    assert.equal(formatUptimePercent(NaN), "0%");
  });
});
