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
  // Covers every GitHub token prefix, not just the personal-access ghp_: gho_
  // (OAuth), ghu_ (user-to-server), ghs_ (server-to-server / App installation),
  // and ghr_ (refresh) are all real, leakable credentials in the same family.
  {
    name: "github token",
    regex: /(?:gh[opsur]|github_pat)_[A-Za-z0-9_]+/,
  },
  // GitLab personal access token: the routable `glpat-` prefix + 20+ URL-safe
  // base64 chars. The GitLab analog of the github-token rule above and an equally
  // leakable credential; its distinctive fixed prefix is matched by none of the
  // other token rules (the `sk-`/`xox`/`gh` prefixes never start `glpat-`).
  {
    name: "gitlab personal access token",
    regex: /glpat-[A-Za-z0-9_-]{20,}/,
  },
  // npm access token: the fixed `npm_` prefix + 36 base62 chars is the documented
  // format for automation / granular / publish tokens. A leaked npm token grants
  // publish rights to a package (a supply-chain risk) and its distinctive prefix is
  // matched by none of the other token rules above (`gh`/`glpat-`/`sk-`/`xox`).
  {
    name: "npm access token",
    regex: /npm_[A-Za-z0-9]{36}/,
  },
  { name: "openai-style token", regex: /sk-[A-Za-z0-9]{20,}/ },
  { name: "slack-style token", regex: /xox[baprs]-[A-Za-z0-9-]+/ },
  // AWS access key id: AKIA (long-term) / ASIA (temporary STS) + 16 upper-alnum.
  // The signed-URL rule below catches request params, but a bare access key id
  // pasted into a doc/config is the more common leak and went undetected.
  { name: "aws access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: "signed object-storage URL parameter",
    regex:
      /[?&](?:X-Amz-(?:Credential|Signature|Security-Token)|X-Goog-(?:Credential|Signature|Security-Token|SignedHeaders|Expires)|X-Oss-(?:Credential|Signature))=/i,
  },
  // Google API key: the fixed "AIza" prefix + 35 URL-safe chars. A distinctive,
  // unambiguous format that a leaked Maps/Cloud key takes; none of the URL/token
  // rules above catch a bare key value.
  { name: "google api key", regex: /AIza[0-9A-Za-z_-]{35}/ },
  {
    name: "private or loopback URL",
    // Includes link-local 169.254.0.0/16 — the cloud-metadata endpoint
    // (169.254.169.254) is the canonical SSRF/credential-theft target and is
    // classified unsafe by lib.mjs isUnsafeUrl, so a leaked URL to it must be
    // flagged alongside the RFC1918 ranges.
    regex:
      /(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)/i,
    // The standard local subtensor RPC endpoint is documented setup guidance for
    // the `local` network surface (llms.txt / setup docs), not a leaked internal
    // URL. Scoped to the exact well-known endpoint; any other loopback URL on the
    // same line is still flagged (allowlisted spans are stripped before testing).
    allow: /wss?:\/\/127\.0\.0\.1:9944(?![A-Za-z0-9._~:/?#\]@!$&'()*+,;=%-])/gi,
  },
  {
    name: "token-like assignment",
    // Optional multi-segment prefix (client_, db_, google_oauth_client_) before the
    // keyword group: a leading \b has no boundary after an underscore inside
    // client_secret, so bare secret/password miss the most common credential names.
    regex:
      /\b(?:[a-z0-9]+(?:[_-][a-z0-9]+)*_)?(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  },
  // `soft` patterns are terminology heuristics (not actual secrets). They are
  // skipped for mirrored third-party OpenAPI specs, where wording like "seed
  // phrase" or "validator hotkey" is public API documentation the subnet
  // published — not data we are leaking. The hard secret patterns above still
  // apply to those files.
  //
  // Tolerates hyphen/underscore/no-separator compound forms (seed-phrase,
  // seedphrase, private_key, privateKey — the last via the case-insensitive
  // flag), not just the two-word phrase with a literal space: matches
  // scripts/lib.mjs's FIXTURE_SENSITIVE_KEY's own separator-tolerant design
  // for the identical reason (a different, unrelated matcher there —
  // redacting suspicious JSON *keys* before a fixture is committed, vs. this
  // rule scanning free text for suspicious *prose* — but the same class of
  // gap: requiring a literal space between the two words let a hyphenated or
  // camelCase spelling slip past undetected). Confirmed 2026-07-13 this was a
  // real, exploitable gap: "coldkey-only-seedphrase" only ever tripped the
  // scan because the separate Bittensor-key-terminology rule below happened
  // to also fire on "coldkey" in the same line — the SAME wording without a
  // "coldkey" on the line (e.g. a bare "walletpath" or "privatekey" mention)
  // would have passed silently. `\b` after the optional separator still
  // requires a real word boundary, so "privateKeyRef"/"seedphrases" (a
  // continuation into more identifier/word characters) are correctly NOT
  // matched — only the exact two-word concept, however it's spelled.
  {
    name: "wallet/key wording",
    regex:
      /\b(wallet[\s_-]?path|private[\s_-]?key|seed[\s_-]?phrase|mnemonic)\b/i,
    soft: true,
    scanFixtureBody: true,
  },
  {
    name: "Bittensor key terminology",
    regex: /\bcoldkey\b/i,
    // Bare "coldkey" as a public API field name (JSON property / required entry /
    // TS type member) is legitimate metagraph vocabulary (#1304) — an ss58 coldkey
    // is public on-chain data, not a secret. Also allow the "hotkey or coldkey" /
    // "hotkey/coldkey" field-pair phrase (account routes #1347 doc text + the
    // generated MCP server-card prose), generated CSV headers for public exports,
    // the "coldkey-only" behaviour descriptor (a coldkey-only ss58 address has no
    // hotkey-attributed rollup), and "coldkey" as a bare SQL/code identifier —
    // one comprehensive alternation covering the common ways a column/field
    // reference is followed in this codebase's actual query/type code (an
    // operator, a NULL check, an IN-list, SQL keywords like ORDER
    // BY/GROUP BY/AS, or a closing delimiter), rather than allowlisting each
    // operator one at a time as new call sites are written — the previous
    // narrower version (`coldkey\s*=` only) needed a follow-up patch the very
    // first time a query used `IS NOT NULL` instead (2026-07-13). Strip those
    // legitimate spans so only suspicious prose ("your coldkey seed phrase" —
    // still caught here and by the wallet/key-wording rule above) trips. The
    // "coldkey-only" exemption is the exact hyphenated phrase, NOT a blanket
    // `coldkey-` strip, so a hyphen can't be used to smuggle a secret
    // ("coldkey-seedphrase: …" still trips, and now so does bare
    // "seedphrase" via the strengthened rule above). Same rationale as the
    // isMirroredExternalSpec exemption, scoped to the safe forms so the guard
    // stays active everywhere else.
    allow:
      /"coldkey"\s*:?|\bcoldkey\s*\??\s*:|\bhotkey(?:\s+or\s+|\s*\/\s*)coldkey\b|\bcoldkey-only(?![-A-Za-z0-9_])|\bcoldkey\s*(?:=|!=|<>|IS\s+(?:NOT\s+)?NULL\b|IN\s*\()|\bcoldkey\s*(?:,|\)|\]|\}|;|`)|\bcoldkey\s+(?:ASC|DESC|AS\b)/gi,
    soft: true,
  },
  {
    name: "sensitive hotkey wording",
    // Space/hyphen-tolerant (not underscore) for the modifier+hotkey
    // alternative specifically: unlike wallet-path/private-key/seed-phrase
    // above, `<role>_hotkey` (miner_hotkey, validator_hotkey) is extremely
    // common, benign snake_case Bittensor API field naming (confirmed live
    // 2026-07-13 -- registry/subnets/ridges.json's own "miner_hotkey" field
    // name, and several generated dist/ artifacts, all tripped a first,
    // too-broad `[\s_-]+` version of this fix), not suspicious prose the way
    // a hyphen/space-joined phrase can be. The hotkey+noun alternative still
    // tolerates underscore since "hotkey_seed_phrase"-style compounds are not
    // an established safe field-naming convention here the way `<role>_hotkey`
    // is.
    regex:
      /\b(?:private|secret|wallet|validator|miner)[\s-]+hotkey\b|\bhotkey[\s_-]+(?:path|private[\s_-]?key|seed[\s_-]?phrase|seed|mnemonic)\b/i,
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
    // Adapter snapshots are machine-generated, live-fetched from each subnet's own
    // upstream API/repo each publish — the same "published docs" case as schemas:
    // legitimate wallet/key API vocabulary (e.g. Hippius SN75 documents "private
    // key"/"seed phrase") false-positives the SOFT terminology heuristic and
    // wedges the publish. Exempt the source snapshot + its R2 mirror from the soft
    // patterns only; the HARD secret-value patterns above still apply to them.
    /^registry\/adapters\/latest\/[^/]+\.json$/,
    /^dist\/metagraph-r2\/metagraph\/adapters\/[^/]+\.json$/,
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
        // Strip allowlisted spans (e.g. the documented local subtensor RPC
        // endpoint) before testing, so a real leak elsewhere on the same line
        // is still caught.
        const probe = pattern.allow ? line.replace(pattern.allow, "") : line;
        if (pattern.regex.test(probe)) {
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

  for (const { valuePath, value, kind } of walkJsonStrings(body)) {
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
        const location =
          kind === "key"
            ? `${relativePath}:response.body${valuePath} key`
            : `${relativePath}:response.body${valuePath}`;
        findings.push(`${location}: ${pattern.name}`);
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
      const nestedPath = `${valuePath}.${key}`;
      yield { valuePath: nestedPath, value: key, kind: "key" };
      yield* walkJsonStrings(value, nestedPath);
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
