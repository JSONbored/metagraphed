// Shared leak-detection patterns for the private-boundary CI gate
// (`scripts/validate-private-boundary.mjs`, #7236). Kept importable so unit
// tests can exercise every regex, the allowlist carve-out, and the
// binary/generated skip list without running the full `git ls-files` walk.
//
// Security posture (locked in by tests):
// - A real Discord webhook URL is NEVER allowlisted — even CONTRIBUTING.md /
//   this module / the validator / the test file still fail CI on a live URL.
// - Other private-implementation phrases are exempted only in the small
//   allowlist of files that must mention them to define or document the gate.

/** @typedef {{ name: string, regex: RegExp }} BoundaryPattern */

/** @type {BoundaryPattern[]} */
export const pathPatterns = [
  {
    name: "private submission-gate implementation path",
    regex:
      /(^|\/)(?:private-reviewer|review-corpus|review-fixtures|private-prompts|accepted-rejected-examples|metagraphed-submission-gate-private)(?:\/|$)/i,
  },
];

/** @type {BoundaryPattern[]} */
export const contentPatterns = [
  {
    name: "real Discord webhook URL",
    regex:
      /https:\/\/(?:discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]{20,}/,
  },
  {
    name: "private AI scoring internals",
    regex:
      /\b(?:private prompt|private rubric|private score|private threshold|corpus weight|accepted rejected example|accepted\/rejected example)\b/i,
  },
  {
    name: "provider-specific private model route",
    regex: /\b(?:AI_GATEWAY|WORKERS_AI|@cf\/openai\/|gpt-oss-)\b/i,
  },
];

/**
 * Files allowed to mention non-Discord private-implementation phrases (because
 * they define, document, or unit-test the gate). A real Discord webhook URL is
 * still a finding in every one of these files.
 *
 * @type {ReadonlySet<string>}
 */
export const allowedContentMentions = new Set([
  "CONTRIBUTING.md",
  // Validator entrypoint — may describe the gate in comments.
  "scripts/validate-private-boundary.mjs",
  // This module defines the patterns themselves, so it self-matches.
  "scripts/lib/private-boundary.mjs",
  // Unit tests must quote private phrases (match + adjacent non-match cases).
  "tests/validate-private-boundary.test.mjs",
]);

/** Exact image extensions skipped by the content walk. */
export const BINARY_EXTENSIONS = Object.freeze([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
]);

/** Exact path prefixes treated as generated and skipped by the content walk. */
export const GENERATED_PREFIXES = Object.freeze(["public/metagraph/"]);

/**
 * Whether a tracked path is binary or generated and should skip content scan.
 * @param {string} file
 * @returns {boolean}
 */
export function isBinaryOrGenerated(file) {
  if (typeof file !== "string" || file.length === 0) {
    return false;
  }
  for (const ext of BINARY_EXTENSIONS) {
    if (file.endsWith(ext)) {
      return true;
    }
  }
  for (const prefix of GENERATED_PREFIXES) {
    if (file.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a content finding for `patternName` in `file` should be suppressed
 * by the allowlist. Discord webhook URLs are never suppressed.
 *
 * @param {string} file
 * @param {string} patternName
 * @returns {boolean}
 */
export function isContentFindingAllowed(file, patternName) {
  if (patternName === "real Discord webhook URL") {
    return false;
  }
  return allowedContentMentions.has(file);
}

/**
 * Collect content-pattern hits for one line of text.
 *
 * @param {string} text
 * @param {{ file?: string }} [options]
 * @returns {Array<{ name: string, match: string }>}
 */
export function findContentPatternHits(text, { file = null } = {}) {
  if (typeof text !== "string") {
    return [];
  }
  const hits = [];
  for (const pattern of contentPatterns) {
    // Reset lastIndex in case a caller shares a sticky regex later.
    pattern.regex.lastIndex = 0;
    const match = text.match(pattern.regex);
    if (!match) {
      continue;
    }
    if (file && isContentFindingAllowed(file, pattern.name)) {
      continue;
    }
    hits.push({ name: pattern.name, match: match[0] });
  }
  return hits;
}

/**
 * Collect path-pattern hits for one tracked path.
 *
 * @param {string} file
 * @returns {Array<{ name: string, match: string }>}
 */
export function findPathPatternHits(file) {
  if (typeof file !== "string") {
    return [];
  }
  const hits = [];
  for (const pattern of pathPatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(file)) {
      hits.push({ name: pattern.name, match: file });
    }
  }
  return hits;
}
