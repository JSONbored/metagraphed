import { execFileSync } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { repoRoot } from "./lib.mjs";
import {
  contentPatterns,
  isBinaryOrGenerated,
  isExemptFinding,
  pathPatterns,
} from "./lib/private-boundary-patterns.mjs";

const trackedFiles = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

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

    for (const pattern of contentPatterns) {
      if (!pattern.regex.test(linkTarget)) {
        continue;
      }
      if (isExemptFinding(file, pattern.name)) {
        continue;
      }
      findings.push(`${file}: symlink target: ${pattern.name}`);
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
      for (const pattern of contentPatterns) {
        if (!pattern.regex.test(line)) {
          continue;
        }
        if (isExemptFinding(file, pattern.name)) {
          continue;
        }
        findings.push(`${file}:${lineNumber}: ${pattern.name}`);
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
