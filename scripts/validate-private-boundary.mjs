import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const trackedFiles = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const pathPatterns = [
  {
    name: "private submission-gate implementation path",
    regex:
      /(^|\/)(?:private-reviewer|review-corpus|review-fixtures|private-prompts|accepted-rejected-examples|metagraphed-submission-gate-private)(?:\/|$)/i,
  },
];

const contentPatterns = [
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

const allowedContentMentions = new Set([
  "docs/submission-gate.md",
  "CONTRIBUTING.md",
  "scripts/submission-notifications.mjs",
  "scripts/validate-private-boundary.mjs",
  "tests/submission-gate.test.mjs",
]);

const findings = [];

for (const file of trackedFiles) {
  for (const pattern of pathPatterns) {
    if (pattern.regex.test(file)) {
      findings.push(`${file}: ${pattern.name}`);
    }
  }

  if (isBinaryOrLarge(file)) {
    continue;
  }

  const content = await fs.readFile(path.join(repoRoot, file), "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const pattern of contentPatterns) {
      if (!pattern.regex.test(line)) {
        continue;
      }
      if (
        pattern.name !== "real Discord webhook URL" &&
        allowedContentMentions.has(file)
      ) {
        continue;
      }
      findings.push(`${file}:${index + 1}: ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error(
    `Private-boundary validation found ${findings.length} issue(s):`,
  );
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Private-boundary validation passed.");

function isBinaryOrLarge(file) {
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
