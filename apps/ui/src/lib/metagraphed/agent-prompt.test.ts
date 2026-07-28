import { describe, expect, it } from "vitest";
import { FIRST_PROMPTS } from "./agent-prompt";

describe("FIRST_PROMPTS", () => {
  it("has exactly three entries, per the issue's own deliverable", () => {
    expect(FIRST_PROMPTS).toHaveLength(3);
  });

  it("every entry has a non-empty prompt and what-you-get description", () => {
    for (const p of FIRST_PROMPTS) {
      expect(p.prompt.trim().length).toBeGreaterThan(0);
      expect(p.whatYouGet.trim().length).toBeGreaterThan(0);
    }
  });

  it("every prompt is unique", () => {
    const prompts = FIRST_PROMPTS.map((p) => p.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});
