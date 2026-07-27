import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #8325 label diet. `mg-type-micro` is 9.5px mono UPPERCASE with 0.18em
// tracking. It's the right treatment for a table header or a provenance chip,
// where a label is structural furniture the eye skips — and the wrong one for
// a section heading or an eyebrow, where it turns every heading into a shout.
// That's what made pages read as loud even though the Bone & Ink tokens
// themselves are calm.
//
// The eslint rule in VISUAL_GRAMMAR_RULES catches the shapes it can see
// (a className string literal on a known element). This test is the backstop
// for the shapes it can't: a template literal, a classNames() argument, a
// class assembled in a helper. It pins the ceiling rather than a fixed number
// so a legitimate new table header doesn't fail CI.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

// The sweep left 87: 53 on table headers, 34 on chips/pills. Some slack above
// that for genuinely new table headers, well below the 465 we started from.
const CEILING = 100;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(p);
  }
  return out;
}

const files = walk(SRC);

describe("label diet (#8325)", () => {
  it("keeps mg-type-micro under the ceiling across apps/ui", () => {
    let count = 0;
    for (const f of files) {
      count += (readFileSync(f, "utf8").match(/\bmg-type-micro\b/g) ?? []).length;
    }
    // A useful failure message: the number, not just "expected true".
    expect({ count, ceiling: CEILING }).toEqual({
      count: expect.any(Number),
      ceiling: CEILING,
    });
    expect(count).toBeLessThanOrEqual(CEILING);
  });

  it("has no mg-type-micro left on a bare section-label span or div", () => {
    // The exact shape the sweep targeted: a label element carrying micro with
    // no chip framing (`rounded-full`) to justify it. The eslint rule covers
    // this too; this catches it in files eslint's element-scoped selector
    // can't reach (template literals, classNames() calls).
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/className=\{?["'`]([^"'`]*mg-type-micro[^"'`]*)["'`]/g)) {
        const cls = m[1] ?? "";
        if (cls.includes("rounded-full")) continue;
        // Find the element this className belongs to.
        const before = src.slice(0, m.index);
        const tag = before.match(/<([A-Za-z][A-Za-z0-9.]*)(?![\s\S]*<[A-Za-z])/)?.[1];
        if (tag && ["th", "thead", "td", "tr"].includes(tag)) continue;
        offenders.push(`${f.slice(f.indexOf("/src/"))}: <${tag}> "${cls.slice(0, 50)}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
