// The private-boundary detection patterns + helpers, extracted from
// scripts/validate-private-boundary.mjs (#7236) so they are unit-testable
// without running that validator's full `git ls-files` walk (which it does at
// module scope). The validator imports everything below and is otherwise
// unchanged; keeping these as plain data/pure functions here is what lets a
// test assert each regex's match/non-match behavior directly.

export const pathPatterns = [
  {
    name: "private submission-gate implementation path",
    regex:
      /(^|\/)(?:private-reviewer|review-corpus|review-fixtures|private-prompts|accepted-rejected-examples|metagraphed-submission-gate-private)(?:\/|$)/i,
  },
];

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

export const allowedContentMentions = new Set([
  "CONTRIBUTING.md",
  // These two files define the boundary patterns themselves, so they self-match
  // (each phrase-pattern alternation literally contains the phrases it detects).
  // Exempted from non-Discord findings only -- see isExemptFinding.
  "scripts/validate-private-boundary.mjs",
  "scripts/lib/private-boundary-patterns.mjs",
]);

// The allowlist carve-out: an allowed file is exempt from a finding UNLESS that
// finding is a real Discord webhook URL. A leaked webhook is a live secret even
// in a doc/self-referential file, so it is never exempted -- everything else
// (private-implementation phrasing, provider routes) can legitimately appear in
// CONTRIBUTING.md or in these pattern-defining files.
export function isExemptFinding(file, patternName) {
  return (
    patternName !== "real Discord webhook URL" &&
    allowedContentMentions.has(file)
  );
}

export function isBinaryOrGenerated(file) {
  return (
    file.endsWith(".png") ||
    file.endsWith(".jpg") ||
    file.endsWith(".jpeg") ||
    file.endsWith(".gif") ||
    file.endsWith(".webp") ||
    file.endsWith(".ico") ||
    file.startsWith("public/metagraph/")
  );
}
