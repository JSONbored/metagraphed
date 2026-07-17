import { describe, expect, it } from "vitest";
import { endpointsFiltersActive, type EndpointsFilterState } from "./endpoints-filters";

/** The schema defaults: nothing narrowing the table, callable-only left on. */
const DEFAULTS: EndpointsFilterState = {
  q: "",
  category: "all",
  provider: "",
  health: "",
  netuid: "",
  region: "",
  eligibility: "",
  callable: true,
};

describe("endpointsFiltersActive (#6386)", () => {
  it("is inactive when every filter is at its default", () => {
    expect(endpointsFiltersActive(DEFAULTS)).toBe(false);
  });

  it("treats turning the Callable-only toggle off as an active filter", () => {
    // The regression: this state used to leave "Reset filters" disabled even
    // though callable !== its default, so the toggle could not be reset.
    expect(endpointsFiltersActive({ ...DEFAULTS, callable: false })).toBe(true);
  });

  it("stays inactive while Callable-only is at its true default", () => {
    expect(endpointsFiltersActive({ ...DEFAULTS, callable: true })).toBe(false);
  });

  it.each([
    ["q", { q: "rpc" }],
    ["category", { category: "wss" }],
    ["provider", { provider: "latent" }],
    ["health", { health: "down" }],
    ["netuid", { netuid: "42" }],
    ["region", { region: "us-east" }],
    ["eligibility", { eligibility: "pool-member" }],
  ] satisfies [string, Partial<EndpointsFilterState>][])(
    "is active when %s alone is set",
    (_name, override) => {
      expect(endpointsFiltersActive({ ...DEFAULTS, ...override })).toBe(true);
    },
  );

  it("is active when a text filter and the toggle are both non-default", () => {
    expect(endpointsFiltersActive({ ...DEFAULTS, q: "rpc", callable: false })).toBe(true);
  });
});
