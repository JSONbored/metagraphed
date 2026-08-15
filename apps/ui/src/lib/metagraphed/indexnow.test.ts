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
