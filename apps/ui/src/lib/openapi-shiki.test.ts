import { describe, expect, it, test } from "vitest";
import { createHighlighterCore, isSpecialLang } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { acceptLanguageNames, openapiShikiFactory } from "./openapi-shiki";

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

// --- the one incompatibility with fumadocs' highlighter ----------------------
//
// Measured on the deployed site: every code block on every /docs/api-reference
// page rendered UNHIGHLIGHTED, and filed an unhandled `TypeError: Cannot read
// properties of undefined (reading 'split')` doing it. fumadocs' `highlightHast`
// always finishes with `highlighter.loadLanguage(<name>)`, and a highlighter
// built by `createHighlighterCore` has no bundle to resolve a NAME against -- so
// it reads a scope name off `undefined` and throws, even for a language it is
// already holding.
//
// These drive the REAL shiki rather than a double, because a double would only
// assert what I believed about `loadLanguage` -- and that was wrong twice before
// this test existed. The failure is not about WHICH language is asked for (bash
// and json both fail, and both are loaded), and it does not poison the registry
// (`codeToHtml` keeps working around it).

/** A bare core highlighter with two languages, matching the factory's shape. */
async function core() {
  const [bash, json, githubLight] = await Promise.all([
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/themes/github-light.mjs"),
  ]);
  return createHighlighterCore({
    langs: [bash.default, json.default],
    themes: [githubLight.default],
    engine: createJavaScriptRegexEngine(),
  });
}

describe("the bug, pinned against the real shiki", () => {
  test("an UNWRAPPED core highlighter throws on a name it already holds", async () => {
    const raw = await core();
    expect(raw.getLoadedLanguages()).toContain("bash");
    // Verbatim what fumadocs' highlightHast does after deciding the language is
    // fine -- and the CAST is the bug, quoted: shiki's own types say a core
    // highlighter takes registrations, never a name, so this call is already
    // illegal before it is wrong at runtime.
    //
    // If shiki ever makes it work, this test fails and the wrapper can go.
    const byName = raw.loadLanguage as unknown as (lang: string) => Promise<void>;
    await expect(byName("bash")).rejects.toThrow(/split/);
  });
});

describe("acceptLanguageNames", () => {
  test("a name already loaded is a no-op, not a throw", async () => {
    const hl = acceptLanguageNames(await core());
    await expect(hl.loadLanguage("bash")).resolves.toBeUndefined();
    await expect(hl.loadLanguage("json")).resolves.toBeUndefined();
    // An ALIAS counts as loaded -- getLoadedLanguages() reports them, and
    // fumadocs asks for `js`, never `javascript`.
    expect(hl.getLoadedLanguages()).toContain("sh");
    await expect(hl.loadLanguage("sh")).resolves.toBeUndefined();
  });

  test("and highlighting still works afterwards", async () => {
    const hl = acceptLanguageNames(await core());
    await hl.loadLanguage("bash");
    const html = hl.codeToHtml("echo hi", {
      lang: "bash",
      theme: "github-light",
    });
    // TOKENS, not one bare line: the Suspense placeholder this bug left in
    // place renders exactly one `<span class="line">` per line, nothing inside.
    expect(html.match(/<span/g)!.length).toBeGreaterThan(1);
  });

  test("a special language passes through -- it is what the fallback is", async () => {
    const hl = acceptLanguageNames(await core());
    expect(isSpecialLang("text")).toBe(true);
    // fumadocs rewrites an unrecognised language to `text` before calling, so
    // this is the arm every unknown language actually takes.
    await expect(hl.loadLanguage("text")).resolves.toBeUndefined();
  });

  test("a registration object is still registered, not swallowed", async () => {
    const hl = acceptLanguageNames(await core());
    expect(hl.getLoadedLanguages()).not.toContain("python");
    const python = await import("shiki/langs/python.mjs");
    await hl.loadLanguage(python.default);
    expect(hl.getLoadedLanguages()).toContain("python");
  });

  test("a name with no grammar names ITSELF, rather than blaming `split`", async () => {
    // Unreachable through fumadocs (its guard rewrites unknown to `text`), so
    // reaching it means this factory's language list is genuinely missing
    // something -- and the message has to say which.
    const hl = acceptLanguageNames(await core());
    await expect(hl.loadLanguage("elixir")).rejects.toThrow(/no grammar registered for elixir/);
  });
});
