import { describe, it, expect } from "vitest";
import { lineDiff, diffStats } from "./diff";

describe("lineDiff", () => {
  it("marks every line as context for identical input", () => {
    const out = lineDiff("a\nb\nc", "a\nb\nc");
    expect(out.map((l) => l.kind)).toEqual(["ctx", "ctx", "ctx"]);
    expect(out[0]).toEqual({ kind: "ctx", text: "a", aLine: 1, bLine: 1 });
  });

  it("emits adds when the new text has extra trailing lines", () => {
    const out = lineDiff("a", "a\nb");
    expect(out).toEqual([
      { kind: "ctx", text: "a", aLine: 1, bLine: 1 },
      { kind: "add", text: "b", bLine: 2 },
    ]);
  });

  it("emits dels when the old text has extra trailing lines", () => {
    const out = lineDiff("a\nb", "a");
    expect(out).toEqual([
      { kind: "ctx", text: "a", aLine: 1, bLine: 1 },
      { kind: "del", text: "b", aLine: 2 },
    ]);
  });

  it("uses the LCS to keep the common line as context across a replacement", () => {
    const out = lineDiff("a\nb\nc", "a\nx\nc");
    expect(out.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:x", "ctx:c"]);
  });

  it("handles a full replacement (all del then all add)", () => {
    const out = lineDiff("a\nb", "c\nd");
    const kinds = out.map((l) => l.kind);
    expect(kinds.filter((k) => k === "del")).toHaveLength(2);
    expect(kinds.filter((k) => k === "add")).toHaveLength(2);
    expect(kinds).not.toContain("ctx");
  });
});

describe("diffStats", () => {
  it("counts add / del / ctx lines", () => {
    const out = lineDiff("a\nb\nc", "a\nx\nc");
    expect(diffStats(out)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it("returns zeros for an empty diff list", () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });
});
