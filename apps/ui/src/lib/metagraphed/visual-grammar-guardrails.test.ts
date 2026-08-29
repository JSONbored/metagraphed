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
  it("keeps TAO's currency glyph attached to numeric values (#11794)", () => {
    const spacedTao = /(?:\d|[kKM]|\})\s+τ/g;
    const offenders: string[] = [];
    for (const p of sources) {
      const lines = read(p).split("\n");
      lines.forEach((line, i) => {
        if (spacedTao.test(line)) offenders.push(`${rel(p)}:${i + 1}`);
        spacedTao.lastIndex = 0;
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps viewport scheduling details out of reader-facing copy (#11750)", () => {
    const implementationCopy =
      /(?:deferred below the fold|loads? as this section approaches|starts? only as this section approaches|loads? when this raw record is opened)/i;
    const offenders = sources.filter((p) => p.endsWith(".tsx") && implementationCopy.test(read(p)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("has no marquee or auto-scrolling strip anywhere in either package", () => {
    // Auto-scrolling text is unreadable, unpausable, and takes attention from
    // whatever the reader actually came for. The last one was the footer's
    // registry-pulse ticker; .survives as a plain user-scrollable
    // row, but nothing animates a translate on a loop any more.
    const offenders = sources.filter((p) =>
      /\b(?:animate-marquee|animate-scroll|mg-marquee|mg-ticker-track)\b/.test(read(p)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("has no infinite translate animation but the route-transition bar", () => {
    // Catches a re-introduction under a different name. `infinite` alone is
    // fine (spinners, pulse dots); it's the pairing with a translate keyframe
    // that makes a marquee.
    //
    // `mg-loader` is the one allowed moving element: the 2px route-transition
    // strip. It was already infinite and already translating -- but it lived in
    // an `animate-[mg-loader_1.1s_ease-in-out_infinite]` Tailwind utility, and
    // a sweep of the STYLESHEET cannot see a utility. #11628 moved it into
    // `.mg-progress-track`, which is what made this assertion notice it. An
    // exemption that only says "allowed" would hide the thing that matters, so
    // the next assertion requires it to be answered under reduced motion.
    const css = read(root("../../../../../packages/ui-kit/src/styles.css"));
    const infiniteAnimations = [...css.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map(
      (m) => m[1],
    );
    const translating = infiniteAnimations.filter((name) => {
      const kf = css.match(new RegExp(`@keyframes ${name}\\s*\\{[^}]*\\}[^}]*\\}`));
      return kf ? /translateX|translateY|translate3d/.test(kf[0]) : false;
    });
    expect(translating).toEqual(["mg-loader"]);
  });

  it("stops the route-transition bar under prefers-reduced-motion", () => {
    // The carve-out above is only defensible because of this: the one element
    // allowed to move stops moving for a reader who asked motion to stop.
    const css = read(root("../../../../../packages/ui-kit/src/styles.css"));
    // lastIndexOf, not indexOf: the stylesheet carries more than one
    // reduced-motion query, and slicing from the first one includes the
    // .mg-progress-track DEFINITION, which of course matches its own name.
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain(".mg-progress-track");
    const rule = block.slice(block.indexOf(".mg-progress-track"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/animation:\s*none/);
  });

  it("stops finite block-arrival cues under prefers-reduced-motion", () => {
    const css = read(root("../../../../../packages/ui-kit/src/styles.css"));
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [
      '.mg-live-block[data-arrived="true"]',
      '.mg-block-activity-mark[data-arrived="true"]::after',
    ]) {
      expect(block).toContain(selector);
      const rule = block.slice(block.indexOf(selector));
      expect(rule.slice(0, rule.indexOf("}"))).toMatch(/animation:\s*none/);
    }
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
        if (
          !/(?:background|backgroundColor|fill)\s*:\s*(?:[^,;\n]*\?\?\s*)?["']var\(--accent\)["']/.test(
            line,
          )
        )
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
