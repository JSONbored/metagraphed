import { describe, expect, it, beforeEach } from "vitest";
import { defaultVisible } from "./use-column-visibility";

describe("defaultVisible", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") window.localStorage.clear();
  });

  it("includes required and defaultVisible!==false columns", () => {
    const cols = [
      { id: "a", label: "A", required: true },
      { id: "b", label: "B" },
      { id: "c", label: "C", defaultVisible: false },
      { id: "d", label: "D", defaultVisible: true },
    ];
    expect(defaultVisible(cols)).toEqual(["a", "b", "d"]);
  });
});
