import { describe, expect, it } from "vitest";

import { API_BASE } from "@/lib/metagraphed/config";
import { resolveEvidenceHref } from "./registry-empty";

describe("resolveEvidenceHref (#11204)", () => {
  it("sends an artifact path to the API host, not the apex", () => {
    // The defect: these rendered as apex links (metagraph.sh/metagraph/gaps.json),
    // which 404s — the artifacts have only ever been served from the API host.
    for (const path of ["/metagraph/gaps.json", "/metagraph/endpoints.json"]) {
      expect(resolveEvidenceHref(path)).toBe(`${API_BASE}${path}`);
    }
  });

  it("leaves an already-absolute href untouched", () => {
    // -design-primitives-page passes the repo URL through this same prop.
    const repo = "https://github.com/JSONbored/metagraphed";
    expect(resolveEvidenceHref(repo)).toBe(repo);
  });

  it("returns an href safeExternalUrl can parse", () => {
    // The reason the old code used a raw anchor: <ExternalLink> calls
    // `new URL(href)` with no base, so a relative path threw and rendered the
    // "blocked unsafe URL" fallback instead of a link.
    expect(() => new URL(resolveEvidenceHref("/metagraph/surfaces.json"))).not.toThrow();
  });
});
