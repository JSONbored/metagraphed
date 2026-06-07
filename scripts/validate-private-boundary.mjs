import { execFileSync } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
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

  if (isBinaryOrGenerated(file)) {
    continue;
  }

  const absolutePath = path.join(repoRoot, file);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    console.warn(`Skipping unreadable path ${file}: ${error.message}`);
    continue;
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    continue;
  }

  let lines;
  try {
    lines = createInterface({
      input: createReadStream(absolutePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
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
        findings.push(`${file}:${lineNumber}: ${pattern.name}`);
      }
    }
  } catch (error) {
    console.warn(`Skipping unreadable file ${file}: ${error.message}`);
    lines?.close();
    continue;
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

function isBinaryOrGenerated(file) {
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
