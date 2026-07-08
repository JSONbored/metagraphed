import { describe, expect, it } from "vitest";
import { pickPromotedSubnetHit, scoreHit } from "./search-hit-score";

describe("scoreHit", () => {
  it("scores an exact title match at the promotion threshold", () => {
    expect(scoreHit({ type: "subnet", title: "Chutes" }, "chutes")).toBe(102);
  });

  it("does not reach the promotion threshold for prefix-only matches", () => {
    expect(scoreHit({ type: "subnet", title: "Chutes AI" }, "chut")).toBe(62);
  });
});

describe("pickPromotedSubnetHit", () => {
  const hits = [
    { id: "1", type: "subnet", title: "Chutes", netuid: 64 },
    { id: "2", type: "subnet", title: "Apex", netuid: 1 },
    { id: "3", type: "provider", title: "Chutes", slug: "chutes" },
  ];

  it("returns the best exact subnet title match", () => {
    expect(pickPromotedSubnetHit(hits, "chutes")).toEqual(hits[0]);
  });

  it("returns null when no subnet title matches exactly", () => {
    expect(pickPromotedSubnetHit(hits, "chut")).toBeNull();
  });

  it("returns null for empty query", () => {
    expect(pickPromotedSubnetHit(hits, "   ")).toBeNull();
  });
});
