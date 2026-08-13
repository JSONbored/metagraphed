// The published contract may not name a store we deleted (#10951).
//
// #10910 took `contracts.json` from 49 route descriptions claiming "served live
// from D1" to zero. That is the text API consumers read: it becomes
// `openapi.json`, the generated client's doc comments, and 284 docs pages. Two
// of those descriptions were error bodies -- callers were answered
// `{"error":"d1 write failed"}` naming a database that had not existed for
// weeks.
//
// Nothing kept it at zero. `src/contracts.ts` and `schemas-src/` are hand-edited
// constantly, and the only D1-related gate in CI guards the BINDING
// (validate-worker-types-parity's `d1_databases` key), not the prose. A tier
// gets retired roughly once a year here; the text describing it outlives it by
// months, and the gap is invisible because nothing red ever appears.
//
// ## Why this is a set, not a string
//
// D1 is the second store to be retired (the self-hosted Postgres box went in
// #9426). Writing this gate for `D1` alone would mean writing it again for the
// next one, which is how a check ends up existing for exactly one historical
// incident. RETIRED_STORES is the vocabulary; adding a name to it is the whole
// cost of getting the ratchet for free next time.
//
// ## Why the exceptions are exact strings
//
// Past-tense narration is legitimate and must survive: a description that says
// an aggregate is null "on a cold retired-D1 store" is telling a caller
// something true about the shape they will get. But a regex carve-out for
// "retired" would also pass "served live from D1 (the retired tier)" -- the
// exemption widens silently, which is the failure mode a carve-out always has.
// Each allowed phrase is therefore an EXACT string, and an entry that stops
// matching anything fails too, so the list cannot rot into a blanket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

/** Stores whose names must not appear in published text, and when each went. */
export const RETIRED_STORES: {
  name: string;
  pattern: RegExp;
  retired: string;
}[] = [
  {
    name: "D1",
    pattern: /\bD1\b/g,
    retired: "2026-07-16 (#4772/#4909, finished by #10179)",
  },
];

/**
 * Published phrases allowed to name a retired store, verbatim.
 *
 * Each is past-tense narration a caller benefits from. Exact strings rather
 * than a pattern: see the header.
 */
export const ALLOWED_PHRASES: string[] = ["a cold retired-D1 store"];

/** The artifacts whose every string is consumer-facing text. */
const PUBLISHED = [
  "public/metagraph/contracts.json",
  "public/metagraph/openapi.json",
];

export interface Violation {
  file: string;
  store: string;
  context: string;
}

/** Strip the allowed phrases, then look for what is left. */
export function findViolations(
  file: string,
  text: string,
  stores = RETIRED_STORES,
  allowed = ALLOWED_PHRASES,
): Violation[] {
  let scanned = text;
  for (const phrase of allowed) scanned = scanned.split(phrase).join("");
  const out: Violation[] = [];
  for (const store of stores) {
    for (const match of scanned.matchAll(store.pattern)) {
      const at = match.index ?? 0;
      out.push({
        file,
        store: store.name,
        context: scanned
          .slice(Math.max(0, at - 60), at + 60)
          .replace(/\s+/g, " "),
      });
    }
  }
  return out;
}

/** Allowed phrases that no longer appear anywhere published.
 *
 * The other half of the ratchet. An exemption for text that has since been
 * rewritten is an exemption nobody is checking, and the next person to read the
 * list would reasonably assume every entry is still load-bearing. */
export function staleAllowances(
  texts: string[],
  allowed = ALLOWED_PHRASES,
): string[] {
  return allowed.filter((phrase) => !texts.some((t) => t.includes(phrase)));
}

function main(): void {
  const texts: string[] = [];
  const violations: Violation[] = [];
  for (const rel of PUBLISHED) {
    const text = readFileSync(path.join(repoRoot, rel), "utf8");
    texts.push(text);
    violations.push(...findViolations(rel, text));
  }

  const stale = staleAllowances(texts);
  if (violations.length === 0 && stale.length === 0) {
    console.log(
      `✓ Published contract names no retired store ` +
        `(${RETIRED_STORES.map((s) => s.name).join(", ")}); ` +
        `${ALLOWED_PHRASES.length} allowed phrase(s), all still present.`,
    );
    return;
  }

  if (violations.length > 0) {
    console.error(
      `Published contract names a retired store in ${violations.length} place(s):\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.store} — …${v.context}…`);
    }
    console.error(
      `\nThese strings are what API consumers read: they become openapi.json, the\n` +
        `generated client's doc comments and the docs site. Rewrite the description in\n` +
        `src/contracts.ts or schemas-src/ and re-run \`npm run build\`. If the text is\n` +
        `deliberate past-tense narration, add the EXACT phrase to ALLOWED_PHRASES in\n` +
        `scripts/validate-retired-store-vocabulary.ts with the reason.`,
    );
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} allowed phrase(s) no longer appear in the published contract:\n` +
        stale.map((p) => `  ${JSON.stringify(p)}`).join("\n") +
        `\n\nRemove them from ALLOWED_PHRASES so the exemption list cannot outlive the\n` +
        `text it was written for.`,
    );
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
