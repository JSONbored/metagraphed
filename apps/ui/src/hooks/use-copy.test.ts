import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyErrorDescription,
  copySuccessTitle,
  legacyClipboardCopy,
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

describe("legacyClipboardCopy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDocument(execResult: boolean) {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ value: "", style: {}, select: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn(() => execResult),
    });
  }

  it("returns false during SSR when document is absent", () => {
    expect(legacyClipboardCopy("x")).toBe(false);
  });

  it("returns true when execCommand succeeds", () => {
    stubDocument(true);
    expect(legacyClipboardCopy("hello")).toBe(true);
  });

  it("returns false when execCommand is rejected, not a false success (#6026)", () => {
    stubDocument(false);
    expect(legacyClipboardCopy("hello")).toBe(false);
  });
});
