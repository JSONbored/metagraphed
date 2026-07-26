import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #8255 visual grammar. The eslint.config.ts rules encode the same two bans,
// but `no-restricted-syntax` carries a single severity for all its selectors,
// so they sit at "warn" alongside the token worklist. This suite is what makes
// them fail CI — and it reaches packages/ui-kit and raw CSS, which the
// apps/ui-scoped lint config never sees.

const root = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => entry.endsWith(e)) && !entry.includes(".test.")) out.push(p);
  }
  return out;
}

const sources = [
  ...walk(root("../.."), [".ts", ".tsx"]),
  ...walk(root("../../../../../packages/ui-kit/src"), [".ts", ".tsx", ".css"]),
].filter((p) => !p.endsWith("visual-grammar-guardrails.test.ts"));

const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => p.slice(p.indexOf("/metagraphed/") + 13);

describe("visual grammar guardrails (#8255)", () => {
  it("has no marquee or auto-scrolling strip anywhere in either package", () => {
    // Auto-scrolling text is unreadable, unpausable, and takes attention from
    // whatever the reader actually came for. The last one was the footer's
    // registry-pulse ticker; .mg-ticker survives as a plain user-scrollable
    // row, but nothing animates a translate on a loop any more.
    const offenders = sources.filter((p) =>
      /\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track)\b/.test(read(p)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("has no infinite translate animation, the shape a marquee always takes", () => {
    // Catches a re-introduction under a different name. `infinite` alone is
    // fine (spinners, pulse dots); it's the pairing with a translate keyframe
    // that makes a marquee.
    const css = read(root("../../../../../packages/ui-kit/src/styles.css"));
    const infiniteAnimations = [...css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map(
      (m) => m[1],
    );
    const translating = infiniteAnimations.filter((name) => {
      const kf = css.match(new RegExp(`@keyframes ${name}\\s*\\{[^}]*\\}[^}]*\\}`));
      return kf ? /translateX|translateY|translate3d/.test(kf[0]) : false;
    });
    expect(translating).toEqual([]);
  });

  it("has no full-bleed accent fill — accent may colour a mark, not fill a region", () => {
    // The distinction that matters is proportional vs. full-bleed, not the
    // colour itself. A bar sized `width: ${pct}%`, a sparkline stroke, an 8px
    // legend swatch — those are data *marks*, and accent is the right colour
    // for the one data series on screen. A treemap tile sized `h-full w-full`
    // is a *region*: it paints its whole box, and in accent the entire map
    // reads as interactive. So: flag an accent background only when the same
    // element also claims its full box.
    const offenders: string[] = [];
    for (const p of sources) {
      const lines = read(p).split("\n");
      lines.forEach((line, i) => {
        if (!/(?:background|backgroundColor|fill)\s*:\s*(?:[^,;\n]*\?\?\s*)?["']var\(--accent\)["']/.test(line))
          return;
        // The className sits in the same JSX opening element, a few lines up.
        const element = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        if (/\bh-full\b/.test(element) && /\bw-full\b/.test(element)) {
          offenders.push(`${rel(p)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
