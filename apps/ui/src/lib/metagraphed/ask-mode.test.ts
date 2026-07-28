import { describe, expect, it } from "vitest";
import { isQuestionLike, shouldShowAskRow } from "./ask-mode";

describe("isQuestionLike", () => {
  it("matches a query ending with a question mark", () => {
    expect(isQuestionLike("gittensor?")).toBe(true);
  });

  it("matches every documented interrogative starter, case-insensitively", () => {
    for (const starter of [
      "who",
      "what",
      "which",
      "how",
      "why",
      "when",
      "is",
      "are",
      "does",
      "can",
    ]) {
      expect(isQuestionLike(`${starter} runs image generation`)).toBe(true);
      expect(isQuestionLike(`${starter.toUpperCase()} runs image generation`)).toBe(true);
    }
  });

  it("requires a word boundary -- does not match a word merely starting with an interrogative's letters", () => {
    expect(isQuestionLike("whoever wrote this doc")).toBe(false);
    expect(isQuestionLike("canary release notes")).toBe(false);
  });

  it("does not match an ordinary entity-name query", () => {
    expect(isQuestionLike("gittensor")).toBe(false);
    expect(isQuestionLike("subnet 7")).toBe(false);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(isQuestionLike("  what is gittensor?  ")).toBe(true);
  });

  it("returns false for an empty/whitespace-only query", () => {
    expect(isQuestionLike("")).toBe(false);
    expect(isQuestionLike("   ")).toBe(false);
  });
});

describe("shouldShowAskRow", () => {
  it("is true for any question-like query, even a short one", () => {
    expect(shouldShowAskRow("why?")).toBe(true);
    expect(shouldShowAskRow("is sn7 up")).toBe(true);
  });

  it("is true for a long (>=4 word) query even without interrogative phrasing", () => {
    expect(shouldShowAskRow("image generation subnet options")).toBe(true);
  });

  it("is false for a short, non-question query (typical entity search)", () => {
    expect(shouldShowAskRow("gittensor")).toBe(false);
    expect(shouldShowAskRow("subnet 7 stake")).toBe(false);
  });

  it("returns false for an empty/whitespace-only query", () => {
    expect(shouldShowAskRow("")).toBe(false);
    expect(shouldShowAskRow("   ")).toBe(false);
  });
});
