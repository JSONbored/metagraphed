// The leak-detection patterns, allowlist carve-out, and binary/generated skip
// behind scripts/validate-private-boundary.ts's CI gate (#7236). Extracted into
// this side-effect-free module so the regexes and the allowlist decision are
// unit-testable directly, without running the validator's full git-ls-files
// walk (which executes at its import time). validate-private-boundary.ts
// imports these — the walk logic stays there; only the patterns/decision live
// here, so the gate's behavior is unchanged.

export const pathPatterns: { name: string; regex: RegExp }[] = [
  {
    name: "private submission-gate implementation path",
    regex:
      /(^|\/)(?:private-reviewer|review-corpus|review-fixtures|private-prompts|accepted-rejected-examples|metagraphed-submission-gate-private)(?:\/|$)/i,
  },
];

export const contentPatterns: { name: string; regex: RegExp }[] = [
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
  // These three define/exercise the boundary patterns themselves, so they
  // self-match on the non-Discord patterns (a real Discord webhook URL is still
  // never exempted, per isAllowedContentMention).
  "scripts/validate-private-boundary.ts",
  "scripts/private-boundary-patterns.ts",
  "tests/private-boundary-patterns.test.mjs",
]);

// A content-pattern finding on `file` for `patternName` is suppressed only when
// it is a NON-Discord-URL pattern AND `file` is on the content-mentions
// allowlist (CONTRIBUTING.md, the validator itself — files that legitimately
// describe the boundary). A real Discord webhook URL is NEVER exempted: that's a
// live secret regardless of which file it appears in.
export function isAllowedContentMention(
  file: string,
  patternName: string,
): boolean {
  return (
    patternName !== "real Discord webhook URL" &&
    allowedContentMentions.has(file)
  );
}

export function isBinaryOrGenerated(file: string): boolean {
  return (
    file.endsWith(".png") ||
    file.endsWith(".jpg") ||
    file.endsWith(".jpeg") ||
    file.endsWith(".gif") ||
    file.endsWith(".webp") ||
    file.endsWith(".ico") ||
    file.startsWith("public/metagraph/") ||
    // wrangler-generated Env/runtime types (npm run types:workers) -- never
    // hand-edited (see .prettierignore/eslint.config.mjs's own carve-out for
    // these same 3 files). Cloudflare's own public Workers AI model catalog
    // now includes real, public model ids like "@cf/openai/gpt-oss-120b" that
    // collide with the "provider-specific private model route" pattern above,
    // which targets a DIFFERENT, actually-private internal route -- a false
    // positive on Cloudflare's own generated content, not a real leak.
    file.endsWith("worker-configuration.d.ts")
  );
}
