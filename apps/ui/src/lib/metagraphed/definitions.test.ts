import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DEFINITIONS } from "./definitions";

// Every `<Definition term="…">` in the tree must have a sentence; a term that
// is not in the glossary renders nothing, silently.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const ROOTS = [
  path.resolve(__dirname, "../../"),
  path.resolve(__dirname, "../../../../../packages/ui-kit/src"),
];
// A <Definition> with a `sentence` prop brings its own copy; only the
// glossary lookups (term alone) must be defined here.
const TAG = /<Definition\b(?:[^>]|\n)*?>/g;
const TERM = /\bterm=(?:"([^"]+)"|\{"([^"]+)"\})/;

describe("definitions glossary", () => {
  it("defines every term used by a <Definition> in TSX", () => {
    const missing: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        for (const tag of src.matchAll(TAG)) {
          if (/\bsentence=/.test(tag[0])) continue;
          const m = TERM.exec(tag[0]);
          if (!m) continue;
          const term = m[1] ?? m[2]!;
          if (term === "…") continue; // the primitive's own doc comment
          if (!(term in DEFINITIONS)) missing.push(`${path.relative(root, file)}: ${term}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every sentence is one plain sentence ending with a full stop", () => {
    for (const [term, sentence] of Object.entries(DEFINITIONS)) {
      expect(sentence.trim().endsWith("."), term).toBe(true);
      expect(sentence.length, term).toBeLessThanOrEqual(140);
      expect((sentence.match(/\. /g) ?? []).length, `${term} has more than one sentence`).toBe(0);
    }
  });
});
