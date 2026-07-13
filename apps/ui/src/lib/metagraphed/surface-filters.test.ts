import { describe, expect, it } from "vitest";

import { matchesSurfaceFilters, surfacesSearchSchema } from "./surface-filters";
import type { Surface } from "./types";

/** A fully-defaulted search, so each test overrides only the field under test. */
function search(overrides: Record<string, unknown> = {}) {
  return surfacesSearchSchema.parse(overrides);
}

function surface(overrides: Partial<Surface> = {}): Surface {
  return { id: "srf-1", name: "Example API", kind: "api", ...overrides };
}

describe("surfacesSearchSchema", () => {
  it("defaults the three shortcut params to empty strings", () => {
    const s = search();
    expect(s.public_safe).toBe("");
    expect(s.auth).toBe("");
    expect(s.rate_limited).toBe("");
  });

  it("parses the mega-menu shortcut values", () => {
    const s = search({ public_safe: "1", auth: "required", rate_limited: "1" });
    expect(s.public_safe).toBe("1");
    expect(s.auth).toBe("required");
    expect(s.rate_limited).toBe("1");
  });
});

describe("matchesSurfaceFilters", () => {
  it("passes every row when no filter is set", () => {
    expect(matchesSurfaceFilters(surface(), search())).toBe(true);
  });

  it("filters by kind, provider, and netuid", () => {
    const s = surface({ kind: "docs", provider_slug: "acme", netuid: 21 });
    expect(matchesSurfaceFilters(s, search({ kind: "docs" }))).toBe(true);
    expect(matchesSurfaceFilters(s, search({ kind: "api" }))).toBe(false);
    expect(matchesSurfaceFilters(s, search({ provider: "acme" }))).toBe(true);
    expect(matchesSurfaceFilters(s, search({ provider: "other" }))).toBe(false);
    expect(matchesSurfaceFilters(s, search({ netuid: "21" }))).toBe(true);
    expect(matchesSurfaceFilters(s, search({ netuid: "22" }))).toBe(false);
  });

  it("public_safe=1 keeps only public-safe surfaces", () => {
    expect(
      matchesSurfaceFilters(surface({ public_safe: true }), search({ public_safe: "1" })),
    ).toBe(true);
    expect(
      matchesSurfaceFilters(surface({ public_safe: false }), search({ public_safe: "1" })),
    ).toBe(false);
  });

  it("auth=required keeps only auth-gated surfaces; auth=none keeps only open ones", () => {
    expect(
      matchesSurfaceFilters(surface({ auth_required: true }), search({ auth: "required" })),
    ).toBe(true);
    expect(
      matchesSurfaceFilters(surface({ auth_required: false }), search({ auth: "required" })),
    ).toBe(false);
    expect(matchesSurfaceFilters(surface({ auth_required: false }), search({ auth: "none" }))).toBe(
      true,
    );
    expect(matchesSurfaceFilters(surface({ auth_required: true }), search({ auth: "none" }))).toBe(
      false,
    );
  });

  it("rate_limited=1 keeps only surfaces that document a rate limit", () => {
    expect(
      matchesSurfaceFilters(
        surface({ rate_limit_notes: "100 req/min" }),
        search({ rate_limited: "1" }),
      ),
    ).toBe(true);
    expect(
      matchesSurfaceFilters(surface({ rate_limit_notes: null }), search({ rate_limited: "1" })),
    ).toBe(false);
    expect(matchesSurfaceFilters(surface({}), search({ rate_limited: "1" }))).toBe(false);
  });

  it("combines the query with a shortcut filter", () => {
    const s = surface({ name: "Public docs", public_safe: true });
    expect(matchesSurfaceFilters(s, search({ q: "docs", public_safe: "1" }))).toBe(true);
    expect(matchesSurfaceFilters(s, search({ q: "nomatch", public_safe: "1" }))).toBe(false);
  });
});
