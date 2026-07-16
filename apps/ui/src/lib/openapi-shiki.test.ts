import { describe, expect, it } from "vitest";

import { openapiShikiFactory } from "./openapi-shiki";

// A regression test for the Cloudflare Workers Builds OOM fix itself (see
// this file's own comment): the whole point of a scoped shiki factory is
// that it loads ONLY the languages requests/generators/all.js's code-sample
// tabs (bash/js/go/python/java/csharp/rust) plus json actually need. If a
// future edit widens this back toward shiki's full ~180-language catalog
// (e.g. reverting to createOpenAPIPage()'s implicit default), this test
// catches the scope drift before it reintroduces the build failure.
// Shiki registers each language's own aliases alongside its canonical name
// (loading "bash" also registers shell/sh/zsh/shellscript, "javascript"
// also registers js/mjs/cjs, etc.) -- this is the real, complete set
// createHighlighterCore({langs: [bash, javascript, go, python, java,
// csharp, rust, json]}) produces, confirmed empirically rather than
// assumed from the 8 canonical names alone.
const EXPECTED_LOADED_LANGUAGES = [
  "bash",
  "shell",
  "sh",
  "zsh",
  "shellscript",
  "javascript",
  "js",
  "mjs",
  "cjs",
  "go",
  "python",
  "py",
  "java",
  "csharp",
  "cs",
  "c#",
  "rust",
  "rs",
  "json",
];

describe("openapiShikiFactory", () => {
  it("loads exactly the languages the interactive playground's code samples use (plus their own aliases)", async () => {
    const highlighter = await openapiShikiFactory.getOrInit();

    expect(new Set(highlighter.getLoadedLanguages())).toEqual(new Set(EXPECTED_LOADED_LANGUAGES));
  });

  it("loads the two themes createOpenAPIPageBase's default shikiOptions expects", async () => {
    const highlighter = await openapiShikiFactory.getOrInit();

    expect(new Set(highlighter.getLoadedThemes())).toEqual(
      new Set(["github-light", "github-dark"]),
    );
  });

  it("memoizes the highlighter instance across calls", async () => {
    const first = await openapiShikiFactory.getOrInit();
    const second = await openapiShikiFactory.getOrInit();

    expect(second).toBe(first);
  });
});
