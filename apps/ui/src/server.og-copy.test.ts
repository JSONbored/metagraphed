import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OG_SECTIONS, ogCardCopy } from "./server";

describe("OG card copy coverage (#8489)", () => {
  it("gives the homepage explicit explorer copy while unknown paths stay conservative", () => {
    expect(ogCardCopy("/")).toEqual({
      title: "Bittensor, measured.",
      subtitle: "Explore the chain, subnets and public interfaces.",
      eyebrow: "Explorer",
    });
    expect(ogCardCopy("/not-a-real-route")).toEqual({ title: "Metagraphed" });
  });

  it("names entity detail pages from the path, with an eyebrow", () => {
    expect(ogCardCopy("/subnets/64")).toMatchObject({ title: "Subnet 64", eyebrow: "Subnet" });
    expect(ogCardCopy("/validators/5Grwva")).toMatchObject({ eyebrow: "Validator" });
    expect(ogCardCopy("/accounts/5Grwva")).toMatchObject({ eyebrow: "Account" });
    expect(ogCardCopy("/providers/latent")).toMatchObject({
      title: "latent",
      eyebrow: "Provider",
    });
  });

  it("names block and extrinsic detail pages, formatting the height", () => {
    expect(ogCardCopy("/blocks/8725436")).toMatchObject({
      title: "Block 8,725,436",
      eyebrow: "Block",
    });
    // A hash ref is truncated rather than mangled by the number formatter.
    expect(ogCardCopy("/blocks/0xabcdef1234567890abcdef")).toMatchObject({ eyebrow: "Block" });
    expect(ogCardCopy("/extrinsics/0xdeadbeefdeadbeefdead")).toMatchObject({
      eyebrow: "Extrinsic",
    });
  });

  it("gives /agents real copy — the exact route that unfurled as the home page", () => {
    const copy = ogCardCopy("/agents");
    expect(copy.title).toBe("Bittensor in a box");
    expect(copy.eyebrow).toBe("Agents");
    expect(copy.accent).toBe("agent");
    expect(copy.subtitle).toBe("Subnets, native APIs and chain data. One MCP.");
    expect(ogCardCopy("/subnets").accent).toBeUndefined();
    expect(ogCardCopy("/docs").accent).toBeUndefined();
  });

  it("describes the current directory, settings and comparison scope", () => {
    expect(ogCardCopy("/validators").subtitle).toBe(
      "Validator hotkeys, declared identities, observed take and subnet memberships",
    );
    expect(ogCardCopy("/settings")).toMatchObject({
      title: "Settings",
      subtitle: "Appearance, watchlists, alerts and developer access",
    });
    expect(ogCardCopy("/compare").subtitle).toContain("individual validator hotkeys");
    expect(ogCardCopy("/validators").subtitle).not.toMatch(/stake|apy|yield|return/i);
  });

  it("tolerates a trailing slash", () => {
    expect(ogCardCopy("/agents/")).toEqual(ogCardCopy("/agents"));
  });

  it("every section entry carries a subtitle and an eyebrow", () => {
    for (const [route, copy] of Object.entries(OG_SECTIONS)) {
      expect(copy.title, route).toBeTruthy();
      expect(copy.subtitle, route).toBeTruthy();
      expect(copy.eyebrow, route).toBeTruthy();
    }
  });

  // The guard that makes this stay true: a new route added without OG copy
  // fails here rather than silently unfurling as the generic brand card.
  it("covers every real top-level route", () => {
    const routesDir = path.join(import.meta.dirname, "routes");
    const ALLOW_GENERIC = new Set([
      "/", // home: the brand card IS the right card
      "/design/primitives", // internal design harness, never shared
    ]);

    const paths = fs
      .readdirSync(routesDir)
      // `.test.tsx` files live in routes/ but are not routes — TanStack Router
      // skips them too (it warns "does not export a Route"). Without this they
      // are read as pathnames: #8621's ChainHeadTip test landed here as
      // "/index-page-chain-head-tip/render/test" and failed this guard.
      .filter(
        (f) =>
          f.endsWith(".tsx") && !f.includes(".test.") && !f.startsWith("-") && !f.startsWith("__"),
      )
      // #11287: a route with no `component` RENDERS NOTHING -- it only throws a
      // redirect, so no HTML is produced and there is no card to give it OG
      // copy for. There are 19 of them (every retired route, plus the
      // /graphql, /tools and /design container segments), and listing them by
      // hand is how this guard turns into an exemption list that hides what it
      // names. Derived from the file instead: `component` present or absent is
      // structural, and every one of the 27 routes that does render declares it.
      .filter((f) => /\bcomponent\s*[:,]/.test(fs.readFileSync(path.join(routesDir, f), "utf8")))
      .map((f) => f.replace(/\.tsx$/, ""))
      // Route-file naming -> pathname; skip param and splat segments, which are
      // handled by the regex branches above, not the exact-path map.
      .filter((n) => !n.includes("$"))
      .map((n) => "/" + n.replace(/\.index$/, "").replace(/\./g, "/"))
      .map((p) => (p === "/index" ? "/" : p));

    const generic = paths.filter(
      (p) => !ALLOW_GENERIC.has(p) && ogCardCopy(p).title === "Metagraphed",
    );
    expect(generic, `routes with no OG copy: ${generic.join(", ")}`).toEqual([]);
  });
});

// The sitemap and the subnet hub both derive "every subnet" from one page of
// the registry. If they fetch DIFFERENT page sizes they are two different
// requests, and two different requests can produce two different answers.
//
// They did. The sitemap hard-coded `?limit=500` while the hub used
// SUBNETS_ALL_LIMIT; in production both exceeded the ~128 subnets that exist,
// so they agreed by accident. Under the hermetic e2e stub -- which indexes
// recordings by exact URL and falls back to the bare pathname -- the two query
// strings resolved to two different recorded payloads, and a category sitting
// exactly on the threshold appeared in the sitemap while going unlinked from
// the hub. That is precisely the unreachable-subtree defect #11266 fixed for
// /news, reintroduced through a query parameter.
//
// #11613 retired the category pages into a filter on /subnets, so the sitemap
// no longer derives a category set at all and the hub no longer links one.
// What survives is the half that caused the divergence: the sitemap's own
// request must name the shared constant rather than a literal, because a
// literal is how the two silently became different requests in the first place.
describe("the sitemap asks for 'every subnet' the way every other surface does", () => {
  const serverSource = fs.readFileSync(path.join(import.meta.dirname, "server.ts"), "utf8");

  it("the sitemap fetches subnets with the shared limit, not a literal", () => {
    expect(serverSource).toContain("limit=${SUBNETS_ALL_LIMIT}");
    // A literal here is the regression: it makes this a second, silently
    // different request from the one the page makes.
    expect(serverSource).not.toMatch(/\/api\/v1\/subnets\?limit=\d+/);
  });
});

// The server half and the client half of the app must resolve the SAME data
// host. server.ts fetched the sitemap's data from API_ORIGIN -- the canonical
// constant -- while the client used the build-time override, so under the
// hermetic e2e stub the sitemap read live production and the page read the
// fixture. They disagreed about `/subnets/category/privacy` (exactly 3 subnets
// live, the threshold; 0 in the fixture) and no application change could
// reconcile them, because one side was not testing this build at all.
describe("the sitemap fetches data from the configured host, not the canonical one", () => {
  const serverSource = fs.readFileSync(path.join(import.meta.dirname, "server.ts"), "utf8");

  it("every /api/v1 data fetch uses API_DATA_ORIGIN", () => {
    const canonicalDataFetches = [
      ...serverSource.matchAll(/fetch\(`\$\{API_ORIGIN\}\/api\/v1[^`]*`/g),
    ].map((m) => m[0]);
    expect(canonicalDataFetches).toEqual([]);
  });

  it("still uses the canonical origin where canonicality is the point", () => {
    // The apex /metagraph/* proxy must reach the host that actually serves it
    // (#11204), and discovery Link headers must name the real API host — those
    // are correct uses and this test must not push them onto the override.
    expect(serverSource).toContain("API_ORIGIN");
    expect(serverSource).toContain('rel="api-catalog"');
  });
});
