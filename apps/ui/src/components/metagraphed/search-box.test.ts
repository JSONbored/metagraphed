import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/metagraphed/client";
import type { SemanticSearchResult } from "@/lib/metagraphed/types";
import {
  describeSearchError,
  formatScore,
  resultLabel,
  resultMeta,
  identifierKindLabel,
  shortenIdentifier,
} from "./search-box";

function result(overrides: Partial<SemanticSearchResult> = {}): SemanticSearchResult {
  return {
    score: 0.5,
    type: "subnet",
    netuid: 64,
    slug: "chutes",
    title: "Chutes",
    subtitle: null,
    url: "https://chutes.ai",
    categories: [],
    service_kinds: [],
    ...overrides,
  };
}

describe("describeSearchError", () => {
  it("describes a 429 as rate-limited, regardless of the server message", () => {
    expect(
      describeSearchError(
        new ApiError("Too many requests", { status: 429, url: "/api/v1/search/semantic" }),
      ),
    ).toBe("Rate-limited — try again shortly.");
  });

  it("describes a 503 using the server message, falling back to a default when empty", () => {
    expect(
      describeSearchError(
        new ApiError("AI unavailable", { status: 503, url: "/api/v1/search/semantic" }),
      ),
    ).toBe("AI unavailable");
    expect(
      describeSearchError(new ApiError("", { status: 503, url: "/api/v1/search/semantic" })),
    ).toBe("AI is temporarily unavailable.");
  });

  it("falls back to the error message for any other ApiError status", () => {
    expect(
      describeSearchError(
        new ApiError("Bad request", { status: 400, url: "/api/v1/search/semantic" }),
      ),
    ).toBe("Bad request");
  });

  it("uses the generic fallback for an ApiError with no message (e.g. a network failure)", () => {
    expect(
      describeSearchError(new ApiError("", { status: 0, url: "/api/v1/search/semantic" })),
    ).toBe("Couldn't search — try again.");
  });

  it("returns a generic message for a non-ApiError failure", () => {
    expect(describeSearchError(new Error("network down"))).toBe("Couldn't search — try again.");
    expect(describeSearchError("not even an error")).toBe("Couldn't search — try again.");
    expect(describeSearchError(undefined)).toBe("Couldn't search — try again.");
  });
});

describe("formatScore", () => {
  it("renders a mid-range score as a rounded percentage", () => {
    expect(formatScore(0.87)).toBe("87%");
    expect(formatScore(0.005)).toBe("1%"); // rounds, doesn't truncate
  });

  it("renders the 0 and 1 boundaries", () => {
    expect(formatScore(0)).toBe("0%");
    expect(formatScore(1)).toBe("100%");
  });

  it("degrades a non-finite or out-of-schema-range score to an em dash, never NaN%", () => {
    expect(formatScore(Number.NaN)).toBe("—");
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatScore(-0.1)).toBe("—");
    expect(formatScore(1.1)).toBe("—");
  });
});

describe("resultLabel", () => {
  it("uses the title when present", () => {
    expect(resultLabel(result({ title: "Chutes" }))).toBe("Chutes");
  });

  it("falls back to the slug when title is null", () => {
    expect(resultLabel(result({ title: null, slug: "chutes" }))).toBe("chutes");
  });

  it("falls back to a generic label when both title and slug are null", () => {
    expect(resultLabel(result({ title: null, slug: null }))).toBe("Untitled");
  });
});

describe("resultMeta", () => {
  it("includes the subnet prefix when netuid is present", () => {
    expect(resultMeta(result({ netuid: 64, score: 0.5 }))).toBe("SN64 · 50%");
  });

  it("omits the subnet prefix when netuid is null", () => {
    expect(resultMeta(result({ netuid: null, score: 0.5 }))).toBe("50%");
  });
});

describe("identifier matches (metagraphed-infra#362)", () => {
  it("labels every resolved kind", () => {
    // A kind with no label would render blank, which reads as a broken row
    // rather than a missing case.
    const kinds = ["account", "block", "extrinsic", "evm-account", "subnet", "neuron"] as const;
    for (const kind of kinds) {
      expect(identifierKindLabel(kind).length).toBeGreaterThan(0);
    }
  });

  it("shortens in the MIDDLE, keeping both ends", () => {
    // The ends are what a user recognises in a hash or an address; truncating
    // the tail makes two different hashes look identical.
    const hash = `0x${"a".repeat(64)}`;
    const short = shortenIdentifier(hash);
    expect(short.startsWith("0xaaaaaaaa")).toBe(true);
    expect(short.endsWith("aaaaaaaa")).toBe(true);
    expect(short).toContain("…");
    expect(short.length).toBeLessThan(hash.length);
  });

  it("leaves a short value alone", () => {
    expect(shortenIdentifier("7")).toBe("7");
    expect(shortenIdentifier("74:12")).toBe("74:12");
  });
});
