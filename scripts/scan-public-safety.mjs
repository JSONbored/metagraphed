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
    regex: /\b(wallet path|private key|seed phrase|mnemonic)\b/i,
    soft: true,
    scanFixtureBody: true,
  },
  {
    name: "Bittensor key terminology",
    regex: /\bcoldkey\b/i,
    soft: true,
  },
  {
    name: "sensitive hotkey wording",
    regex:
      /\b(?:private|secret|wallet|validator|miner)\s+hotkey\b|\bhotkey\s+(?:path|private key|seed|seed phrase|mnemonic)\b/i,
    soft: true,
  },
];

// Per-surface schema artifacts, and some captured fixtures, embed upstream
// OpenAPI/Swagger specs or GitHub READMEs. Those are public docs the subnet
// published; the soft wording heuristics false-positive on their API terminology
// ("hotkey"/"wallet"/"coldkey" are core Bittensor vocabulary that nearly every
// subnet API documents). Keep this exemption scoped to the generated public/R2
// artifact directories so source schemas are still covered by the terminology
// guard. The hard secret patterns above still apply to these files. Captured
// fixture response bodies additionally get a structural HARD-secret scan below
// (parsed JSON string values, so a real key/token can't hide under a generic
// JSON key). Fixture body soft scans stay limited to security-sensitive
// wallet/key phrases because broad Bittensor terminology is legitimate upstream
// API vocabulary ("The miner hotkey to look up") and wedges publish.
function isMirroredExternalSpec(relativePath) {
  return [
    /^public\/metagraph\/schemas\/(?!index\.json$)[^/]+\.json$/,
    /^dist\/metagraph-r2\/metagraph\/schemas\/(?!index\.json$)[^/]+\.json$/,
    ...mirroredFixturePatterns,
  ].some((pattern) => pattern.test(relativePath));
}

const mirroredFixturePatterns = [
  /^public\/metagraph\/fixtures\/[^/]+\.json$/,
  /^dist\/metagraph-r2\/metagraph\/fixtures\/[^/]+\.json$/,
];

function isMirroredExternalFixture(relativePath) {
  return mirroredFixturePatterns.some((pattern) => pattern.test(relativePath));
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

    if (isMirroredExternalFixture(relative)) {
      scanCapturedFixtureBody(relative, content);
    }

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

function scanCapturedFixtureBody(relativePath, content) {
  let fixture;
  try {
    fixture = JSON.parse(content);
  } catch {
    return;
  }

  const body = fixture?.response?.body;
  if (body === undefined) {
    return;
  }

  for (const { valuePath, value } of walkJsonStrings(body)) {
    for (const pattern of patterns) {
      // Keep broad Bittensor terminology exempt for mirrored fixture bodies, but
      // still scan security-sensitive wallet/key phrases that can appear under
      // generic live-response keys after sanitization.
      if (pattern.soft && !pattern.scanFixtureBody) {
        continue;
      }
      // OpenAPI documentation fields (description/summary/title) are human API
      // docs the subnet published — a captured spec's parameter description can
      // legitimately read "Your wallet path…". Keep this SOFT wording exemption
      // scoped to OpenAPI-shaped paths so generic response fields named
      // description/summary/title are still scanned for wallet/key disclosures.
      // Hard secret patterns (keys/tokens) still scan these fields below.
      if (pattern.soft && isOpenApiDocumentationField(valuePath, body)) {
        continue;
      }
      if (pattern.regex.test(value)) {
        findings.push(
          `${relativePath}:response.body${valuePath}: ${pattern.name}`,
        );
      }
    }
  }
}

function isOpenApiDocumentationField(valuePath, body) {
  const isDocumentationField =
    valuePath.endsWith(".description") ||
    valuePath.endsWith(".summary") ||
    valuePath.endsWith(".title");
  if (!isDocumentationField || !isOpenApiBody(body)) {
    return false;
  }

  return (
    valuePath.startsWith(".openapi.") ||
    valuePath.startsWith(".swagger.") ||
    valuePath.startsWith(".info.") ||
    valuePath.startsWith(".components.") ||
    valuePath.startsWith(".definitions.") ||
    valuePath.startsWith(".tags[") ||
    valuePath.startsWith(".externalDocs.") ||
    valuePath.startsWith(".paths.")
  );
}

function isOpenApiBody(body) {
  return (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (typeof body.openapi === "string" ||
      typeof body.swagger === "string" ||
      (body.paths &&
        typeof body.paths === "object" &&
        !Array.isArray(body.paths)))
  );
}

function* walkJsonStrings(node, valuePath = "") {
  if (typeof node === "string") {
    yield { valuePath, value: node };
    return;
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      yield* walkJsonStrings(item, `${valuePath}[${index}]`);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      yield* walkJsonStrings(value, `${valuePath}.${key}`);
    }
  }
}

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
