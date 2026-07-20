import { execFileSync } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.mjs";

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
  // This file defines the boundary patterns themselves, so it self-matches.
  "scripts/validate-private-boundary.mjs",
]);

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

/**
 * Path-boundary check for one tracked file path: the names of the path patterns
 * it violates (a private-implementation directory that must never be committed).
 */
export function pathMatches(file) {
  return pathPatterns.filter((p) => p.regex.test(file)).map((p) => p.name);
}

/**
 * Content leak-detection for one piece of text (a file line or a symlink
 * target), scoped to the file it came from: the names of the content patterns
 * it trips. Honors the allow-listed mentions -- every pattern except a *real*
 * Discord webhook URL may legitimately appear in the self-referential/docs files
 * in `allowedContentMentions`; a real webhook is never allowed anywhere.
 */
export function contentMatches(file, text) {
  const matched = [];
  for (const pattern of contentPatterns) {
    if (!pattern.regex.test(text)) {
      continue;
    }
    if (
      pattern.name !== "real Discord webhook URL" &&
      allowedContentMentions.has(file)
    ) {
      continue;
    }
    matched.push(pattern.name);
  }
  return matched;
}

async function main() {
  const trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  const findings = [];

  for (const file of trackedFiles) {
    for (const name of pathMatches(file)) {
      findings.push(`${file}: ${name}`);
    }

    if (isBinaryOrGenerated(file)) {
      continue;
    }

    const absolutePath = path.join(repoRoot, file);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      console.warn(`Skipping unreadable path ${file}: ${error.message}`);
      continue;
    }

    if (stat.isSymbolicLink()) {
      let linkTarget;
      try {
        linkTarget = await fs.readlink(absolutePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        console.warn(`Skipping unreadable symlink ${file}: ${error.message}`);
        continue;
      }

      for (const name of contentMatches(file, linkTarget)) {
        findings.push(`${file}: symlink target: ${name}`);
      }
      continue;
    }

    if (!stat.isFile()) {
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
        for (const name of contentMatches(file, line)) {
          findings.push(`${file}:${lineNumber}: ${name}`);
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        lines?.close();
        continue;
      }
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
