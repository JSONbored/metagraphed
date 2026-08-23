import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DESIGN_TOKENS } from "./design-tokens.generated";
import {
  declarations,
  parseDesignTokens,
  topLevelBlocks,
  type DesignToken,
} from "./parse-design-tokens";

// The Tokens table on /design/primitives is generated from the stylesheet
// (#11627). This is the gate that keeps it that way: it re-reads
// packages/ui-kit/src/styles.css and fails while the committed module and the
// stylesheet disagree, so a token that moves without a re-run cannot leave the
// page documenting a colour the app no longer ships.

const STYLES_PATH = path.resolve(__dirname, "../../../../../../packages/ui-kit/src/styles.css");
const CSS = readFileSync(STYLES_PATH, "utf8");

function byName(tokens: readonly DesignToken[]): Map<string, DesignToken> {
  return new Map(tokens.map((token) => [token.name, token]));
}

describe("design-tokens.generated.ts", () => {
  const parsed = parseDesignTokens(CSS);

  it("lists exactly the tokens the stylesheet declares, in the same order", () => {
    expect(DESIGN_TOKENS.map((t) => t.name)).toEqual(parsed.map((t) => t.name));
  });

  it("matches the stylesheet value for value", () => {
    // Named diff first: a bare deep-equal on 90-odd rows prints a wall, and
    // the useful sentence is "--accent is #0f8f66 here and #123456 there".
    const generated = byName(DESIGN_TOKENS);
    const drifted = parsed.filter((token) => {
      const mine = generated.get(token.name);
      return (
        !mine ||
        mine.light !== token.light ||
        mine.dark !== token.dark ||
        mine.theme !== token.theme ||
        mine.refs !== token.refs
      );
    });
    expect(
      drifted.map(
        (t) => `${t.name}: ${t.light} / ${t.dark ?? "="} · ${t.theme ?? "—"} · ${t.refs}`,
      ),
    ).toEqual([]);
    expect(DESIGN_TOKENS).toEqual(parsed);
  });

  it("is not empty, and every token has a light value", () => {
    expect(DESIGN_TOKENS.length).toBeGreaterThan(50);
    expect(DESIGN_TOKENS.filter((t) => t.light === "").map((t) => t.name)).toEqual([]);
  });

  it("carries the tokens that differ between themes", () => {
    // A positive control for the dark column: if `.dark` stopped being parsed,
    // every `dark` would be null and the first assertion above would still
    // pass against a re-parse that made the same mistake.
    const themed = DESIGN_TOKENS.filter((t) => t.dark !== null);
    expect(themed.length).toBeGreaterThan(20);
    const canvas = byName(DESIGN_TOKENS).get("--canvas");
    expect(canvas?.theme).toBe("--color-canvas");
    expect(canvas?.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(canvas?.dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(canvas?.dark).not.toBe(canvas?.light);
  });
});

describe("parseDesignTokens", () => {
  it("reads :root and .dark, and nothing nested inside them", () => {
    const tokens = parseDesignTokens(`
      @theme inline { --color-ink: var(--ink); }
      :root { --ink: rgb(17 17 17); --gap: 8px; }
      .dark { --ink: rgb(238 238 238); --gap: 8px; }
      @media (max-width: 40rem) { :root { --gap: 4px; } }
      @layer base { .thing { --local: 1px; } }
      .thing { color: var(--ink); border-color: var(--ink-strong); }
    `);
    expect(tokens).toEqual([
      // `--gap` restates the same value under .dark, so it has no dark column;
      // the @media override is a width override, not a theme.
      {
        name: "--ink",
        light: "rgb(17 17 17)",
        dark: "rgb(238 238 238)",
        theme: "--color-ink",
        refs: 2,
      },
      { name: "--gap", light: "8px", dark: null, theme: null, refs: 0 },
    ]);
    expect(tokens.map((t) => t.name)).not.toContain("--local");
  });

  it("does not count a longer token as a reference to its prefix", () => {
    const tokens = parseDesignTokens(`
      :root { --ink: rgb(17 17 17); --ink-strong: rgb(0 0 0); }
      .a { color: var(--ink-strong); }
      .b { color: var(--ink); }
    `);
    expect(tokens.map((t) => [t.name, t.refs])).toEqual([
      ["--ink", 1],
      ["--ink-strong", 1],
    ]);
  });

  it("keeps a multi-line value on one line", () => {
    const [token] = parseDesignTokens(`
      :root {
        --shadow:
          0 0 0 1px rgba(0, 0, 0, 0.1),
          0 8px 16px rgba(0, 0, 0, 0.2);
      }
    `);
    expect(token?.light).toBe("0 0 0 1px rgba(0, 0, 0, 0.1), 0 8px 16px rgba(0, 0, 0, 0.2)");
  });
});

describe("the parser's parts", () => {
  it("collects only depth-0 rules", () => {
    const blocks = topLevelBlocks("@media screen { :root { --a: 1; } } :root { --b: 2; }");
    expect(blocks.map((b) => b.selector)).toEqual(["@media screen", ":root"]);
  });

  it("skips declarations of a nested rule", () => {
    expect(declarations("--a: 1; .x { --b: 2; } --c: 3;")).toEqual([
      { name: "--a", value: "1" },
      { name: "--c", value: "3" },
    ]);
  });

  it("does not split a value on a semicolon-free function call", () => {
    expect(declarations("--a: color-mix(in oklab, var(--b) 10%, var(--c));")).toEqual([
      { name: "--a", value: "color-mix(in oklab, var(--b) 10%, var(--c))" },
    ]);
  });
});
