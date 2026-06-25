// Tiering invariant for the public artifact registry. artifactStorageTier*()
// returns the `git` tier for ANY path that matches NEITHER R2_ONLY_PATTERNS nor
// DUAL_PATTERNS — a silent default, not an opt-in (the #998 mis-tiering
// landmine: review/profile-completeness.json was committed as `git` only because
// it was absent from both lists, which broke the reproducibility gate). That was
// only ever caught reactively. This test makes it deterministic: every
// PUBLIC_ARTIFACTS path must resolve to an EXPLICIT R2-only or dual pattern, so a
// new artifact that falls through to the default-git fallback fails here at PR
// time instead of in a production refresh.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { PUBLIC_ARTIFACTS } from "../src/contracts.mjs";
import {
  DUAL_PATTERNS,
  R2_ONLY_PATTERNS,
  artifactRelativePath,
} from "../src/artifact-storage.mjs";

// Concrete sample values for the path-template tokens, mirroring
// scripts/smoke-live-api.mjs so a templated path resolves to a real-shaped
// relative path before pattern matching (the patterns also accept the literal
// `{token}` form, but substituting proves a *concrete* request path tiers
// explicitly too).
const TOKEN_SAMPLES = {
  "{netuid}": "7",
  "{slug}": "allways",
  "{date}": "2026-06-24",
  "{surface_id}": "allways-rest-api",
  "{uid}": "0",
  "{ss58}": "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
  "{ref}": "0",
  "{hash}": `0x${"0".repeat(64)}`,
};

function substituteTemplate(path) {
  let resolved = path;
  for (const [token, sample] of Object.entries(TOKEN_SAMPLES)) {
    resolved = resolved.split(token).join(sample);
  }
  return resolved;
}

function matchesExplicitTier(relativePath) {
  return (
    R2_ONLY_PATTERNS.some((pattern) => pattern.test(relativePath)) ||
    DUAL_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

describe("PUBLIC_ARTIFACTS storage tiering is explicit", () => {
  test("every artifact path matches an explicit R2-only or dual pattern", () => {
    const fellThroughToGit = [];
    for (const entry of PUBLIC_ARTIFACTS) {
      const relativePath = artifactRelativePath(substituteTemplate(entry.path));
      if (!matchesExplicitTier(relativePath)) {
        fellThroughToGit.push(`${entry.id} (${entry.path})`);
      }
    }
    assert.equal(
      fellThroughToGit.length,
      0,
      `These PUBLIC_ARTIFACTS paths match NO explicit R2_ONLY_PATTERNS or ` +
        `DUAL_PATTERNS entry and only resolve to the default-git fallback in ` +
        `src/artifact-storage.mjs — add an explicit pattern (the #998 ` +
        `mis-tiering landmine):\n  ${fellThroughToGit.join("\n  ")}`,
    );
  });

  // Sanity-check the assertion DIRECTION: a path that matches neither pattern
  // list (the default-git fallback) must be reported, so a real fall-through is
  // never a false pass.
  test("a path outside both pattern lists is detected as default-git", () => {
    assert.equal(
      matchesExplicitTier(
        artifactRelativePath("/metagraph/not-a-real-artifact.json"),
      ),
      false,
    );
  });
});
