import { describe, expect, it } from "vitest";

import {
  buildIndexNowPayload,
  INDEXNOW_MAX_URLS,
  urlForChangedPath,
  urlsForChangedPaths,
} from "./indexnow";

const ORIGIN = "https://metagraph.sh";

describe("urlForChangedPath — only files that ARE a page's content", () => {
  it("maps a docs MDX file to its page", () => {
    expect(urlForChangedPath("apps/ui/content/docs/economics.mdx", ORIGIN)).toBe(
      "https://metagraph.sh/docs/economics",
    );
    expect(urlForChangedPath("apps/ui/content/docs/api-reference/subnets/get.mdx", ORIGIN)).toBe(
      "https://metagraph.sh/docs/api-reference/subnets/get",
    );
  });

  it("maps a folder index to the folder's own URL, not /index", () => {
    expect(urlForChangedPath("apps/ui/content/docs/api-reference/subnets/index.mdx", ORIGIN)).toBe(
      "https://metagraph.sh/docs/api-reference/subnets",
    );
  });

  it("ignores files that change how a page renders but not what it says", () => {
    // Resubmitting all 129 subnets because a button moved is exactly the noise
    // this exists to avoid — IndexNow discounts hosts that submit unchanged
    // URLs, so a component edit must produce nothing.
    for (const path of [
      "apps/ui/src/routes/subnets.$netuid.tsx",
      "apps/ui/src/components/metagraphed/app-shell.tsx",
      "apps/ui/src/lib/metagraphed/og-card.ts",
      "package.json",
      "README.md",
    ]) {
      expect(urlForChangedPath(path, ORIGIN), path).toBeNull();
    }
  });
});

describe("urlsForChangedPaths", () => {
  it("resolves a changed subnet record through the file, not its name", () => {
    // Measured: the file is registry/subnets/apex.json, the API slug is "sn-1",
    // and the page is /subnets/1. None of the three matches the others, so the
    // netuid has to come from inside the file.
    expect(urlsForChangedPaths(["registry/subnets/apex.json"], ORIGIN, () => 1)).toStrictEqual([
      "https://metagraph.sh/subnets/1",
    ]);
  });

  it("skips a subnet whose netuid it cannot resolve rather than guessing", () => {
    // Submitting a URL that 404s is worse than submitting nothing. This is also
    // what a DELETED registry file does — there is no page left to refresh.
    expect(urlsForChangedPaths(["registry/subnets/gone.json"], ORIGIN, () => null)).toStrictEqual(
      [],
    );
    // And with no resolver supplied at all, rather than throwing.
    expect(urlsForChangedPaths(["registry/subnets/apex.json"], ORIGIN)).toStrictEqual([]);
  });

  it("resolves a changed provider record by slug, which IS its URL segment", () => {
    expect(urlsForChangedPaths(["registry/providers/404-gen.json"], ORIGIN)).toStrictEqual([
      "https://metagraph.sh/providers/404-gen",
    ]);
  });

  it("dedupes and sorts, so two pushes touching the same page submit it once", () => {
    const urls = urlsForChangedPaths(
      [
        "apps/ui/content/docs/mcp.mdx",
        "apps/ui/content/docs/mcp.mdx",
        "apps/ui/content/docs/economics.mdx",
      ],
      ORIGIN,
    );
    expect(urls).toStrictEqual([
      "https://metagraph.sh/docs/economics",
      "https://metagraph.sh/docs/mcp",
    ]);
  });

  it("returns nothing for a push that changed no page content", () => {
    // The common case, and a correct outcome rather than a failure.
    expect(
      urlsForChangedPaths(["src/mcp-server.ts", ".github/workflows/validate.yml"], ORIGIN),
    ).toStrictEqual([]);
  });
});

describe("buildIndexNowPayload", () => {
  it("states the key location so the key file can move later", () => {
    const payload = buildIndexNowPayload([`${ORIGIN}/docs/mcp`], ORIGIN, "abc123");
    expect(payload).toStrictEqual({
      host: "metagraph.sh",
      key: "abc123",
      keyLocation: "https://metagraph.sh/abc123.txt",
      urlList: ["https://metagraph.sh/docs/mcp"],
    });
  });

  it("drops URLs on any other host", () => {
    // IndexNow rejects a submission that mixes hosts, so one stray URL would
    // silently drop the whole batch rather than just itself.
    const payload = buildIndexNowPayload(
      [`${ORIGIN}/docs/mcp`, "https://api.metagraph.sh/api/v1/subnets", "not a url"],
      ORIGIN,
      "k",
    );
    expect(payload?.urlList).toStrictEqual(["https://metagraph.sh/docs/mcp"]);
  });

  it("returns null when nothing is submittable, so the caller can exit quietly", () => {
    expect(buildIndexNowPayload([], ORIGIN, "k")).toBeNull();
    expect(buildIndexNowPayload(["https://example.com/x"], ORIGIN, "k")).toBeNull();
  });

  it("caps at the protocol's 10,000-URL limit", () => {
    const many = Array.from(
      { length: INDEXNOW_MAX_URLS + 500 },
      (_, i) => `${ORIGIN}/subnets/${i}`,
    );
    expect(buildIndexNowPayload(many, ORIGIN, "k")?.urlList).toHaveLength(INDEXNOW_MAX_URLS);
  });
});

describe("news digests and new routes are announced too (#11348)", () => {
  const origin = "https://metagraph.sh";

  it("maps a weekly digest to its page", () => {
    // 285 pages this job never submitted: the path filter watched docs and the
    // registry, and the digests are neither — so the one family whose whole
    // value is being NEW was the family never announced.
    expect(urlForChangedPath("apps/ui/content/news/sn38/2026-w25.mdx", origin)).toBe(
      "https://metagraph.sh/news/sn38/2026-w25",
    );
  });

  it("maps a subject index to the folder, not to /index", () => {
    expect(urlForChangedPath("apps/ui/content/news/sn38/index.mdx", origin)).toBe(
      "https://metagraph.sh/news/sn38",
    );
  });

  it("maps a new static route to its URL", () => {
    // Shipping a route is exactly when a crawler most needs telling, and this
    // job was blind to it — /subnets/with-api had to be submitted by hand.
    expect(urlForChangedPath("apps/ui/src/routes/subnets.with-api.tsx", origin)).toBe(
      "https://metagraph.sh/subnets/with-api",
    );
    expect(urlForChangedPath("apps/ui/src/routes/apis.providers.tsx", origin)).toBe(
      "https://metagraph.sh/apis/providers",
    );
  });

  it("refuses to guess a URL it cannot know", () => {
    // A param route expands to as many URLs as there are values; a page
    // component is not a route at all; a test file is neither. Submitting a URL
    // that 404s is worse than submitting nothing.
    for (const path of [
      "apps/ui/src/routes/subnets.category.$slug.tsx",
      "apps/ui/src/routes/-subnets-index-page.tsx",
      "apps/ui/src/routes/docs.raw.$.test.ts",
      "apps/ui/src/routes/__root.tsx",
    ]) {
      expect(urlForChangedPath(path, origin), path).toBeNull();
    }
  });

  it("leaves the docs and registry rules untouched", () => {
    expect(urlForChangedPath("apps/ui/content/docs/economics.mdx", origin)).toBe(
      "https://metagraph.sh/docs/economics",
    );
  });
});
