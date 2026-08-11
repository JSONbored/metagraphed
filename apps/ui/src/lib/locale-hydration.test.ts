// The guard that stops site #25.
//
// #8356 fixed React #418 by passing an explicit locale to two components, and
// wrote down exactly why: `toLocaleDateString(undefined, ...)` resolves to the
// RUNTIME's default, "which Cloudflare Workers (SSR) and a non-en-US browser
// (hydration) never agree on -- that mismatch is exactly what threw React #418
// on mobile UA."
//
// It fixed the two sites it was looking at. Twenty-four others kept the pattern,
// and #418 kept firing for months. A fix that depends on everyone remembering it
// is not a fix, so this asserts the property over the whole tree instead.
//
// NUMBERS COUNT, not just dates: (1234).toLocaleString() is "1,234" in en-US and
// "1.234" in de-DE, so an SSR'd stat line mismatches for most of the world. Three
// of them were on routes/-agents-page.tsx.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..");

/**
 * Whitespace-tolerant on purpose.
 *
 * A source-regex gate goes blind the moment prettier wraps the call it is
 * looking for, so `\s*` spans the newline that `toLocaleString(\n  undefined,`
 * would otherwise hide behind.
 */
const RUNTIME_DEFAULT_LOCALE =
  /\.toLocale(?:String|DateString|TimeString)\(\s*(?:\)|undefined\b)|Intl\.(?:DateTimeFormat|NumberFormat)\(\s*(?:\)|undefined\b)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("locale-dependent formatting never resolves to the runtime default", () => {
  it("finds no unlocalised toLocale*/Intl call anywhere under src", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // Skip the two comments that DOCUMENT the pattern — they quote it on
        // purpose, and a gate that trips on its own explanation is a gate
        // people delete.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (RUNTIME_DEFAULT_LOCALE.test(code)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Pass an explicit locale ("en-US") — an unlocalised call renders one way on ` +
        `the Worker and another in the visitor's browser, which is React #418 ` +
        `(see #8356, #10638):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // Proving the gate can fail. Without this, a regex that matched nothing would
  // pass the assertion above forever.
  it("matches the shapes it is meant to catch, including a wrapped one", () => {
    for (const bad of [
      "n.toLocaleString()",
      "d.toLocaleDateString(undefined, { month: 'short' })",
      "d.toLocaleTimeString(undefined)",
      "new Intl.DateTimeFormat(undefined, {})",
      "new Intl.NumberFormat()",
      // The formatting a prettier line-wrap would produce.
      "n.toLocaleString(\n  undefined,\n)".replace(/\n/g, "\n"),
    ]) {
      expect(RUNTIME_DEFAULT_LOCALE.test(bad), bad).toBe(true);
    }
  });

  it("does not flag a correctly localised call", () => {
    for (const ok of [
      'n.toLocaleString("en-US")',
      'd.toLocaleDateString("en-US", { month: "short" })',
      'new Intl.DateTimeFormat("en-US", {})',
      // A locale held in a variable is a deliberate choice, not the default.
      "n.toLocaleString(locale)",
    ]) {
      expect(RUNTIME_DEFAULT_LOCALE.test(ok), ok).toBe(false);
    }
  });
});
