// Exports nothing imports -- a ceiling that only falls (#10292).
//
// `validate:unreferenced-modules` (#10221) gates whole FILES and deliberately
// declined the export half, saying so in its own header: knip reported 1,135
// unused exports on this tree, and "a gate whose first run needs 1,135 hand
// decisions is a gate nobody turns on."
//
// That reasoning was right about the hand decisions and wrong about the
// conclusion, because the alternative to 1,135 decisions is not "no gate" --
// it is a RATCHET. The count goes in one place, it fails when it grows, and it
// fails when it falls without being lowered. Nobody has to adjudicate 880
// symbols today, and nobody can add the 753rd without saying so.
//
// ## What the number is made of, measured 2026-08-10
//
// 752 after #10582 (1,135 at filing, 880 when this gate landed). Where they
// live is the whole story:
//
//   746  schemas-src/**   the contract's type vocabulary
//     6  src/**           the actual residue, in four files
//
// The schema layer's exports are not orphans in the ordinary sense. 250 of them
// ARE published contract components -- `SubnetsArtifact` is a `z.infer` alias
// whose name appears in `packages/contract/index.d.ts` and is referenced from
// `src/contracts.ts` AS A STRING. knip cannot see a linkage made by name
// through a registry, and no static tool can.
//
// The 164 precomputed `XResponseSchema` envelopes that made up most of the
// rest are GONE (#10582): nothing in the serving path read them, because
// `src/response-validation-tripwire.ts` composes the envelope itself from the
// registry. That is where 880 -> 752 came from.
//
// ## Why the count is not zero, and why that is not a failure
//
// Zero is not reachable while a contract component's TS name is linked by
// string. Pretending otherwise would mean an 880-entry allowlist, which is
// worse than a number: an exemption list stops being read the moment it is
// longer than a screen, and it hides exactly the thing it names. Same shape as
// scripts/validate-ui-route-coverage.ts and
// scripts/validate-untyped-db-reads.ts, for the same reason.
//
// ## Scoped to exports
//
// knip also reports unused dependencies, unlisted binaries and unresolved
// imports. Those are real and separate -- several are workspace-resolution
// artefacts rather than defects -- so this gate asks knip for `exports,types`
// only. Widening it would mean adopting that triage too, which is how a gate
// ends up disabled.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib.ts";

/**
 * The most unreferenced exports allowed. THE CEILING ONLY FALLS.
 *
 * 752 after #10582 deleted the 164 precomputed response envelopes.
 *
 * Then lower again (#10586): nothing was deleted.
 * `scripts/validate-schema-vocabularies.ts` loads its mirror modules through
 * literal import specifiers, so knip can see `schemas-src/shared.ts` and
 * `schemas-src/routes/subnet-detail.ts` as reached from an entry -- exports
 * that were only ever counted as unreferenced because the linkage was
 * invisible, not because nothing used them. A measurement fix, and the ceiling
 * takes it the same way it takes a deletion.
 *
 * 737 after #10782, which took `Row` off `any` and fixed the 214 errors that
 * hid behind it. Nothing was deleted to earn this one either: the narrowing
 * moved a single export across the referenced/unreferenced line, and the
 * ceiling takes a measurement change the same way it takes a deletion.
 */
export const MAX_UNREFERENCED_EXPORTS: number = 737;

/** knip's JSON shape, as much of it as this gate reads. */
interface KnipIssue {
  file?: string;
  exports?: unknown[];
  types?: unknown[];
}
interface KnipReport {
  issues?: KnipIssue[];
}

export function countUnreferenced(report: KnipReport): {
  total: number;
  byDirectory: Map<string, number>;
} {
  const byDirectory = new Map<string, number>();
  let total = 0;
  for (const issue of report.issues ?? []) {
    const count = (issue.exports?.length ?? 0) + (issue.types?.length ?? 0);
    if (count === 0) continue;
    total += count;
    // Two segments is the useful grain here: it separates `schemas-src/routes`
    // from `schemas-src/mcp-tools` without printing 245 file rows.
    const dir = (issue.file ?? "?").split("/").slice(0, 2).join("/");
    byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + count);
  }
  return { total, byDirectory };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

function main(): void {
  // knip exits non-zero whenever it reports anything, which is the behaviour
  // this ratchet replaces -- so its status is deliberately ignored and only its
  // JSON is read. A knip that genuinely failed to run emits no parsable JSON,
  // which is caught below rather than silently counted as zero.
  let raw: string;
  try {
    raw = execFileSync(
      "npx",
      [
        "knip",
        "--no-progress",
        "--include",
        "exports,types",
        "--reporter",
        "json",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (typeof output !== "string" || output.trim() === "") {
      console.error(
        "knip produced no report -- the gate cannot count what it cannot run.",
      );
      process.exit(1);
    }
    raw = output;
  }

  let report: KnipReport;
  try {
    report = JSON.parse(raw) as KnipReport;
  } catch {
    console.error(
      "knip's output was not JSON -- refusing to report a count from it.",
    );
    process.exit(1);
  }

  const { total, byDirectory } = countUnreferenced(report);

  if (total > MAX_UNREFERENCED_EXPORTS) {
    console.error(
      `Unreferenced exports regressed: ${total}, ceiling is ${MAX_UNREFERENCED_EXPORTS}.\n` +
        `An export nothing imports is either dead or linked by a name no tool can see; ` +
        `say which, or delete it.\n` +
        [...byDirectory]
          .sort((a, b) => b[1] - a[1])
          .map(([dir, n]) => `  ${String(n).padStart(4)}  ${dir}`)
          .join("\n"),
    );
    process.exit(1);
  }

  if (total < MAX_UNREFERENCED_EXPORTS) {
    console.error(
      `Unreferenced exports improved: ${total}, ceiling is ${MAX_UNREFERENCED_EXPORTS}. ` +
        `Lower MAX_UNREFERENCED_EXPORTS in scripts/validate-unreferenced-exports.ts ` +
        `to ${total} so the gain is locked in -- a ceiling nobody lowers stops being a ratchet.`,
    );
    process.exit(1);
  }

  console.log(
    `Unreferenced exports: ${total} at the ceiling, across ${byDirectory.size} director(ies).`,
  );
}
