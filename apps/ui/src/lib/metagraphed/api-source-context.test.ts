import { describe, expect, it } from "vitest";

import { dedupeApiSources, type ApiSource } from "./api-source-context";

describe("dedupeApiSources", () => {
  it("returns an empty list for no registrations", () => {
    expect(dedupeApiSources([])).toEqual([]);
  });

  it("keeps the first registration for duplicate paths across groups", () => {
    const first: ApiSource = { path: "/api/v1/health", label: "first" };
    const second: ApiSource = { path: "/api/v1/health", label: "second" };
    const groups = [
      [first, { path: "/api/v1/coverage" }],
      [second, { path: "/api/v1/subnets" }],
    ];

    expect(dedupeApiSources(groups)).toEqual([
      first,
      { path: "/api/v1/coverage" },
      { path: "/api/v1/subnets" },
    ]);
  });

  it("skips duplicate paths within the same registration group", () => {
    const groups = [[{ path: "/api/v1/events" }, { path: "/api/v1/events", artifact: "dup" }]];

    expect(dedupeApiSources(groups)).toEqual([{ path: "/api/v1/events" }]);
  });

  it("preserves registration order across groups", () => {
    const groups = [[{ path: "/a" }, { path: "/b" }], [{ path: "/c" }]];

    expect(dedupeApiSources(groups).map((s) => s.path)).toEqual(["/a", "/b", "/c"]);
  });
});
