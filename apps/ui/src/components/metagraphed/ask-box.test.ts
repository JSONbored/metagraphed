import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/metagraphed/client";
import type { AskCitation } from "@/lib/metagraphed/types";
import {
  citationLabel,
  citationMeta,
  describeAskError,
  formatScore,
  sourceCountLabel,
} from "./ask-box";

function citation(overrides: Partial<AskCitation> = {}): AskCitation {
  return {
    ref: 1,
    score: 0.5,
    title: "Chutes",
    netuid: 64,
    slug: "chutes",
    url: "https://chutes.ai",
    ...overrides,
  };
}

describe("describeAskError", () => {
  it("describes a 429 as rate-limited, regardless of the server message", () => {
    expect(
      describeAskError(new ApiError("Too many requests", { status: 429, url: "/api/v1/ask" })),
    ).toBe("Rate-limited — try again shortly.");
  });

  it("describes a 503 using the server message, falling back to a default when empty", () => {
    expect(
      describeAskError(new ApiError("AI unavailable", { status: 503, url: "/api/v1/ask" })),
    ).toBe("AI unavailable");
    expect(describeAskError(new ApiError("", { status: 503, url: "/api/v1/ask" }))).toBe(
      "AI is temporarily unavailable.",
    );
  });

  it("falls back to the error message for any other ApiError status", () => {
    expect(describeAskError(new ApiError("Bad request", { status: 400, url: "/api/v1/ask" }))).toBe(
      "Bad request",
    );
  });

  it("uses the generic fallback for an ApiError with no message (e.g. a network failure)", () => {
    expect(describeAskError(new ApiError("", { status: 0, url: "/api/v1/ask" }))).toBe(
      "Couldn't get an answer — try again.",
    );
  });

  it("returns a generic message for a non-ApiError failure", () => {
    expect(describeAskError(new Error("network down"))).toBe("Couldn't get an answer — try again.");
    expect(describeAskError("not even an error")).toBe("Couldn't get an answer — try again.");
    expect(describeAskError(undefined)).toBe("Couldn't get an answer — try again.");
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

describe("citationLabel", () => {
  it("uses the title when present", () => {
    expect(citationLabel(citation({ title: "Chutes" }))).toBe("Chutes");
  });

  it("falls back to a ref-numbered label when title is null", () => {
    expect(citationLabel(citation({ ref: 3, title: null }))).toBe("Citation 3");
  });
});

describe("citationMeta", () => {
  it("includes the subnet prefix when netuid is present", () => {
    expect(citationMeta(citation({ netuid: 64, score: 0.5 }))).toBe("SN64 · 50%");
  });

  it("omits the subnet prefix when netuid is null", () => {
    expect(citationMeta(citation({ netuid: null, score: 0.5 }))).toBe("50%");
  });
});

describe("sourceCountLabel", () => {
  it("pluralizes for 0 and for >1", () => {
    expect(sourceCountLabel(0, "test-model")).toBe("0 sources · test-model");
    expect(sourceCountLabel(3, "test-model")).toBe("3 sources · test-model");
  });

  it("stays singular at exactly 1", () => {
    expect(sourceCountLabel(1, "test-model")).toBe("1 source · test-model");
  });
});
