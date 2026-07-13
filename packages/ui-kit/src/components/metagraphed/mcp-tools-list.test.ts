import { describe, expect, it } from "vitest";
import { visibleTools } from "./mcp-tools-list";

const TOOLS = Array.from({ length: 30 }, (_, i) => `tool_${i}`);

describe("visibleTools", () => {
  it("truncates to the 24-item preview when closed", () => {
    expect(visibleTools(TOOLS, false)).toHaveLength(24);
    expect(visibleTools(TOOLS, false)).toEqual(TOOLS.slice(0, 24));
  });

  it("returns every item when open", () => {
    expect(visibleTools(TOOLS, true)).toEqual(TOOLS);
  });

  it("returns a short list unchanged in either state", () => {
    const short = TOOLS.slice(0, 5);
    expect(visibleTools(short, false)).toEqual(short);
    expect(visibleTools(short, true)).toEqual(short);
  });

  it("handles an empty list", () => {
    expect(visibleTools([], false)).toEqual([]);
    expect(visibleTools([], true)).toEqual([]);
  });
});
