import { describe, expect, it } from "vitest";

import {
  copyErrorDescription,
  copySuccessTitle,
  shouldUseNavigatorClipboard,
  truncateCopyPreview,
} from "./use-copy";

describe("truncateCopyPreview", () => {
  it("returns short values unchanged", () => {
    expect(truncateCopyPreview("abc")).toBe("abc");
    expect(truncateCopyPreview("x".repeat(64))).toBe("x".repeat(64));
  });

  it("truncates values longer than the default max with an ellipsis", () => {
    const value = "y".repeat(65);
    expect(truncateCopyPreview(value)).toBe("y".repeat(64) + "…");
  });

  it("honors a custom max length", () => {
    expect(truncateCopyPreview("abcdef", 3)).toBe("abc…");
  });
});

describe("copySuccessTitle", () => {
  it("uses the label when provided", () => {
    expect(copySuccessTitle("endpoint url")).toBe("Copied endpoint url");
  });

  it("falls back to the generic title", () => {
    expect(copySuccessTitle()).toBe("Copied to clipboard");
  });
});

describe("copyErrorDescription", () => {
  it("returns the Error message when available", () => {
    expect(copyErrorDescription(new Error("denied"))).toBe("denied");
  });

  it("falls back for non-Error values", () => {
    expect(copyErrorDescription("nope")).toBe("Clipboard unavailable");
  });
});

describe("shouldUseNavigatorClipboard", () => {
  it("prefers the async clipboard API when present", () => {
    expect(shouldUseNavigatorClipboard({ clipboard: {} } as Navigator)).toBe(true);
  });

  it("falls back when navigator or clipboard is missing", () => {
    expect(shouldUseNavigatorClipboard(undefined)).toBe(false);
    expect(shouldUseNavigatorClipboard({} as Navigator)).toBe(false);
  });
});
