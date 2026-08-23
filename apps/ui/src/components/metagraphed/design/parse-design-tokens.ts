// The design tokens, read out of the stylesheet that defines them.
//
// `/design/primitives` documents the token layer, and a hand-written table of
// 70-odd colours is wrong the first time one of them moves -- silently, and in
// the direction that matters, because a reader trusts the page that claims to
// be the spec. So the table is GENERATED from
// `packages/ui-kit/src/styles.css` (apps/ui/scripts/generate-design-tokens.ts)
// and `design-tokens.test.ts` re-parses the same stylesheet and fails while the
// generated module and the stylesheet disagree.
//
// This module is the parser both of them share. It takes CSS text and returns
// data -- no filesystem, no globals -- so the script, the test and any future
// caller read the stylesheet exactly the same way.

/** One custom property declared by the token layer. */
export interface DesignToken {
  /** The property, e.g. `--canvas`. */
  name: string;
  /** Its value under the top-level `:root` rule (the light theme). */
  light: string;
  /** Its value under `.dark`, or `null` when dark inherits the light value. */
  dark: string | null;
  /**
   * The `@theme inline` property that aliases it -- the Tailwind bridge, e.g.
   * `--color-canvas` for `--canvas`, which is what makes `bg-canvas` exist.
   * `null` when no bridge property is exactly `var(<name>)`.
   */
  theme: string | null;
  /** How many times the stylesheet itself reads the token with `var()`. */
  refs: number;
}

/** A top-level rule: everything between one selector and its closing brace. */
interface Block {
  selector: string;
  body: string;
}

const COMMENT = /\/\*[\s\S]*?\*\//g;

/** Comments are stripped everywhere before parsing; no token value contains one. */
export function stripComments(css: string): string {
  return css.replace(COMMENT, "");
}

/**
 * The rules at brace depth 0. A `:root` nested in `@media (max-width: 40rem)`
 * is therefore NOT collected: it is a responsive override of the section
 * rhythm, not a second light theme, and folding it into the light column would
 * state a value the page never renders at the width it is read at.
 */
export function topLevelBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let selector = "";
  let body = "";
  for (const char of css) {
    if (char === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector: normalize(selector), body });
        selector = "";
        body = "";
        continue;
      }
    }
    if (depth === 0) {
      // A stray `;` at depth 0 ends an at-rule statement (`@import …;`), so it
      // also ends whatever selector text was accumulating.
      if (char === ";") selector = "";
      else selector += char;
    } else {
      body += char;
    }
  }
  return blocks;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The custom-property declarations of one rule body, in source order. */
export function declarations(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let depth = 0;
  let parens = 0;
  let buffer = "";
  const flush = () => {
    const match = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(buffer);
    if (match) out.push({ name: match[1]!, value: normalize(match[2]!) });
    buffer = "";
  };
  for (const char of body) {
    // Declarations of a nested rule (`.mg-dt[data-dense="true"] { --row: … }`)
    // belong to that component, not to the theme: entering or leaving one
    // drops whatever was accumulating, selector text included.
    if (char === "{") {
      depth += 1;
      buffer = "";
      continue;
    }
    if (char === "}") {
      depth -= 1;
      buffer = "";
      continue;
    }
    if (depth > 0) continue;
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    if (char === ";" && parens === 0) {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();
  return out;
}

/** How many times the stylesheet reads `name` through `var()`. */
export function countRefs(css: string, name: string): number {
  // The lookahead, not `\b`: `\b` matches between `k` and `-`, so a `\b` guard
  // counts every `var(--ink-strong)` as a reference to `--ink`.
  const pattern = new RegExp(`var\\(\\s*${escape(name)}(?![\\w-])`, "g");
  return css.match(pattern)?.length ?? 0;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every token the theme declares, in the order the stylesheet declares them.
 *
 * Light comes from the top-level `:root` rules, dark from `.dark`. A token
 * `.dark` restates with the same value has `dark: null` -- it does not change
 * between themes, and a table that repeated the value would bury the ~30 that
 * do.
 */
export function parseDesignTokens(css: string): DesignToken[] {
  const source = stripComments(css);
  const blocks = topLevelBlocks(source);
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const order: string[] = [];
  const bridge = new Map<string, string>();

  for (const block of blocks) {
    const isTheme = block.selector.startsWith("@theme");
    const target = block.selector === ":root" ? light : block.selector === ".dark" ? dark : null;
    if (!target && !isTheme) continue;
    for (const decl of declarations(block.body)) {
      if (isTheme) {
        const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(decl.value)?.[1];
        if (alias && !bridge.has(alias)) bridge.set(alias, decl.name);
        continue;
      }
      target!.set(decl.name, decl.value);
      if (!order.includes(decl.name)) order.push(decl.name);
    }
  }

  return order.map((name) => {
    const lightValue = light.get(name);
    const darkValue = dark.get(name);
    return {
      name,
      // A token declared only under `.dark` has no light value to state; the
      // stylesheet has none today, and inventing one would be a lie the table
      // would carry forever.
      light: lightValue ?? "",
      dark: darkValue !== undefined && darkValue !== lightValue ? darkValue : null,
      theme: bridge.get(name) ?? null,
      refs: countRefs(source, name),
    };
  });
}
