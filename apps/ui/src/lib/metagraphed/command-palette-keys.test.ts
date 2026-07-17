import { describe, it, expect } from "vitest";
import { isCopySelectedKey, type CopyKeyEvent } from "@/lib/metagraphed/command-palette-keys";

const key = (over: Partial<CopyKeyEvent>): CopyKeyEvent => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  key: "c",
  ...over,
});

describe("isCopySelectedKey", () => {
  it("fires on ⌘C and Ctrl+C when the input has no text selection", () => {
    expect(isCopySelectedKey(key({ metaKey: true }), false)).toBe(true);
    expect(isCopySelectedKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isCopySelectedKey(key({ ctrlKey: true, key: "C" }), false)).toBe(true);
  });

  it("ignores Ctrl+Shift+C — that's the devtools inspect shortcut", () => {
    expect(isCopySelectedKey(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("ignores a plain 'c' (that's search input, not a command)", () => {
    expect(isCopySelectedKey(key({}), false)).toBe(false);
  });

  it("ignores other modified keys", () => {
    expect(isCopySelectedKey(key({ metaKey: true, key: "v" }), false)).toBe(false);
    expect(isCopySelectedKey(key({ metaKey: true, key: "Enter" }), false)).toBe(false);
  });

  it("defers to native copy when the user has selected input text", () => {
    expect(isCopySelectedKey(key({ metaKey: true }), true)).toBe(false);
  });
});
