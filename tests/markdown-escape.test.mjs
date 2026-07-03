import { describe, expect, it } from "vitest";
import {
  markdownInlineCode,
  markdownLink,
} from "../scripts/lib/markdown-escape.mjs";

describe("markdown-escape", () => {
  it("wraps plain registry tags in single-backtick code spans", () => {
    expect(markdownInlineCode("prediction-markets")).toBe(
      "`prediction-markets`",
    );
  });

  it("uses longer fences when tags contain literal backticks", () => {
    expect(markdownInlineCode("tag`break")).toBe("``tag`break``");
    expect(markdownInlineCode("a``b")).toBe("```a``b```");
    expect(markdownInlineCode("`")).toBe("`` ` ``");
  });

  it("does not rely on backslash escaping inside code spans", () => {
    expect(markdownInlineCode("tag]break")).toBe("`tag]break`");
    expect(markdownInlineCode("tag]break")).not.toContain("\\");
  });

  it("escapes link labels while leaving bracket literals in code spans alone", () => {
    expect(markdownLink("Evil [link]", "https://example.com")).toBe(
      "[Evil \\[link\\]](https://example.com)",
    );
  });
});
