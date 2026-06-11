import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const targetRoots = [
  "README.md",
  "docs",
  "registry",
  "schemas",
  "public",
  "dist/metagraph-r2",
  ".github",
  "workers",
  "wrangler.jsonc",
];

const patterns = [
  { name: "local absolute path", regex: /\/Users\/|\/home\/|C:\\Users\\/ },
  { name: "private key marker", regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: "github token", regex: /ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/ },
  { name: "openai-style token", regex: /sk-[A-Za-z0-9]{20,}/ },
  { name: "slack-style token", regex: /xox[baprs]-[A-Za-z0-9-]+/ },
  {
    name: "signed object-storage URL parameter",
    regex:
      /[?&](?:X-Amz-(?:Credential|Signature|Security-Token)|X-Goog-(?:Credential|Signature|Security-Token|SignedHeaders|Expires)|X-Oss-(?:Credential|Signature))=/i,
  },
  {
    name: "private or loopback URL",
    regex:
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)/i,
  },
  {
    name: "token-like assignment",
    regex:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  },
  // `soft` patterns are terminology heuristics (not actual secrets). They are
  // skipped for mirrored third-party OpenAPI specs, where wording like "seed
  // phrase" or "validator hotkey" is public API documentation the subnet
  // published — not data we are leaking. The hard secret patterns above still
  // apply to those files.
  {
    name: "wallet/key wording",
    regex: /\b(coldkey|wallet path|private key|seed phrase|mnemonic)\b/i,
    soft: true,
  },
  {
    name: "sensitive hotkey wording",
    regex:
      /\b(?:private|secret|wallet|validator|miner)\s+hotkey\b|\bhotkey\s+(?:path|private key|seed|seed phrase|mnemonic)\b/i,
    soft: true,
  },
];

// Per-surface schema artifacts embed the full upstream OpenAPI/Swagger spec
// (TS2). Those are public docs the subnet published; the soft wording
// heuristics false-positive on their API terminology.
function isMirroredExternalSpec(relativePath) {
  return (
    /(^|\/)schemas\/.+\.json$/.test(relativePath) &&
    !relativePath.endsWith("schemas/index.json")
  );
}

const findings = [];

async function* walk(target) {
  const fullPath = path.join(repoRoot, target);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return;
  }

  if (stat.isFile()) {
    yield fullPath;
    return;
  }

  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }
    const nested = path.join(target, entry.name);
    if (entry.isDirectory()) {
      yield* walk(nested);
    } else if (entry.isFile()) {
      yield path.join(repoRoot, nested);
    }
  }
}

for (const root of targetRoots) {
  for await (const filePath of walk(root)) {
    const relative = path.relative(repoRoot, filePath);
    if (isBinaryOrIgnored(relative)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const skipSoft = isMirroredExternalSpec(relative);

    for (const [index, line] of lines.entries()) {
      for (const pattern of patterns) {
        if (pattern.soft && skipSoft) {
          continue;
        }
        if (pattern.regex.test(line)) {
          findings.push(`${relative}:${index + 1}: ${pattern.name}`);
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Public-safety scan found ${findings.length} issue(s):`);
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Public-safety scan passed.");

function isBinaryOrIgnored(relativePath) {
  return (
    relativePath.endsWith(".DS_Store") ||
    relativePath.endsWith(".png") ||
    relativePath.endsWith(".jpg") ||
    relativePath.endsWith(".jpeg") ||
    relativePath.endsWith(".gif") ||
    relativePath.endsWith(".webp") ||
    relativePath.endsWith(".ico")
  );
}
