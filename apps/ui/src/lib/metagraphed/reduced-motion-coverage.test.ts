import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8367. The watchlist row pulse shipped in #8446 as the Tailwind pair
// `transition-colors duration-1000` + `bg-accent/15`. Every
// `prefers-reduced-motion` block in this repo names specific `mg-*` classes --
// there is no universal `*` reset -- so those utilities were covered by
// nothing, and the pulse played for visitors who had asked the platform not to
// animate. Reviewing the diff would not have caught it: the rule it broke
// lives in a different file from the code that broke it.
//
// This suite closes that gap structurally. Rather than asserting one class is
// handled, it asserts the INVARIANT: any `mg-*` class that animates must be
// answered somewhere under `prefers-reduced-motion: reduce`. A future liveness
// cue added without that answer fails here.

const cssPath = fileURLToPath(
  new URL("../../../../../packages/ui-kit/src/styles.css", import.meta.url),
);
const css = readFileSync(cssPath, "utf8");

/**
 * Slice out every top-level at-rule whose prelude matches `test`, brace-
 * counting so nested rules come along. Regex alone can't do this: `@media` and
 * `@keyframes` both nest, so a non-greedy `\{...\}` stops at the first inner
 * close brace.
 */
function extractAtRules(source: string, test: RegExp): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = "";
  let i = 0;
  while (i < source.length) {
    const at = source.indexOf("@", i);
    if (at === -1) {
      rest += source.slice(i);
      break;
    }
    const open = source.indexOf("{", at);
    if (open === -1) {
      rest += source.slice(i);
      break;
    }
    const prelude = source.slice(at, open);
    // Walk to the matching close brace.
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (test.test(prelude)) {
      blocks.push(source.slice(open + 1, end));
      rest += source.slice(i, at);
    } else {
      rest += source.slice(i, end + 1);
    }
    i = end + 1;
  }
  return { blocks, rest };
}

const { blocks: reducedMotionBlocks } = extractAtRules(css, /prefers-reduced-motion/);
// Keyframes bodies contain `0% { ... }` rules that would otherwise read as
// selectors carrying animation properties.
const { rest: withoutAtRules } = extractAtRules(css, /.*/);

/** Class names in `.mg-*` rules whose body sets a real (non-`none`) animation. */
function animatedClasses(source: string): string[] {
  const found = new Set<string>();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(source)) !== null) {
    const [, selector, body] = m;
    if (!/animation\s*:/.test(body ?? "")) continue;
    if (/animation\s*:\s*none/.test(body ?? "")) continue;
    for (const cls of (selector ?? "").match(/\.mg-[a-z0-9-]+/g) ?? []) {
      found.add(cls.slice(1));
    }
  }
  return [...found].sort();
}

describe("reduced-motion coverage (#8367)", () => {
  it("finds the reduced-motion block at all", () => {
    // Guards the parser itself: if this stops matching, every assertion below
    // would vacuously pass.
    expect(reducedMotionBlocks.length).toBeGreaterThan(0);
  });

  it("answers every animated mg-* class under prefers-reduced-motion", () => {
    const animated = animatedClasses(withoutAtRules);
    expect(animated.length).toBeGreaterThan(0);
    const answered = reducedMotionBlocks.join("\n");
    const unanswered = animated.filter((cls) => !answered.includes(`.${cls}`));
    expect(unanswered).toEqual([]);
  });

  it("covers the two liveness cues specifically", () => {
    const answered = reducedMotionBlocks.join("\n");
    // Named explicitly so the intent survives even if the generic sweep above
    // is ever loosened.
    expect(answered).toContain(".mg-row-flash");
    expect(answered).toContain(".mg-value-pulse");
  });

  it("does not reintroduce an unguarded Tailwind pulse on watchlist rows", () => {
    const mod = readFileSync(
      fileURLToPath(
        new URL("../../components/metagraphed/home-watched-module.tsx", import.meta.url),
      ),
      "utf8",
    );
    // Comments stripped first: the file documents the old defect by name, and
    // matching that prose would fail the moment the explanation is written
    // down. Only real class strings should count.
    const code = mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The exact shape of the original defect: a bare colour transition driving
    // the flash instead of the reduced-motion-aware class.
    expect(code).not.toMatch(/transition-colors[^"'`]*duration-1000/);
    expect(code).toContain("mg-row-flash");
  });
});
