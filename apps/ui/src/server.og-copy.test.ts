import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OG_SECTIONS, ogCardCopy } from "./server";

describe("OG card copy coverage (#8489)", () => {
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
    expect(copy.title).toBe("Agents");
    expect(copy.eyebrow).toBe("Agents");
    expect(copy.subtitle).toMatch(/agent/i);
  });

  it("tolerates a trailing slash", () => {
    expect(ogCardCopy("/agents/")).toEqual(ogCardCopy("/agents"));
  });

  it("keeps the brand card for the home route", () => {
    expect(ogCardCopy("/")).toEqual({ title: "Metagraphed" });
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
      "/portfolio", // retired -> redirects into /accounts (#8252)
    ]);

    const paths = fs
      .readdirSync(routesDir)
      // `.test.tsx` files live in routes/ but are not routes — TanStack Router
      // skips them too (it warns "does not export a Route"). Without this they
      // are read as pathnames: #8621's ChainHeadTip test landed here as
      // "/index-page-chain-head-tip/render/test", which turned main red the
      // moment #8605 (this guard) and #8621 (that file) were both merged.
      .filter(
        (f) =>
          f.endsWith(".tsx") && !f.includes(".test.") && !f.startsWith("-") && !f.startsWith("__"),
      )
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
