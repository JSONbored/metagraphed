import { describe, expect, it } from "vitest";

import { statPhase } from "./stat-phase";

describe("statPhase", () => {
  it("reports pending while the query is loading", () => {
    expect(statPhase({ isPending: true, isError: false })).toBe("pending");
  });

  it("reports error when the query failed", () => {
    expect(statPhase({ isPending: false, isError: true })).toBe("error");
  });

  it("prefers error over pending when both are set", () => {
    expect(statPhase({ isPending: true, isError: true })).toBe("error");
  });

  it("reports ready once the query settled successfully", () => {
    expect(statPhase({ isPending: false, isError: false })).toBe("ready");
  });
});
