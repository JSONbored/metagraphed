// Contract ↔ prose-doc drift gate (#9564).
//
// `src/contracts.ts` carries the description every consumer reads (it lands in
// public/metagraph/contracts.json + api-index.json, which `validate:contract-drift`
// forces a PR to regenerate). `docs/backend-artifact-contracts.md` says the same
// things in prose, one bullet per artifact/route -- but nothing linked the two.
// `validate:docs` only checks that each path APPEARS somewhere in the doc, so a
// PR could rewrite what a route actually serves, regenerate the catalog, and
// leave the prose asserting the opposite. #9545 did exactly that: it composed
// the top-holders holdings columns live from D1 and rewrote both descriptions,
// while the doc kept calling those columns blocked and permanently frozen
// (#9562) -- a reader following the doc would have read a live ranking as a
// historical snapshot.
//
// This gate is diff-scoped like validate-client-sdk-sync.ts: it compares the
// generated catalogs at the merge base against the working tree, and fails when
// an entry's description changed in a way that MATTERS to the prose while that
// entry's doc bullet stayed byte-identical.
//
// "Matters to the prose" is the CLAIM VECTOR below -- the tier / liveness /
// provenance vocabulary the doc tracks per bullet (which store answers, whether
// it is live or declining to a fixed snapshot, whether it is retired). Gating on
// ANY description edit was measured over the last 80 commits touching the
// catalogs: 36 changed a description and 30 would have fired, i.e. most contract
// PRs, including ones with no prose consequence at all (a new ?format=csv
// parameter, a reworded sentence). Gating on the claim vector instead fires on
// 13 of those 80 -- and nearly every one is a real tier/liveness change the doc
// bullet was silently outliving ("describe the hyperparams tier as Postgres, not
// D1", "mark retired health artifacts", "serve the upgrade timeline from the
// lakehouse", and #9545 itself.)
//
// A description edit that leaves the claim vector alone is not drift and never
// fires. An entry with no bullet of its own is skipped -- per-path coverage is
// validate-docs.ts's job, not this one's.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.ts";

export const ARTIFACT_CATALOG_PATH = "public/metagraph/contracts.json";
export const ROUTE_INDEX_PATH = "public/metagraph/api-index.json";
export const DOC_PATH = "docs/backend-artifact-contracts.md";

// The vocabulary the prose doc actually commits to per bullet. Presence, not
// count: a description that gains "lakehouse" or loses "frozen" has changed what
// the bullet above it is claiming; one that gains a query parameter has not.
export const CLAIM_TOKENS: { name: string; re: RegExp }[] = [
  { name: "live", re: /\blive\b/i },
  { name: "not-live", re: /\bnot\s+live\b/i },
  { name: "frozen", re: /\bfrozen\b/i },
  { name: "materialization", re: /\bmaterializ/i },
  { name: "declines", re: /\bdeclin(?:e|es|ing)\b/i },
  { name: "degraded", re: /\bdegrad/i },
  { name: "retired", re: /\bretired\b/i },
  { name: "blocked", re: /\bblocked\b/i },
  { name: "unproven", re: /\bunproven\b/i },
  {
    name: "complete-pass",
    re: /\b(?:complete\s+pass|recorded\s+complete|provably\s+complete)\b/i,
  },
  { name: "d1", re: /\bD1\b/ },
  { name: "postgres", re: /\bpostgres/i },
  { name: "lakehouse", re: /\blakehouse\b/i },
  { name: "r2", re: /\bR2\b/ },
  { name: "kv", re: /\bKV\b/ },
  { name: "analytics-engine", re: /\banalytics engine\b/i },
  { name: "chain-state", re: /\bchain[- ]state\b/i },
  { name: "no-static-file", re: /\bno static file\b/i },
  { name: "projection-lane", re: /\bprojection lane\b/i },
  { name: "snapshot", re: /\bsnapshot/i },
];

export const SYNC_FAILURE_HINT =
  "review each doc bullet above against the new description in src/contracts.ts " +
  "and update it (or restate it) in this PR. The doc is the prose half of the " +
  "same contract — a bullet that outlives the behavior it describes is worse " +
  "than no bullet at all.";

/** Claim tokens present in one description, sorted and de-duplicated. */
export function claimVector(description: string): string[] {
  return CLAIM_TOKENS.filter(({ re }) => re.test(description)).map(
    ({ name }) => name,
  );
}

/** path → description for one generated catalog. `key` is "artifacts" or "routes". */
export function descriptionsFromCatalog(
  catalog: unknown,
  key: "artifacts" | "routes",
): Map<string, string> {
  const entries = (catalog as Record<string, unknown> | null)?.[key];
  const out = new Map<string, string>();
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const entryPath = (entry as { path?: unknown }).path;
    if (typeof entryPath !== "string") continue;
    const description = (entry as { description?: unknown }).description;
    out.set(entryPath, typeof description === "string" ? description : "");
  }
  return out;
}

/**
 * The doc bullet that documents `entryPath` — a list item whose LEADING token is
 * the backticked path (`- \`/api/v1/x\`: ...`). Deliberately not a substring
 * match: /api/v1/accounts is quoted inside the /api/v1/accounts/top-holders
 * bullet, and attributing drift to the wrong bullet is worse than missing it.
 */
export function docBulletFor(
  docText: string,
  entryPath: string,
): { line: number; text: string } | null {
  const prefix = `- \`${entryPath}\``;
  const lines = docText.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith(prefix)) {
      return { line: index + 1, text: lines[index] };
    }
  }
  return null;
}

export interface ContractDocDrift {
  path: string;
  docLine: number;
  gained: string[];
  lost: string[];
}

/**
 * Does this bullet already say what the new description says? True when the
 * prose carries every claim the description GAINED and none of the ones it
 * LOST -- which is agreement, not staleness, and must not be reported as drift.
 *
 * #9575: without this the gate fired on 47 entries of #9573, a PR that
 * corrected src/contracts.ts to match bullets that ALREADY said D1. The only
 * way to satisfy it was to edit a line that was right, which is the token-edit
 * failure mode the claim vector exists to avoid. Checking agreement is what the
 * gate is for; "was the bullet edited" was only ever a proxy for it.
 */
function bulletAlreadyAgrees(
  bulletText: string,
  gained: string[],
  lost: string[],
): boolean {
  const bulletTokens = claimVector(bulletText);
  return (
    gained.every((token) => bulletTokens.includes(token)) &&
    lost.every((token) => !bulletTokens.includes(token))
  );
}

/**
 * Pure decision function (unit-tested). Drift is: the entry existed at the base,
 * its claim vector changed, it has a bullet, that bullet is byte-identical to
 * the base's, AND the bullet does not already agree with the new claims.
 */
export function evaluateContractDocSync({
  baseDescriptions,
  headDescriptions,
  baseDoc,
  headDoc,
}: {
  baseDescriptions: Map<string, string>;
  headDescriptions: Map<string, string>;
  baseDoc: string;
  headDoc: string;
}): { drift: ContractDocDrift[]; ok: boolean } {
  const drift: ContractDocDrift[] = [];
  for (const [entryPath, headDescription] of headDescriptions) {
    const baseDescription = baseDescriptions.get(entryPath);
    // A brand-new entry has no prose to keep in sync; validate-docs.ts is what
    // requires it to be documented at all.
    if (baseDescription === undefined) continue;
    if (baseDescription === headDescription) continue;

    const before = claimVector(baseDescription);
    const after = claimVector(headDescription);
    if (before.join(",") === after.join(",")) continue;

    const headBullet = docBulletFor(headDoc, entryPath);
    const baseBullet = docBulletFor(baseDoc, entryPath);
    if (!headBullet || !baseBullet) continue;
    if (headBullet.text !== baseBullet.text) continue;

    const gained = after.filter((token) => !before.includes(token));
    const lost = before.filter((token) => !after.includes(token));
    if (bulletAlreadyAgrees(headBullet.text, gained, lost)) continue;

    drift.push({
      path: entryPath,
      docLine: headBullet.line,
      gained,
      lost,
    });
  }
  return { drift, ok: drift.length === 0 };
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
}

// Same merge-base resolution as validate-client-sdk-sync.ts: never diff the two
// endpoints directly, or a stale branch reports files that moved only on base.
export function resolveDiffBase({
  explicitBase,
  baseRef,
  headRef,
  gitFn,
}: {
  explicitBase: string | undefined;
  baseRef: string;
  headRef: string;
  gitFn: (args: string[]) => string;
}): string | null {
  const attempts = explicitBase
    ? [explicitBase]
    : [`origin/${baseRef}`, baseRef];
  for (const candidate of attempts) {
    try {
      return gitFn(["merge-base", candidate, headRef]).trim();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Which commit the HEAD side is read from: the explicit head ref when one was
 * supplied, or `null` meaning "the working tree". Exported so the choice itself
 * is unit-tested -- it is the whole of the #9575 fix.
 */
export function headReadRef(explicitHead: string | undefined): string | null {
  return explicitHead ? explicitHead : null;
}

function readAtRef(ref: string, filePath: string): string | null {
  try {
    return git(["show", `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // An EXPLICIT head ref (CI always passes the PR head SHA) is read from git;
  // only a local run with none falls back to the working tree. #9575: reading
  // the head side from the working tree on a PR compares the merge base against
  // the MERGE COMMIT, so every contract change that landed on the base branch
  // since the fork point is diffed as though this PR made it -- #9574 inherited
  // 47 entries from two PRs it had nothing to do with. Same reason
  // validate-client-sdk-sync.ts diffs fork-point -> HEAD_SHA with explicit refs.
  const explicitHead = valueAfter("--head-sha") || process.env.HEAD_SHA;
  const headRef = explicitHead || "HEAD";
  const baseRef = resolveDiffBase({
    explicitBase: valueAfter("--base-sha") || process.env.BASE_SHA,
    baseRef: valueAfter("--base-ref") || process.env.BASE_REF || "main",
    headRef,
    gitFn: git,
  });

  if (!baseRef) {
    console.log(
      "ℹ Contract↔doc sync: no merge base resolvable (shallow clone or no " +
        "origin/main) — gate skipped.",
    );
    return;
  }

  const baseArtifacts = readAtRef(baseRef, ARTIFACT_CATALOG_PATH);
  const baseRoutes = readAtRef(baseRef, ROUTE_INDEX_PATH);
  const baseDoc = readAtRef(baseRef, DOC_PATH);
  if (baseArtifacts === null || baseRoutes === null || baseDoc === null) {
    console.log(
      `ℹ Contract↔doc sync: a tracked file is absent at ${baseRef.slice(0, 9)} — gate skipped.`,
    );
    return;
  }

  // With an explicit head ref, read that commit; otherwise the working tree, so
  // a local run still sees an uncommitted doc edit.
  const headSource = headReadRef(explicitHead);
  const readHeadText = async (filePath: string): Promise<string | null> =>
    headSource
      ? readAtRef(headSource, filePath)
      : await fs.readFile(path.join(repoRoot, filePath), "utf8");

  const headDoc = await readHeadText(DOC_PATH);
  const headArtifacts = await readHeadText(ARTIFACT_CATALOG_PATH);
  const headRoutes = await readHeadText(ROUTE_INDEX_PATH);
  if (headDoc === null || headArtifacts === null || headRoutes === null) {
    console.log(
      `ℹ Contract↔doc sync: a tracked file is absent at ${headRef.slice(0, 9)} — gate skipped.`,
    );
    return;
  }
  const readHead = (contents: string): unknown => JSON.parse(contents);

  const drift = [
    evaluateContractDocSync({
      baseDescriptions: descriptionsFromCatalog(
        JSON.parse(baseArtifacts),
        "artifacts",
      ),
      headDescriptions: descriptionsFromCatalog(
        readHead(headArtifacts),
        "artifacts",
      ),
      baseDoc,
      headDoc,
    }),
    evaluateContractDocSync({
      baseDescriptions: descriptionsFromCatalog(
        JSON.parse(baseRoutes),
        "routes",
      ),
      headDescriptions: descriptionsFromCatalog(readHead(headRoutes), "routes"),
      baseDoc,
      headDoc,
    }),
  ].flatMap((result) => result.drift);

  if (drift.length === 0) {
    console.log("✓ Contract↔doc sync: no unreviewed prose drift.");
    return;
  }

  const one = drift.length === 1;
  console.error(
    `Contract↔doc drift: ${drift.length} entr${one ? "y" : "ies"} changed what ` +
      `${one ? "it claims" : "they claim"} to serve, but ${one ? "its" : "their"} ` +
      `${DOC_PATH} bullet did not move:`,
  );
  for (const entry of drift) {
    const gained = entry.gained.length ? `+${entry.gained.join(" +")}` : "";
    const lost = entry.lost.length ? `-${entry.lost.join(" -")}` : "";
    console.error(
      `- ${entry.path} — ${DOC_PATH}:${entry.docLine} (${[gained, lost].filter(Boolean).join(" ")})`,
    );
  }
  console.error(`\n${SYNC_FAILURE_HINT}`);
  process.exitCode = 1;
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
