import { describe, expect, it } from "vitest";

import { isChunkLoadFailure } from "./chunk-reload-recovery";

describe("isChunkLoadFailure", () => {
  it("matches Chrome/Edge/Vite's wording", () => {
    expect(
      isChunkLoadFailure(
        "Failed to fetch dynamically imported module: https://metagraph.sh/assets/nav-mega-menu-content-22wm21Q8.js",
      ),
    ).toBe(true);
  });

  it("matches Firefox's wording", () => {
    expect(isChunkLoadFailure("error loading dynamically imported module")).toBe(true);
  });

  it("matches Safari's wording", () => {
    expect(isChunkLoadFailure("Importing a module script failed")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isChunkLoadFailure("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE")).toBe(true);
  });

  it("rejects unrelated errors and empty input", () => {
    expect(isChunkLoadFailure("Network request failed")).toBe(false);
    expect(isChunkLoadFailure("404 Not Found")).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
    expect(isChunkLoadFailure(null)).toBe(false);
    expect(isChunkLoadFailure("")).toBe(false);
  });
});

// Small smoke check, mirroring blank-screen-watchdog.test.ts's own
// convention -- the side-effecting reload path (window.location.reload +
// sessionStorage) is exercised live via a dev-server browser session, not
// re-implemented with DOM mocks here.
describe("chunk-reload-recovery module surface", () => {
  it("exports the pure predicate", () => {
    expect(typeof isChunkLoadFailure).toBe("function");
  });
});
