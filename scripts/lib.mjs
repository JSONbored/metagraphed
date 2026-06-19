import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import {
  ARTIFACT_STORAGE_TIERS,
  R2_STAGING_RELATIVE_ROOT,
  artifactRelativePath,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";

export const repoRoot = new URL("..", import.meta.url).pathname;
export const publicMetagraphRoot = path.join(repoRoot, "public/metagraph");
export const r2StagingRoot = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
export const generatedSourceRoot = path.join(repoRoot, "dist/metagraph-source");

const credentialedUrlParams = new Set([
  "access_key",
  "access-token",
  "access_token",
  "app_domain",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "authuser",
  "bearer",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "continue",
  "cookie",
  "credential",
  "dsh",
  "flowname",
  "jwt",
  "key",
  "nonce",
  "opparams",
  "part",
  "password",
  "prompt",
  "rart",
  "redirect_uri",
  "refresh-token",
  "refresh_token",
  "response_type",
  "scope",
  "secret",
  "service",
  "session",
  "sig",
  "signature",
  "state",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
  "x-goog-credential",
  "x-goog-signature",
  "x-goog-security-token",
  "x-goog-signedheaders",
  "x-goog-expires",
  "x-oss-signature",
  "x-oss-credential",
]);

const unsafeIpBlocks = new BlockList();
unsafeIpBlocks.addSubnet("0.0.0.0", 8);
unsafeIpBlocks.addSubnet("10.0.0.0", 8);
unsafeIpBlocks.addSubnet("100.64.0.0", 10);
unsafeIpBlocks.addSubnet("127.0.0.0", 8);
unsafeIpBlocks.addSubnet("169.254.0.0", 16);
unsafeIpBlocks.addSubnet("172.16.0.0", 12);
unsafeIpBlocks.addSubnet("192.0.0.0", 24);
unsafeIpBlocks.addSubnet("192.168.0.0", 16);
unsafeIpBlocks.addSubnet("198.18.0.0", 15);
unsafeIpBlocks.addSubnet("224.0.0.0", 4);
unsafeIpBlocks.addSubnet("255.255.255.255", 32);
unsafeIpBlocks.addSubnet("::", 128, "ipv6");
unsafeIpBlocks.addSubnet("::1", 128, "ipv6");
unsafeIpBlocks.addSubnet("64:ff9b:1::", 48, "ipv6");
unsafeIpBlocks.addSubnet("100::", 64, "ipv6");
unsafeIpBlocks.addSubnet("fc00::", 7, "ipv6");
unsafeIpBlocks.addSubnet("fe80::", 10, "ipv6");
unsafeIpBlocks.addSubnet("ff00::", 8, "ipv6");

export function buildEvidenceSubjectNetuidIndex({
  candidates = [],
  subnets = [],
  surfaces = [],
} = {}) {
  const index = new Map();
  const setSubjectNetuid = (subject, netuid) => {
    if (subject && Number.isInteger(netuid)) {
      index.set(subject, netuid);
    }
  };

  for (const subnet of subnets || []) {
    setSubjectNetuid(`subnet:${subnet.netuid}`, subnet.netuid);
  }
  for (const surface of surfaces || []) {
    setSubjectNetuid(`surface:${surface.id}`, surface.netuid);
  }
  for (const candidate of candidates || []) {
    setSubjectNetuid(`candidate:${candidate.id}`, candidate.netuid);
  }

  return index;
}

export function netuidForEvidenceClaim(claim, subjectNetuids = new Map()) {
  const subject = String(claim?.subject || "");
  if (subjectNetuids.has(subject)) {
    return subjectNetuids.get(subject);
  }
  return netuidFromEvidenceSubject(subject);
}

// Fallback for legacy/imported claims that are not generated from authoritative
// subnet, surface, or candidate rows in this build. Generated claims should be
// scoped through buildEvidenceSubjectNetuidIndex() instead of trusting
// user-controlled subject slugs.
export function netuidFromEvidenceSubject(subject) {
  const value = String(subject || "");
  const subnetMatch = value.match(/^subnet:(\d+)\b/);
  if (subnetMatch) {
    return Number(subnetMatch[1]);
  }
  const snMatch = value.match(/sn-(\d+)/);
  if (snMatch) {
    return Number(snMatch[1]);
  }
  return null;
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function readArtifactJson(relativePath) {
  return readJson(artifactFilePath(relativePath));
}

// Write a file atomically: stage inside a private sibling temp directory (same
// filesystem, so rename() is atomic) then rename over the target. A concurrent
// reader always sees a complete old-or-new file, never the zero-length window a
// plain truncate-write exposes. The randomly-created temp directory also avoids
// following attacker-precreated symlinks at predictable staging paths. This
// makes the build safe to run while tests / the Worker read the committed
// artifacts in parallel (fixes the vitest file-scheduling race where a reader
// saw a half-written subnets.json and 404'd).
async function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempDir = await fs.mkdtemp(
    path.join(dir, `${path.basename(filePath)}.${process.pid}.`),
  );
  const tempPath = path.join(tempDir, "write.tmp");
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
  }
}

export async function writeJson(filePath, value) {
  await atomicWriteFile(filePath, `${stableStringify(value)}\n`);
}

// String-aware JSONC comment stripper. Unlike a naive regex, it never treats
// `//`, `/*`, or `*/` INSIDE a string literal as a comment delimiter — essential
// because wrangler.jsonc holds route globs like `"/api/*"` (ends in `/*`) and the
// cron `"*/2 * * * *"` (contains `*/`); a regex stripper would splice from the
// former's `/*` to the latter's `*/` and delete the config in between. Also drops
// trailing commas so JSON.parse accepts the result.
export function stripJsonComments(value) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

export async function formatRepositoryJson(value) {
  const prettier = await import("prettier");
  return prettier.format(`${stableStringify(value)}\n`, { parser: "json" });
}

export async function writeRepositoryJson(filePath, value) {
  await atomicWriteFile(filePath, await formatRepositoryJson(value));
}

export function artifactFilePath(relativePath, options = {}) {
  const normalized = artifactRelativePath(relativePath);
  const tier = artifactStorageTierForRelativePath(normalized);
  if (tier !== ARTIFACT_STORAGE_TIERS.r2) {
    return path.join(publicMetagraphRoot, normalized);
  }

  const stagedPath = path.join(r2StagingRoot, normalized);
  const publicPath = path.join(publicMetagraphRoot, normalized);
  const allowPublicFallback = options.allowPublicFallback !== false;
  if (existsSync(stagedPath) || !allowPublicFallback) {
    return stagedPath;
  }
  return publicPath;
}

export function artifactOutputPath(relativePath) {
  const normalized = artifactRelativePath(relativePath);
  const tier = artifactStorageTierForRelativePath(normalized);
  return path.join(
    tier === ARTIFACT_STORAGE_TIERS.r2 ? r2StagingRoot : publicMetagraphRoot,
    normalized,
  );
}

export function artifactDirectoryPath(relativePath) {
  const normalized = artifactRelativePath(relativePath).replace(/\/+$/, "");
  const stagedPath = path.join(r2StagingRoot, normalized);
  if (existsSync(stagedPath)) {
    return stagedPath;
  }
  return path.join(publicMetagraphRoot, normalized);
}

export async function latestArtifactDate(relativePath) {
  const dirPath = artifactDirectoryPath(relativePath);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return (
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .map((file) => file.replace(/\.json$/, ""))
      .sort()
      .at(-1) || null
  );
}

export function createLocalArtifactEnv(overrides = {}) {
  return {
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        const filePath = path.join(
          repoRoot,
          "public",
          url.pathname.replace(/^\/+/, ""),
        );
        try {
          const body = await fs.readFile(filePath);
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": filePath.endsWith(".json")
                ? "application/json"
                : "application/octet-stream",
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    },
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_ARCHIVE: {
      async get(key) {
        const relativePath = String(key).replace(/^latest\//, "");
        const filePath = artifactFilePath(relativePath);
        try {
          const body = await fs.readFile(filePath, "utf8");
          return {
            async json() {
              return JSON.parse(body);
            },
            async text() {
              return body;
            },
          };
        } catch {
          return null;
        }
      },
    },
    ...overrides,
  };
}

export async function listJsonFiles(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function listJsonFilesRecursive(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFilesRecursive(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export async function loadProviders() {
  const files = await listJsonFiles(path.join(repoRoot, "registry/providers"));
  return Promise.all(files.map(readJson));
}

export async function loadSubnets() {
  const { generateBaselineOverlaySet, loadManualSubnetOverlays } =
    await import("./generated-overlays.mjs");
  const manualOverlays = await loadManualSubnetOverlays();
  const overlaySet = await generateBaselineOverlaySet({
    manualOverlays,
  });
  const subnets = [
    ...overlaySet.manualOverlays,
    ...overlaySet.generatedOverlays,
  ];
  return subnets.sort(
    (a, b) => a.netuid - b.netuid || a.slug.localeCompare(b.slug),
  );
}

export async function loadNativeSnapshot() {
  return readJson(path.join(repoRoot, "registry/native/finney-subnets.json"));
}

export async function loadCandidates() {
  const files = await listJsonFilesRecursive(
    path.join(repoRoot, "registry/candidates"),
  );
  const documents = await Promise.all(files.map(readJson));
  const candidates = documents.flatMap((document) => {
    if (Array.isArray(document.candidates)) {
      return document.candidates;
    }
    return [document];
  });
  return candidates.sort(
    (a, b) => a.netuid - b.netuid || a.id.localeCompare(b.id),
  );
}

export async function loadVerification(options = {}) {
  const preferDetailed = options.preferDetailed !== false;
  const candidates = preferDetailed
    ? [
        path.join(generatedSourceRoot, "verification/latest.json"),
        path.join(repoRoot, "registry/verification/latest.json"),
        path.join(repoRoot, "registry/verification/promotions.json"),
      ]
    : [
        path.join(repoRoot, "registry/verification/promotions.json"),
        path.join(repoRoot, "registry/verification/latest.json"),
        path.join(generatedSourceRoot, "verification/latest.json"),
      ];

  for (const filePath of candidates) {
    try {
      return await readJson(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    schema_version: 1,
    generated_at: null,
    results: [],
  };
}

export async function loadDetailedVerification() {
  try {
    return await readJson(
      path.join(generatedSourceRoot, "verification/latest.json"),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return loadVerification();
    }
    throw error;
  }
}

export function flattenSurfaces(subnets) {
  return subnets
    .flatMap((subnet) =>
      subnet.surfaces.map((surface) => {
        const flattened = {
          ...surface,
          netuid: subnet.netuid,
          subnet_slug: subnet.slug,
          subnet_name: subnet.name,
        };
        // #1005: a stable identity decoupled from the hand-authored display id.
        flattened.key = surfaceStableKey(flattened);
        // #1006: the as-of timestamp every served surface should carry. A
        // per-surface verification wins; otherwise the subnet's curation
        // verified_at (when a maintainer last vetted the overlay). null when
        // neither exists — the agent then sees the surface is unverified.
        flattened.last_verified_at =
          surface.verification?.verified_at ??
          subnet.curation?.verified_at ??
          null;
        return flattened;
      }),
    )
    .sort((a, b) => a.netuid - b.netuid || a.id.localeCompare(b.id));
}

// #1006: per-kind verification-freshness TTL (days). `last_verified_at` is the
// curator's as-of; a surface is `stale` once it hasn't been re-verified within
// its kind's window. Callable/operational surfaces drift fast (short window);
// static identity surfaces are stable (long window). Any kind not listed uses
// SURFACE_FRESHNESS_DEFAULT_TTL_DAYS. Fixed (not env-gated) so the build and the
// validate reproduction compute byte-identical `stale` values.
export const SURFACE_FRESHNESS_DEFAULT_TTL_DAYS = 90;
export const SURFACE_FRESHNESS_TTL_DAYS = {
  "subnet-api": 30,
  openapi: 30,
  sse: 30,
  "data-artifact": 30,
  "subtensor-rpc": 30,
  "subtensor-wss": 30,
  dashboard: 60,
  website: 90,
  docs: 90,
  archive: 120,
  example: 120,
  sdk: 120,
  "source-repo": 120,
  "repo-registry": 120,
};

export function surfaceFreshnessTtlDays(kind) {
  return SURFACE_FRESHNESS_TTL_DAYS[kind] ?? SURFACE_FRESHNESS_DEFAULT_TTL_DAYS;
}

// True when a surface's verification is older than its kind's TTL, measured
// against `nowMs` (the dataset's native-snapshot captured_at, a committed +
// deterministic reference — never wall-clock — so the flag is reproducible). A
// surface with no last_verified_at is NOT stale: that's "unverified", a distinct
// state the null timestamp already signals.
export function isSurfaceStale(lastVerifiedAt, kind, nowMs) {
  if (!lastVerifiedAt) return false;
  const verifiedMs = Date.parse(lastVerifiedAt);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - verifiedMs > surfaceFreshnessTtlDays(kind) * 86_400_000;
}

// Stamp the serve-time `stale` flag onto a flattened-surface list (the companion
// to flattenSurfaces' static `last_verified_at`). Kept separate because `stale`
// needs the `nowMs` reference flattenSurfaces does not carry; build + validate
// both call this with the same captured_at so per-subnet artifacts reproduce.
export function withSurfaceFreshness(surfaces, nowMs) {
  return surfaces.map((surface) => ({
    ...surface,
    stale: isSurfaceStale(surface.last_verified_at, surface.kind, nowMs),
  }));
}

// Stable surface identity (#1005): a short hash of the netuid|kind|url key, so a
// surface keeps the same `key` across display-name/slug renames (the `id` is
// author-controlled and changes on rename, which orphans D1 history + breaks the
// derived endpoint link). PR1 surfaces this `key`; later PRs re-key D1 history +
// endpoint links onto it. A URL change is intentionally a new identity.
export function surfaceStableKey(entry) {
  return `srf-${sha256Hex(registrySurfaceKey(entry)).slice(0, 16)}`;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

export function nativeNameQuality(subnet) {
  const rawName =
    typeof subnet?.raw_name === "string" ? subnet.raw_name : subnet?.name;
  return classifyNativeName(rawName, subnet?.netuid).quality;
}

export function formatLlmMarkdownText(value, { maxLength = 160 } = {}) {
  const markdownCharacters = new Set("\\&<>{}[]()#*_`|!");
  const chars = Array.from(String(value ?? "")).slice(0, maxLength);
  let safeValue = "";

  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (char === "\r") {
      safeValue += "\\r";
    } else if (char === "\n") {
      safeValue += "\\n";
    } else if (char === "\t") {
      safeValue += " ";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      safeValue += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else if (markdownCharacters.has(char)) {
      safeValue += `\\${char}`;
    } else {
      safeValue += char;
    }
  }

  return safeValue;
}

export function nativeDisplayName(subnet, fallbackName = null) {
  const quality = nativeNameQuality(subnet);
  const candidate =
    quality === "chain"
      ? typeof subnet?.raw_name === "string"
        ? subnet.raw_name
        : subnet?.name
      : fallbackName;
  // Defang prompt-injection in the chain/overlay display name before it becomes
  // subnet.name. That value flows verbatim into the search index title/tokens,
  // the embeddings, the /ask RAG context, and llms.txt — the same sinks the
  // description/additional fields are scrubbed for (lib.mjs threat model). The
  // injection rules are no-ops for legitimate names, so a real name is unchanged.
  const cleaned =
    typeof candidate === "string"
      ? sanitizeChainText(candidate).text
      : candidate;
  return cleaned || `Subnet ${subnet?.netuid ?? "unknown"}`;
}

export function classifyNativeName(value, netuid) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return { raw_name: null, quality: "empty" };
  }

  const normalized = raw.toLowerCase();
  const genericName =
    Number.isInteger(netuid) && normalized === `subnet ${netuid}`.toLowerCase();
  if (
    genericName ||
    ["unknown", "none", "null", "n/a", "na", "unnamed"].includes(normalized) ||
    !/[\p{L}\p{N}]/u.test(raw)
  ) {
    return { raw_name: raw, quality: "placeholder" };
  }

  return { raw_name: raw, quality: "chain" };
}

export function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }

  return value;
}

const schemaGeneratedTimestampKeys = new Set(["x-generated-at", "x-timestamp"]);
const schemaDroppedContentKeys = new Set([
  "description",
  "summary",
  "externaldocs",
  "example",
  "examples",
]);
const schemaAbsoluteUrlPattern = /\b(?:https?|wss?):\/\/[^\s<>"'`)}\]]+/gi;

function isSchemaExtensionKey(key) {
  return String(key || "")
    .toLowerCase()
    .startsWith("x-");
}

function isAbsoluteHttpLikeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeSchemaUrlString(value) {
  if (isUnsafeUrl(value)) {
    return null;
  }
  return redactCredentialedUrl(value);
}

function sanitizeSchemaText(value) {
  return value.replace(schemaAbsoluteUrlPattern, (match) => {
    const sanitized = sanitizeSchemaUrlString(match);
    return sanitized || "[redacted-unsafe-url]";
  });
}

function sanitizeSchemaKey(key) {
  if (!isAbsoluteHttpLikeUrl(key)) {
    return key;
  }
  return sanitizeSchemaUrlString(key);
}

function sanitizeSchemaServer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return sanitizeOpenApiDocument(value);
  }

  if (typeof value.url === "string" && isAbsoluteHttpLikeUrl(value.url)) {
    const url = sanitizeSchemaUrlString(value.url);
    if (!url) {
      return undefined;
    }
  }

  return sanitizeOpenApiDocument(value);
}

export function sanitizeOpenApiDocument(value) {
  if (Array.isArray(value)) {
    return value
      .map((nested) => sanitizeOpenApiDocument(nested))
      .filter((nested) => nested !== undefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .flatMap(([key, nested]) => {
          const lowerKey = key.toLowerCase();
          if (
            schemaGeneratedTimestampKeys.has(lowerKey) ||
            schemaDroppedContentKeys.has(lowerKey) ||
            isSchemaExtensionKey(key)
          ) {
            return [];
          }

          const sanitizedKey = sanitizeSchemaKey(key);
          if (!sanitizedKey) {
            return [];
          }

          const sanitizedNested =
            lowerKey === "servers" && Array.isArray(nested)
              ? nested
                  .map((server) => sanitizeSchemaServer(server))
                  .filter((server) => server !== undefined)
              : sanitizeOpenApiDocument(nested);
          if (sanitizedNested === undefined) {
            return [];
          }

          return [[sanitizedKey, sanitizedNested]];
        })
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  if (typeof value === "string") {
    return sanitizeSchemaText(redactCredentialedUrl(value));
  }

  return value;
}

export function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:", "wss:", "ws:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isUnsafeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    return isUnsafeHostname(host);
  } catch {
    return true;
  }
}

export async function isUnsafeResolvedUrl(value, resolver = lookup) {
  try {
    const url = new URL(value);
    if (isUnsafeUrl(url.toString())) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    if (isIP(host)) {
      return false;
    }

    const records = await resolver(host, { all: true, verbatim: true });
    return (
      records.length === 0 ||
      records.some((record) => isUnsafeIpAddress(record.address))
    );
  } catch {
    return true;
  }
}

function isUnsafeHostname(host) {
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  return isUnsafeIpAddress(host);
}

// metagraphed's own public domain. Candidate base_urls that impersonate it must
// never enter the discovery bundle.
const SELF_DOMAIN = "metagraph.sh";

// Reject candidate URLs that trade on metagraphed's own identity. The SSRF guard
// (isUnsafeUrl/isUnsafeResolvedUrl) passes for an attacker-registered PUBLIC
// domain, so a base_url that reads as "metagraph.sh" — metagraph.sh.evil.com,
// metagraphsh.com, metagraph-sh.io — would clear it yet could get an agent to
// trust and call it. The real metagraph.sh and its subdomains are exempt; this
// targets squats of our exact domain, not the generic "metagraph" Bittensor term
// (a subnet legitimately named "…metagraph…" is unaffected).
export function isBrandImpersonationUrl(value) {
  let host;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (host === SELF_DOMAIN || host.endsWith(`.${SELF_DOMAIN}`)) {
    return false;
  }
  return /metagraph\.sh(?:\.|$)|metagraph-?sh(?:[.-]|$)|metagraphsh/.test(host);
}

function isUnsafeIpAddress(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  return (
    family !== 0 &&
    unsafeIpBlocks.check(normalized, family === 4 ? "ipv4" : "ipv6")
  );
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

export function isCredentialedUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (credentialedUrlParams.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function redactCredentialedUrl(value) {
  if (!isCredentialedUrl(value)) {
    return value;
  }

  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function redactCredentialedUrls(value) {
  if (Array.isArray(value)) {
    return value.map(redactCredentialedUrls);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactCredentialedUrls(nested),
      ]),
    );
  }

  return typeof value === "string" ? redactCredentialedUrl(value) : value;
}

// Keys whose VALUES are redacted from a captured live response before it is
// committed as a fixture (issue #352) — credentials/secrets that a subnet API
// might echo back. Match common separator-delimited, camelCase, and compact
// spellings so live fixtures do not publish token/session-like fields.
const FIXTURE_SENSITIVE_KEY =
  /(?:^|[_-])(?:token|secret|api[_-]?key|apikey|password|passwd|pwd|authorization|auth|cookie|session|credential|private[_-]?key|mnemonic|seed[_-]?phrase|bearer|access[_-]?key|refresh[_-]?token|csrf[_-]?token|jwt)(?:[_-]|$)|(?:access|refresh|csrf|session|cookie|password|private|seed)(?:Token|Key|Id|Value|Hash|Phrase)\b|(?:apiKey|passwordHash|cookieValue|sessionId|csrfToken|accessToken|refreshToken|privateKey|seedPhrase|jwt)\b/i;

// Sanitize an arbitrary parsed JSON response from a third-party subnet API so a
// single live sample can be committed as a fixture (issue #352). Redacts
// sensitive keys + credentialed URLs, and bounds depth / array length / string
// length / key count so a hostile or huge response can never bloat the artifact
// or smuggle secrets. Deterministic + pure. Returns the bounded, redacted value.
export function sanitizeFixtureBody(
  value,
  { maxDepth = 6, maxArray = 20, maxString = 500, maxKeys = 60 } = {},
) {
  const walk = (node, depth) => {
    if (depth > maxDepth) return "[truncated: max depth]";
    if (typeof node === "string") {
      // Redact credentials AND private/loopback URLs. A captured spec can carry a
      // servers[].url pointing at localhost / 10.x / 192.168.x (operators leave
      // dev servers in their public OpenAPI); the publish public-safety scan
      // rejects those, so mirror the schema-snapshot sanitizer here too.
      const redacted = sanitizeSchemaText(redactCredentialedUrl(node));
      return redacted.length > maxString
        ? `${redacted.slice(0, maxString)}…[truncated]`
        : redacted;
    }
    if (Array.isArray(node)) {
      const out = node.slice(0, maxArray).map((item) => walk(item, depth + 1));
      if (node.length > maxArray) out.push(`[+${node.length - maxArray} more]`);
      return out;
    }
    if (node && typeof node === "object") {
      const out = {};
      const entries = Object.entries(node);
      for (const [key, nested] of entries.slice(0, maxKeys)) {
        out[key] = FIXTURE_SENSITIVE_KEY.test(key)
          ? "[redacted]"
          : walk(nested, depth + 1);
      }
      if (entries.length > maxKeys) {
        out["…"] = `[+${entries.length - maxKeys} more keys]`;
      }
      return out;
    }
    return node;
  };
  return walk(value, 0);
}

// Bounded reference to a captured live request/response fixture (#748). Gives an
// agent reading a subnet's callable services enough to see the example REQUEST
// (method + url) and the response shape (status + content_type) inline, plus
// artifact_path to fetch the full sanitized body (GET
// /metagraph/fixtures/{surface_id}.json, also the get_fixture MCP tool). The
// body itself is NOT inlined — captured bodies can be ~1 MB — so service detail
// stays lean and the one already-sanitized copy is served from a single place.
// Returns null when there is no fixture, so callers omit the field entirely.
export function surfaceFixtureReference(surfaceId, fixture) {
  if (!surfaceId || !fixture || typeof fixture !== "object") {
    return null;
  }
  const request = fixture.request || {};
  const response = fixture.response || {};
  return {
    captured_at: fixture.captured_at || null,
    request: {
      method: typeof request.method === "string" ? request.method : "GET",
      url: typeof request.url === "string" ? request.url : null,
    },
    response: {
      status: Number.isInteger(response.status) ? response.status : null,
      content_type:
        typeof response.content_type === "string"
          ? response.content_type
          : null,
    },
    artifact_path: `/metagraph/fixtures/${surfaceId}.json`,
  };
}

export function normalizePublicUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value
    .trim()
    .replace(/^<|>$/g, "")
    .split("](")[0]
    .replace(/\]+$/g, "");
  if (!candidate) {
    return null;
  }

  if (
    !/^(https?|wss?):\/\//i.test(candidate) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)
  ) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isCredentialedUrl(url.toString()) ||
      isUnsafeUrl(url.toString())
    ) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePublicHttpUrl(value) {
  const normalized = normalizePublicUrl(value);
  if (!normalized) {
    return null;
  }

  const protocol = new URL(normalized).protocol;
  return ["http:", "https:"].includes(protocol) ? normalized : null;
}

// Placeholder/junk identity URLs some subnets carry on-chain (e.g. the
// deprecated subnets' "https://deprecated.png" + "github.com/username/repo",
// or "example.com" stubs). These must never surface as real links.
const PLACEHOLDER_IDENTITY_URL = /deprecated|username\/repo|example\.com/i;

export function isPlaceholderIdentityUrl(value) {
  return typeof value === "string" && PLACEHOLDER_IDENTITY_URL.test(value);
}

// Resolve a subnet identity link (source_repo / website_url / logo_url):
// curated overlay wins; otherwise fall back to the cleaned on-chain value;
// otherwise null. Shared by build-artifacts (mergeSubnet) and validate
// (buildExpectedGeneratedSubnet) so the chain backfill can't drift between the
// generator and the reproducibility validator.
export function backfilledIdentityUrl(overlayValue, chainValue) {
  if (overlayValue) {
    return overlayValue;
  }
  const normalized = normalizePublicUrl(chainValue);
  if (!normalized || isPlaceholderIdentityUrl(normalized)) {
    return null;
  }
  return normalized;
}

// Social platforms recognized in the free-text on-chain `additional` field, by
// canonical host (#745).
const SOCIAL_HOSTS = {
  x: ["x.com", "twitter.com"],
  telegram: ["t.me", "telegram.me", "telegram.org"],
  reddit: ["reddit.com"],
  youtube: ["youtube.com", "youtu.be"],
};
const SOCIAL_KEYS = Object.keys(SOCIAL_HOSTS);

function socialHostKey(host) {
  const h = host.replace(/^www\./, "").toLowerCase();
  for (const key of SOCIAL_KEYS) {
    if (SOCIAL_HOSTS[key].some((d) => h === d || h.endsWith(`.${d}`))) {
      return key;
    }
  }
  return null;
}

function socialHostMatchesKey(url, key) {
  try {
    return socialHostKey(new URL(url).hostname) === key;
  } catch {
    return false;
  }
}

// Resolve a subnet/provider's structured social links: a curated overlay
// `social` object wins per platform; otherwise extract from the free-text
// on-chain `additional` content (sanitized + junk-guarded via
// normalizePublicHttpUrl). Returns a { x?, telegram?, reddit?, youtube? } object
// or null. Shared by build-artifacts (mergeSubnet) and validate
// (buildExpectedGeneratedSubnet) so the chain extraction can't drift.
// Display-only: a chain-claimed handle is NOT verification, and this NEVER feeds
// completeness_score/missing_* (the flywheel's gaps stay the product).
export function socialAccounts(additionalText, overlaySocial = null) {
  const out = {};
  const text = typeof additionalText === "string" ? additionalText : "";
  const re =
    /\b(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.(?:me|org)|reddit\.com|youtube\.com|youtu\.be)\/[^\s"'<>)\]]+/gi;
  for (const raw of text.match(re) || []) {
    const normalized = normalizePublicHttpUrl(raw.replace(/[.,;]+$/, ""));
    if (!normalized || isPlaceholderIdentityUrl(normalized)) {
      continue;
    }
    let host;
    try {
      host = new URL(normalized).hostname;
    } catch {
      continue;
    }
    const key = socialHostKey(host);
    if (key && !out[key]) {
      out[key] = normalized;
    }
  }
  if (
    overlaySocial &&
    typeof overlaySocial === "object" &&
    !Array.isArray(overlaySocial)
  ) {
    for (const key of SOCIAL_KEYS) {
      const curated = normalizePublicHttpUrl(overlaySocial[key]);
      if (curated && socialHostMatchesKey(curated, key)) {
        out[key] = curated;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

// Taostats-survey follow-up: the operator's published support contact
// (SubnetIdentitiesV3 `subnet_contact` — an email or URL). metagraphed otherwise
// keeps only a `contact_present` boolean, dropping the value an integration dev
// (or agent) needs to reach a team when an API breaks. Overlay-driven and
// sanitized — never parsed from free chain text, so it can't carry injection;
// display-only, never feeds completeness (the #343 flywheel gate). Returns a
// bare email (lowercased) or a normalized public URL, else null.
const CONTACT_JUNK_VALUES = new Set([
  "deprecated",
  "none",
  "n/a",
  "na",
  "tbd",
  "-",
  "null",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function subnetContact(overlayContact) {
  if (typeof overlayContact !== "string") return null;
  const value = overlayContact.trim();
  if (!value || CONTACT_JUNK_VALUES.has(value.toLowerCase())) return null;
  const email = /^mailto:/i.test(value) ? value.slice(7).trim() : value;
  if (EMAIL_RE.test(email)) {
    // Reject junk placeholders that happen to be well-formed (deprecated@…).
    const local = email.slice(0, email.indexOf("@")).toLowerCase();
    return CONTACT_JUNK_VALUES.has(local) ? null : email.toLowerCase();
  }
  const url = normalizePublicHttpUrl(value);
  return url && !isPlaceholderIdentityUrl(url) ? url : null;
}

export function registrySurfaceKey(entry) {
  const normalizedUrl = normalizePublicUrl(entry?.url);
  return [
    entry?.netuid ?? "unknown",
    entry?.kind || "unknown",
    normalizedUrl || entry?.url || "unknown",
  ]
    .join("|")
    .toLowerCase();
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

export function isJsonContentType(value) {
  return String(value || "")
    .toLowerCase()
    .includes("json");
}

export function isHtmlContentType(value) {
  return String(value || "")
    .toLowerCase()
    .includes("html");
}

// Conventional, read-only paths where a subnet or provider commonly exposes a
// machine-readable OpenAPI 3.x (or legacy Swagger 2.0) document. Auto-discovery
// (#1004) probes these on each known base origin to surface callable APIs the
// registry can then validate, capture, and promote.
export const OPENAPI_PROBE_PATHS = Object.freeze([
  "/openapi.json",
  "/swagger.json",
  "/swagger/v1/swagger.json",
  "/docs/openapi.json",
  "/api/openapi.json",
  "/api/v1/openapi.json",
  "/v1/openapi.json",
  "/.well-known/openapi.json",
]);

// Structural check that a parsed JSON value is a genuine OpenAPI/Swagger
// document — not merely some JSON served at /openapi.json. Requires the version
// marker plus the `info` and `paths` objects every spec carries, so a stray
// config or error body never registers as a callable API. Pure + side-effect
// free, so it is exhaustively unit-testable.
export function isOpenApiDocument(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const version =
    typeof body.openapi === "string"
      ? body.openapi
      : typeof body.swagger === "string"
        ? body.swagger
        : null;
  // OpenAPI reports "3.x.y"; Swagger reports "2.0". Reject anything else.
  if (!version || !/^[23]\.\d/.test(version)) {
    return false;
  }
  const isPlainObject = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return isPlainObject(body.info) && isPlainObject(body.paths);
}

// Probe an ordered list of candidate spec paths on `origin`, returning the first
// whose body is a valid OpenAPI/Swagger document as `{ url, document }`, or null
// if none match. `fetcher(url)` owns all network + safety concerns (timeout,
// body cap, private-IP/unsafe-URL block) and returns the parsed JSON body or
// null; keeping it injectable leaves this orchestration pure and mock-driven in
// tests. A fetcher that throws is treated as a miss for that path, so one bad
// path never aborts the sweep.
export async function probeOpenApiSpec(origin, paths, fetcher) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  for (const specPath of paths) {
    const url = new URL(specPath, base).toString();
    let body;
    try {
      body = await fetcher(url);
    } catch {
      continue;
    }
    if (isOpenApiDocument(body)) {
      return { url, document: body };
    }
  }
  return null;
}

export function buildTimestamp() {
  return process.env.METAGRAPH_BUILD_TIMESTAMP || "1970-01-01T00:00:00.000Z";
}

// Strip embedded URLs/emails/bare-domains from free text — they shred into junk
// search tokens ("https"/"com"/"gg") and read poorly.
export function stripUrls(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/gi, " ")
    .replace(
      /\b[\w-]+\.(?:com|io|org|net|gg|ai|xyz|dev|app|finance|sh|co)\b\S*/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// On-chain identity text (SubnetIdentitiesV3 description/name/additional, and any
// candidate-overlay text seeded from it) is attacker-controllable and is piped
// verbatim to LLMs via /ask, the MCP tools, search, and llms.txt. These rules
// DEFUSE prompt-injection: they neutralize the markers an attacker uses to make
// a reading model treat the data as instructions — chat-template/role tokens,
// turn/role boundaries, fence break-outs, and "ignore previous"/"act as" takeover
// phrasing — while leaving ordinary prose readable. We defang, not delete, so a
// benign description that merely mentions these words stays legible. All patterns
// use bounded quantifiers (no nested unbounded repetition) so they are
// ReDoS-safe. Order: specific tokens first, then phrasing.
const CHAIN_TEXT_INJECTION_RULES = [
  // Chat-template / model special tokens: ChatML <|...|>, Llama [INST], BOS/EOS.
  { re: /<\|[^|>\n]{0,40}\|>/g, to: " " },
  { re: /\[\/?INST\]/gi, to: " " },
  { re: /<\/?(?:s|system|user|assistant)>/gi, to: " " },
  // Fenced code/quote delimiters used to "break out" of a quoted data span.
  { re: /```+|~~~+/g, to: " " },
  // Line-start role / section markers: "System:", "### Instruction:", "Assistant：".
  {
    re: /(^|\n)[ \t]{0,8}#{0,4}[ \t]*(system|assistant|user|developer|human|instruction|prompt)[ \t]*[:：]/gi,
    to: "$1$2 ",
  },
  // Classic instruction-override phrasing ("ignore the previous instructions").
  {
    re: /\b(?:ignore|disregard|forget|override|bypass)\b(?:[ \t,]+\w+){0,4}[ \t]+(?:previous|prior|above|earlier|preceding|system|initial|all)\b[^.!?\n]{0,40}/gi,
    to: " [scrubbed] ",
  },
  // Role-takeover phrasing ("you are now ...", "act as a developer", "new instructions:").
  {
    re: /\b(?:you are now|from now on|act as(?: an?)?|pretend(?: to be| you are)?|new instructions?)\b[^.!?\n]{0,40}/gi,
    to: " [scrubbed] ",
  },
];

// Neutralize prompt-injection markers in attacker-controllable on-chain text.
// Returns the defanged text plus `scrubbed` (whether any marker was neutralized)
// so artifacts can tag `injection_scrubbed` and downstream agents know the text
// was modified and must be treated as untrusted data, never instructions.
// Deterministic + idempotent, so the build and the reproducibility validator
// derive identical output. Does NOT strip URLs — that is cleanDescription's job.
export function sanitizeChainText(value) {
  if (typeof value !== "string") return { text: null, scrubbed: false };
  let text = value;
  let scrubbed = false;
  for (const { re, to } of CHAIN_TEXT_INJECTION_RULES) {
    const next = text.replace(re, to);
    if (next !== text) scrubbed = true;
    text = next;
  }
  return { text, scrubbed };
}

// Conservative shape for a Discord-style handle: optional leading @, then a
// short run of word/period/hyphen chars, optionally a legacy #1234 tag.
// Anything outside this (spaces, colons, markup, brackets) is rejected, not
// defanged — a contact field has no business carrying prose.
const CONTACT_HANDLE_PATTERN = /^@?[a-z0-9][a-z0-9._-]{1,63}(?:#\d{1,6})?$/i;
// Junk stubs observed in the on-chain discord slot ("deprecated", "None").
// Exact matches only — substring matching would wrongly drop a real handle
// that merely contains "deprecated" or "example".
const CONTACT_HANDLE_JUNK = /^(?:deprecated|none|null|n\/a|tbd|todo)$/i;

// Resolve a subnet's on-chain Discord contact (SubnetIdentitiesV3.discord)
// for display. It is attacker-controllable free text piped to LLMs (index →
// /api/v1/subnets → agents), so this is an allowlist, not a defang: a value
// is either an explicit URL that passes the full public-URL guard, a string
// that looks like a plain handle, or it is dropped. Deterministic +
// idempotent so the build and the reproducibility validator never drift.
export function nativeContactHandle(value) {
  if (typeof value !== "string") return null;
  const cleaned = sanitizeChainText(value).text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 200) return null;
  // Scheme'd values (https://…, but also javascript:/data:/mailto:) must pass
  // the same guard as every public identity URL — scheme allowlist, SSRF and
  // credential checks, placeholder filter — so a hostile URI can never ride
  // in as a "handle".
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    const normalized = normalizePublicUrl(cleaned);
    return normalized && !isPlaceholderIdentityUrl(normalized)
      ? normalized
      : null;
  }
  if (
    !CONTACT_HANDLE_PATTERN.test(cleaned) ||
    CONTACT_HANDLE_JUNK.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

// URL form of a nativeContactHandle result: the contact when it is an explicit
// URL, else null. The index discord_url deliberately surfaces only scheme'd
// chain values — normalizePublicUrl alone would puff a dotted handle
// ("dev.alveuslabs") into a fake domain. Shared by the mainnet and testnet
// index builders so the two projections cannot drift.
export function nativeContactUrl(contact) {
  return contact && /^(?:https?|wss?):\/\//i.test(contact) ? contact : null;
}

// Normalize a free-text description (chain SubnetIdentitiesV3 / overlay):
// neutralize prompt-injection, strip URLs, collapse whitespace, drop empties.
// Shared by the build + the reproducibility validator so the two never drift.
// Bare placeholder words some subnets set as their ENTIRE on-chain description
// ("deprecated", "none", "tbd", …) — treated as no description, mirroring
// CONTACT_HANDLE_JUNK. Several deprecated subnets (sn3/39/81) carry a literal
// "deprecated" description on-chain that should not leak into the served data.
const JUNK_DESCRIPTION = /^(?:deprecated|none|null|n\/a|tbd|todo|test)$/i;

export function cleanDescription(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripUrls(sanitizeChainText(value).text);
  if (cleaned.length < 2) return null;
  if (JUNK_DESCRIPTION.test(cleaned.trim())) return null;
  return cleaned;
}

// Domain/capability tag derivation (issue #345) lives in the worker-safe
// src/domain-tags.mjs so the build and the Worker's ?domain= enum share one
// vocabulary; re-exported here for the build-side import sites.
export { DOMAIN_TAGS, deriveDomainTags } from "../src/domain-tags.mjs";

// Cross-network lineage join (issue #353): publish only maintainer-approved
// cross-network pairs. On-chain github_repo/name equality is attacker-controlled
// in the public registry threat model, so it can be review evidence but must not
// authorize a public lineage link by itself.
const LINEAGE_MATCH_TYPES = new Set(["github_repo", "chain_name"]);

// Join two native-subnet lists (each: { netuid, name/raw_name, chain_identity })
// using only curated approvals [{ mainnet_netuid/source_netuid,
// testnet_netuid/target_netuid, matched_by }]. Returns sorted links
// [{ source_netuid, target_netuid, matched_by }]. Deterministic + pure so the
// build and the validator never drift.
export function buildSubnetLineageLinks(
  sourceSubnets,
  targetSubnets,
  approvedLinks = [],
  brokenLinks = [],
) {
  const sourcesByNetuid = new Map(
    (sourceSubnets || []).map((source) => [source.netuid, source]),
  );
  const targetsByNetuid = new Map(
    (targetSubnets || []).map((target) => [target.netuid, target]),
  );
  const links = [];
  const seen = new Set();
  for (const approval of approvedLinks || []) {
    const sourceNetuid = approval?.source_netuid ?? approval?.mainnet_netuid;
    const targetNetuid = approval?.target_netuid ?? approval?.testnet_netuid;
    if (
      !Number.isInteger(sourceNetuid) ||
      !Number.isInteger(targetNetuid) ||
      !LINEAGE_MATCH_TYPES.has(approval?.matched_by)
    ) {
      // #1012: don't silently drop — record the malformed approval so it's fixable.
      brokenLinks.push({
        source_netuid: Number.isInteger(sourceNetuid) ? sourceNetuid : null,
        target_netuid: Number.isInteger(targetNetuid) ? targetNetuid : null,
        reason: "invalid-approval",
      });
      continue;
    }
    const source = sourcesByNetuid.get(sourceNetuid);
    const target = targetsByNetuid.get(targetNetuid);
    if (!source || !target) {
      // #1012: an approval referencing a netuid that no longer exists on its
      // network — surface it instead of silently dropping the lineage link.
      brokenLinks.push({
        source_netuid: sourceNetuid,
        target_netuid: targetNetuid,
        reason: !source ? "source-netuid-missing" : "target-netuid-missing",
      });
      continue;
    }
    const key = `${sourceNetuid}:${targetNetuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      source_netuid: sourceNetuid,
      target_netuid: targetNetuid,
      matched_by: approval.matched_by,
    });
  }
  return links.sort(
    (a, b) =>
      a.source_netuid - b.source_netuid || a.target_netuid - b.target_netuid,
  );
}

// Public/private suffixes that make the last-two-label heuristic unsafe for
// provider shared-team clustering. This deliberately covers common multi-label
// Public Suffix List rules and private multi-tenant hosts used for documentation
// or app/site hosting; matched hosts cluster on the tenant label, not the shared
// suffix (for example team-a.co.uk, not co.uk).
// Country-code multi-label public suffixes (eTLD+1 needs the extra label so
// `team-a.co.uk` clusters as `team-a.co.uk`, not `co.uk`).
const CLUSTER_CCTLD_SUFFIXES = [
  "ac.uk",
  "co.uk",
  "gov.uk",
  "ltd.uk",
  "me.uk",
  "net.uk",
  "nhs.uk",
  "org.uk",
  "plc.uk",
  "sch.uk",
  "asn.au",
  "com.au",
  "edu.au",
  "gov.au",
  "net.au",
  "org.au",
  "co.nz",
  "geek.nz",
  "gen.nz",
  "govt.nz",
  "iwi.nz",
  "maori.nz",
  "net.nz",
  "org.nz",
  "school.nz",
  "ac.jp",
  "co.jp",
  "ed.jp",
  "go.jp",
  "gr.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "co.in",
  "co.kr",
  "co.za",
];

// Multi-tenant platform hosts: each subdomain is a distinct tenant, so the
// cluster unit is the full `<tenant>.<suffix>` and the bare suffix is not a
// cluster of its own. Single source of truth — `clusterDomainFromUrl` (here)
// and `isGenericClusterHost` (build-artifacts.mjs) both consume this set so the
// two cannot drift (issue #419).
export const MULTI_TENANT_HOST_SUFFIXES = new Set([
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "netlify.com",
  "surge.sh",
  "onrender.com",
  "azurewebsites.net",
  "r2.dev",
  "notion.site",
  "pythonanywhere.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "fly.dev",
  "glitch.me",
  "repl.co",
  "webflow.io",
]);

const CLUSTER_MULTI_LABEL_SUFFIXES = new Set([
  ...CLUSTER_CCTLD_SUFFIXES,
  ...MULTI_TENANT_HOST_SUFFIXES,
]);

const CLUSTER_COUNTRY_CODE_SECOND_LEVEL_SUFFIX_LABELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gov",
  "net",
  "ne",
  "or",
  "org",
]);

function clusterSuffixDomain(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host || null;
  if (labels.at(-1) === "com" && labels.at(-2) === "appspot") {
    if (labels.at(-3) === "r") {
      return labels.length >= 5 ? labels.slice(-5).join(".") : null;
    }
    return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  }
  for (
    let suffixLabelCount = labels.length;
    suffixLabelCount >= 2;
    suffixLabelCount -= 1
  ) {
    const suffix = labels.slice(-suffixLabelCount).join(".");
    if (CLUSTER_MULTI_LABEL_SUFFIXES.has(suffix)) {
      return labels.length > suffixLabelCount
        ? labels.slice(-(suffixLabelCount + 1)).join(".")
        : null;
    }
  }
  const [secondLevel, topLevel] = labels.slice(-2);
  if (
    labels.length >= 3 &&
    topLevel.length === 2 &&
    CLUSTER_COUNTRY_CODE_SECOND_LEVEL_SUFFIX_LABELS.has(secondLevel)
  ) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

// Registrable domain (eTLD+1) of a URL, for the provider shared-team cluster
// heuristic (issue #347). Returns null on unparseable input or bare shared
// suffixes that cannot identify a provider team.
export function clusterDomainFromUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return clusterSuffixDomain(host);
  } catch {
    return null;
  }
}

// #1007: the distinct discovery sources (clustered domains) that independently
// surfaced a candidate, from its source_urls. 2+ distinct sources is strong
// corroboration — a URL claimed by both TaoMarketCap and a GitHub README is more
// trustworthy than a single-source one — and feeds a `confirmed_by` field plus a
// verification-score bonus (scoreCandidate). Pure + deterministic (sorted,
// deduped); clusterDomainFromUrl folds api./docs. subdomains into one source so
// two URLs on the same site never read as independent corroboration.
export function corroboratingSources(candidate) {
  const urls = Array.isArray(candidate?.source_urls)
    ? candidate.source_urls
    : [];
  return [...new Set(urls.map(clusterDomainFromUrl).filter(Boolean))].sort();
}

// Build a fallback "what does it do" blurb from curated provider notes when a
// subnet has no chain/overlay description (issue #346). Sanitized + truncated to
// a word boundary. This populates a SEPARATE derived_description field — it never
// backfills the curated description, so the gap stays visible to the SN74
// flywheel. Returns null when there is nothing usable.
export function deriveDescriptionFromNotes(notes, { maxLength = 280 } = {}) {
  if (typeof notes !== "string") return null;
  const cleaned = cleanDescription(notes);
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned
    .slice(0, maxLength)
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}

// Pull a usable OAuth2/OIDC token (or authorize) endpoint out of a security
// scheme, tolerating OpenAPI 3 `flows.*` and Swagger 2 top-level shapes.
function oauthTokenUrl(scheme) {
  if (typeof scheme.openIdConnectUrl === "string") {
    return scheme.openIdConnectUrl;
  }
  const flows =
    scheme.flows && typeof scheme.flows === "object" ? scheme.flows : {};
  for (const flow of Object.values(flows)) {
    if (flow && typeof flow.tokenUrl === "string") {
      return flow.tokenUrl;
    }
    if (flow && typeof flow.authorizationUrl === "string") {
      return flow.authorizationUrl;
    }
  }
  if (typeof scheme.tokenUrl === "string") {
    return scheme.tokenUrl;
  }
  if (typeof scheme.authorizationUrl === "string") {
    return scheme.authorizationUrl;
  }
  return null;
}

// Map a captured OpenAPI/Swagger securitySchemes object to a single structured
// auth hint a caller can act on (#746): the scheme + concrete header/param name
// and a value PLACEHOLDER (never a real secret). Prefers a concrete api-key/http
// scheme over oauth2 when several are declared. token_url is junk/SSRF-guarded.
export function deriveAuthDetail(schemes) {
  const entries = Object.values(schemes || {}).filter(
    (scheme) => scheme && typeof scheme === "object",
  );
  if (!entries.length) {
    return null;
  }
  const pick =
    entries.find((scheme) => String(scheme.type).toLowerCase() === "apikey") ||
    entries.find((scheme) => String(scheme.type).toLowerCase() === "http") ||
    entries[0];
  const type = String(pick.type || "").toLowerCase();
  if (type === "apikey" && typeof pick.name === "string" && pick.name) {
    const location = ["header", "query", "cookie"].includes(pick.in)
      ? pick.in
      : "header";
    return {
      scheme: "api-key",
      location,
      name: pick.name,
      value_format: "<api-key>",
    };
  }
  if (type === "http") {
    if (String(pick.scheme || "").toLowerCase() === "basic") {
      return {
        scheme: "basic",
        location: "header",
        name: "Authorization",
        value_format: "Basic <base64(user:pass)>",
      };
    }
    return {
      scheme: "bearer",
      location: "header",
      name: "Authorization",
      value_format: "Bearer <token>",
    };
  }
  if (type === "oauth2" || type === "openidconnect") {
    const detail = {
      scheme: "oauth2",
      location: "header",
      name: "Authorization",
      value_format: "Bearer <token>",
    };
    const tokenUrl = normalizePublicHttpUrl(oauthTokenUrl(pick));
    if (tokenUrl) {
      detail.token_url = tokenUrl;
    }
    return detail;
  }
  return null;
}

// Derive auth metadata from a captured OpenAPI/Swagger spec: OpenAPI 3
// components.securitySchemes or Swagger 2 securityDefinitions. A spec that
// declares any security scheme is treated as requiring auth — the fix for
// services (e.g. Chutes) that declare apiKey yet were flagged auth_required:false.
export function extractAuth(spec) {
  const schemes =
    (spec?.components && spec.components.securitySchemes) ||
    spec?.securityDefinitions ||
    {};
  const authSchemes = [
    ...new Set(
      Object.values(schemes)
        .map((scheme) => scheme?.type)
        .filter((type) => typeof type === "string"),
    ),
  ].sort();
  return {
    auth_required: authSchemes.length > 0,
    auth_schemes: authSchemes,
    // Structured, caller-actionable detail (#746): exact header/param + value
    // placeholder. null when no scheme is declared.
    auth_detail: deriveAuthDetail(schemes),
  };
}

// Declared lifecycle, derived from canonical on-chain identity names (teams set
// subnet_name exactly to "deprecated"/"Parked"/"Pending" when a subnet is no
// longer a live product), distinct from `status` (chain-registration state,
// which stays "active"). Avoid scanning descriptions: they are free-form
// attacker-influenced metadata and can contain words such as "not deprecated"
// or "patent pending" for otherwise live subnets. Shared by the build + the
// reproducibility validator.
export function subnetLifecycle(nativeSubnet) {
  const name = (nativeSubnet?.chain_identity?.subnet_name || "")
    .trim()
    .toLowerCase();
  if (name === "deprecated") return "deprecated";
  if (name === "parked") return "parked";
  if (name === "pending") return "pending";
  return "active";
}

// Real wall-clock publish time, distinct from the deterministic build stamp.
// `buildTimestamp()` stays reproducible (epoch by default) so artifact hashing
// and changelog diffs are stable; `publishedAt()` carries the true publish
// moment for consumer-facing freshness. It is null for local/deterministic
// builds (honest: "not published") and set by the publish workflow via
// METAGRAPH_PUBLISHED_AT. It must only be written to artifacts that are
// excluded from the deterministic digest set (e.g. build-summary.json).
export function publishedAt() {
  const value = (process.env.METAGRAPH_PUBLISHED_AT || "").trim();
  return value || null;
}

// Freshness auto-demotion (beta-roadmap Finding 9). Given a subnet's probed
// health rows grouped by surface kind and the probe run's reference time,
// returns the set of operational kinds that are present but NOT currently
// verified healthy-and-fresh (status "ok" with a last_ok within
// `staleAfterDays` of the probe run). Such kinds are demoted in the
// completeness score and flagged, so "complete" reflects *current* liveness
// rather than a one-time observation.
//
// Determinism: when there is no probe reference time (a committed / non-probe
// build, like CI's artifact-verify checkout with no probe cache), this returns
// an empty set — so the demotion only manifests in probe-backed production
// builds and never churns the committed "shop window" artifacts. A kind with no
// health rows is treated as unverified (not stale), so subnets whose surfaces
// simply were not probed are never penalised.
export function staleOperationalKinds({
  operationalKinds,
  healthByKind,
  probeFinishedAt,
  staleAfterDays = 7,
}) {
  const stale = new Set();
  const referenceMs = probeFinishedAt ? Date.parse(probeFinishedAt) : NaN;
  if (!Number.isFinite(referenceMs)) {
    return stale;
  }
  const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000;
  const lookup = (kind) =>
    healthByKind && typeof healthByKind.get === "function"
      ? healthByKind.get(kind)
      : healthByKind?.[kind];
  for (const kind of operationalKinds || []) {
    const rows = lookup(kind);
    if (!rows || !rows.length) {
      continue;
    }
    const verifiedFresh = rows.some((row) => {
      if (!row || row.status !== "ok") return false;
      const okMs = row.last_ok ? Date.parse(row.last_ok) : NaN;
      return Number.isFinite(okMs) && referenceMs - okMs <= staleAfterMs;
    });
    if (!verifiedFresh) {
      stale.add(kind);
    }
  }
  return stale;
}

export const README_LINK_LIMIT = 5;

export const README_KIND_LIMITS = {
  dashboard: 2,
  "data-artifact": 1,
  docs: 1,
  openapi: 2,
  "subnet-api": 2,
  website: 1,
};

// #1008: detect a code-example / quickstart link from a normalized haystack
// (`"<label> <hostname> <pathname>"`, lowercased). `/example` matches both
// `/example/` and `/examples/`. Pure + exported so the discovery classifier and
// its tests share one definition. Callers check this AHEAD of the generic
// api/docs heuristics so an examples dir is not mis-bucketed.
export function isLikelyExampleLink(haystack) {
  if (typeof haystack !== "string") return false;
  return (
    haystack.includes("/example") ||
    haystack.includes("quickstart") ||
    haystack.includes("quick-start") ||
    haystack.includes("getting-started") ||
    haystack.includes("/tutorial") ||
    haystack.includes(".ipynb") ||
    haystack.includes("colab.research.google")
  );
}

const GENERIC_README_REFERENCE_HOSTS = [
  "arxiv.org",
  "astral.sh",
  "bittensor.com",
  "docs.google.com",
  "ico.org.uk",
  "kubernetes.io",
  "learnbittensor.org",
  "nextjs.org",
  "openai.com",
  "pm2.io",
  "python.org",
  "subnetradar.com",
  "taomarketcap.com",
  "taostats.io",
];

const README_AFFINITY_STOPWORDS = new Set([
  "ai",
  "api",
  "app",
  "bittensor",
  "docs",
  "github",
  "inc",
  "io",
  "labs",
  "ltd",
  "main",
  "miner",
  "network",
  "org",
  "protocol",
  "repo",
  "subnet",
  "the",
  "validator",
  "www",
]);

export function selectReviewableReadmeLinks(
  links,
  { limit = README_LINK_LIMIT, netuid, repo } = {},
) {
  const selected = [];
  const seen = new Set();
  const kindCounts = new Map();

  for (const link of links || []) {
    if (!isReviewableReadmeLink(link, { netuid, repo })) {
      continue;
    }

    const key = readmeDedupeKey(link);
    if (seen.has(key)) {
      continue;
    }

    const kind = link.classification.kind;
    const kindLimit = README_KIND_LIMITS[kind] || 1;
    if ((kindCounts.get(kind) || 0) >= kindLimit) {
      continue;
    }

    seen.add(key);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    selected.push(link);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

export function isReviewableReadmeLink(link, { netuid, repo } = {}) {
  if (!link?.url || !link.classification?.kind) {
    return false;
  }

  if (isGenericReadmeReferenceHost(link.url)) {
    return false;
  }

  return hasReadmeProjectAffinity(link, { netuid, repo });
}

function readmeDedupeKey(link) {
  try {
    return `${link.classification.kind}:${registrableDomain(
      new URL(link.url).hostname,
    )}`;
  } catch {
    return `${link.classification.kind}:${String(link.url || "").toLowerCase()}`;
  }
}

function isGenericReadmeReferenceHost(value) {
  try {
    const host = normalizeHost(new URL(value).hostname);
    return GENERIC_README_REFERENCE_HOSTS.some(
      (genericHost) => host === genericHost || host.endsWith(`.${genericHost}`),
    );
  } catch {
    return true;
  }
}

function hasReadmeProjectAffinity(link, { netuid, repo } = {}) {
  let url;
  try {
    url = new URL(link.url);
  } catch {
    return false;
  }

  const rawHaystack = [url.hostname, url.pathname, url.search, link.label || ""]
    .join(" ")
    .toLowerCase();
  const compactHaystack = compactReadmeValue(rawHaystack);

  if (Number.isInteger(netuid) && hasNetuidAffinity(rawHaystack, netuid)) {
    return true;
  }

  return repoTokens(repo).some((token) => compactHaystack.includes(token));
}

function hasNetuidAffinity(value, netuid) {
  const escaped = String(netuid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(^|[^a-z0-9])sn[-_ ]?${escaped}([^a-z0-9]|$)`, "i"),
    new RegExp(`(^|[^a-z0-9])subnets?[-_/= ]?${escaped}([^a-z0-9]|$)`, "i"),
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    return true;
  }

  const compactValue = compactReadmeValue(value);
  return (
    compactValue.includes(`sn${netuid}`) ||
    compactValue.includes(`subnet${netuid}`) ||
    compactValue.includes(`subnets${netuid}`)
  );
}

function repoTokens(repo = {}) {
  const rawTokens = `${repo.owner || ""} ${repo.repo || ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compactTokens = [
    compactReadmeValue(repo.owner || ""),
    compactReadmeValue(repo.repo || ""),
  ].filter(Boolean);

  return [
    ...new Set(
      [...rawTokens, ...compactTokens].map(compactReadmeValue).filter(Boolean),
    ),
  ].filter(
    (token) => token.length >= 3 && !README_AFFINITY_STOPWORDS.has(token),
  );
}

function compactReadmeValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

function registrableDomain(hostname) {
  const parts = normalizeHost(hostname).split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// #1009: per-subnet validator + economic entity, derived from the chain
// snapshot's `economics` block (validator/miner counts, stake, registration
// cost, alpha price). dTAO emission is price-weighted, so each subnet's
// emission_share is its alpha price as a fraction of the network total across
// every subnet that reports one — computed here rather than read from the
// now-zeroed on-chain subnet_emission field. Pure + side-effect free so it is
// fully unit-testable; subnets with no economics block are omitted (graceful
// when the snapshot predates the economics fetcher).
export function buildEconomicsArtifact({
  subnets,
  economicsByNetuid,
  generatedAt,
  network = null,
  capturedAt = null,
}) {
  const numericOrZero = (value) => (typeof value === "number" ? value : 0);
  const round = (value, places) => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  };
  const withEconomics = subnets
    .map((subnet) => ({
      subnet,
      economics: economicsByNetuid.get(subnet.netuid) || null,
    }))
    .filter((entry) => entry.economics);
  const totalAlphaPrice = withEconomics.reduce(
    (sum, { economics }) => sum + numericOrZero(economics.alpha_price_tao),
    0,
  );
  const rows = withEconomics.map(({ subnet, economics }) => {
    const price =
      typeof economics.alpha_price_tao === "number"
        ? economics.alpha_price_tao
        : null;
    const emissionShare =
      price != null && totalAlphaPrice > 0
        ? round(price / totalAlphaPrice, 6)
        : null;
    return {
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      ...economics,
      emission_share: emissionShare,
    };
  });
  // Highest emission share first (the "top subnets by emission" view); stable
  // tiebreak on netuid so the order is deterministic.
  rows.sort(
    (a, b) =>
      (b.emission_share ?? -1) - (a.emission_share ?? -1) ||
      a.netuid - b.netuid,
  );
  const sumField = (field) =>
    rows.reduce((sum, row) => sum + numericOrZero(row[field]), 0);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    network,
    captured_at: capturedAt,
    summary: {
      subnet_count: subnets.length,
      with_economics_count: rows.length,
      total_stake_tao: round(sumField("total_stake_tao"), 9),
      total_validators: sumField("validator_count"),
      total_miners: sumField("miner_count"),
      registration_open_count: rows.filter((row) => row.registration_allowed)
        .length,
    },
    subnets: rows,
  };
}

export function buildRpcEndpointArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces
    .filter((surface) =>
      ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
    )
    .map((surface) => {
      const health = healthBySurface.get(surface.id) || {};
      const healthMeta = endpointHealthMetadata({
        health,
        monitored: true,
      });
      return {
        id: surface.id,
        netuid: surface.netuid,
        subnet_slug: surface.subnet_slug,
        subnet_name: surface.subnet_name,
        chain: "bittensor",
        network: "finney",
        kind: surface.kind,
        url: surface.url,
        provider: surface.provider,
        authority: surface.authority,
        auth_required: surface.auth_required,
        public_safe: surface.public_safe,
        archive_support: health.archive_support ?? null,
        latest_block: health.latest_block ?? null,
        methods_supported: health.methods_supported || null,
        rpc_method_count: health.rpc_method_count ?? null,
        method_tested: health.method_tested || surface.probe?.method || null,
        status: health.status || "unknown",
        classification: health.classification || "unknown",
        latency_ms: health.latency_ms ?? null,
        observed_at: healthMeta.observed_at,
        health_source: healthMeta.health_source,
        health_stale: healthMeta.health_stale,
        last_ok: healthMeta.last_ok,
        last_checked: healthMeta.last_checked,
        error: health.error || null,
        rate_limit_notes: surface.rate_limit_notes || null,
        source_urls: surface.source_urls || [],
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes:
      "Bittensor base-layer RPC endpoints only. These are chain-level surfaces, not subnet application APIs.",
    summary: {
      endpoint_count: endpoints.length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
      archive_supported_count: endpoints.filter(
        (endpoint) => endpoint.archive_support === true,
      ).length,
    },
    endpoints,
  };
}

export function buildEndpointResourceArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces.map((surface) => {
    const surfaceKey = surface.key || surfaceStableKey(surface);
    const health = healthBySurface.get(surface.id) || {};
    const monitored = surface.probe?.enabled === true && surface.public_safe;
    const healthMeta = endpointHealthMetadata({
      health,
      monitored,
    });
    const scoreBreakdown = endpointScoreBreakdown({
      ...surface,
      ...health,
      status: health.status || "unknown",
    });
    const poolEligibility = endpointPoolEligibility({
      ...surface,
      status: health.status || "unknown",
    });

    return {
      id: `endpoint-${surfaceKey}`,
      surface_id: surface.id,
      surface_key: surfaceKey,
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      subnet_name: surface.subnet_name,
      chain: "bittensor",
      network: "finney",
      layer: endpointLayer(surface.kind),
      kind: surface.kind,
      url: surface.url,
      provider: surface.provider,
      operator: surface.provider,
      authority: surface.authority,
      auth_required: surface.auth_required,
      public_safe: surface.public_safe,
      monitoring_policy: endpointMonitoringPolicy(surface),
      monitoring_status: monitored ? "monitored" : "not_monitored",
      publication_state: endpointPublicationState({
        monitored,
        poolEligible: poolEligibility.eligible,
        surface,
      }),
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons: poolEligibility.reasons,
      archive_support: health.archive_support ?? null,
      latest_block: health.latest_block ?? null,
      method_support: health.methods_supported || null,
      rpc_method_count: health.rpc_method_count ?? null,
      method_tested: health.method_tested || surface.probe?.method || null,
      status: monitored ? health.status || "unknown" : "unknown",
      classification: monitored
        ? health.classification || "unknown"
        : "unknown",
      latency_ms: monitored ? (health.latency_ms ?? null) : null,
      observed_at: healthMeta.observed_at,
      health_source: healthMeta.health_source,
      health_stale: healthMeta.health_stale,
      score: scoreBreakdown.score,
      score_reasons: scoreBreakdown.reasons,
      last_ok: healthMeta.last_ok,
      last_checked: healthMeta.last_checked,
      error: monitored ? health.error || null : null,
      rate_limit_notes: surface.rate_limit_notes || null,
      source_urls: surface.source_urls || [],
    };
  });

  endpoints.sort(
    (a, b) =>
      a.netuid - b.netuid ||
      a.layer.localeCompare(b.layer) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes: [
      "Endpoint resources are normalized from curated public surfaces.",
      "Observed health, latency, and pool eligibility are probe-derived only.",
      "Subnet application APIs are heterogeneous and are not proxied in v1.",
    ],
    summary: {
      endpoint_count: endpoints.length,
      monitored_count: endpoints.filter(
        (endpoint) => endpoint.monitoring_status === "monitored",
      ).length,
      pool_eligible_count: endpoints.filter(
        (endpoint) => endpoint.pool_eligible,
      ).length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_layer: countRecord(endpoints, (endpoint) => endpoint.layer),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_publication_state: countRecord(
        endpoints,
        (endpoint) => endpoint.publication_state,
      ),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
    },
    endpoints,
  };
}

export function buildEndpointPoolArtifact({
  generatedAt,
  contractVersion,
  rpcArtifact = null,
  endpointArtifact = null,
  // Static, non-default-network base-layer RPC endpoints (e.g. testnet). These
  // are NOT probe-derived: they carry static pool_eligible/score so /rpc/v1/{net}
  // can route immediately, with the proxy's in-isolate breaker + failover handling
  // liveness. Shape matches the mapped `endpoints` below (see test-base-endpoints).
  testnetEndpoints = [],
}) {
  const sourceArtifact = endpointArtifact || rpcArtifact || { endpoints: [] };
  const endpoints = (sourceArtifact.endpoints || []).map((endpoint) => {
    const scoreBreakdown = endpointScoreBreakdown(endpoint);
    const poolEligibility = endpointPoolEligibility(endpoint);
    return {
      ...endpoint,
      score: scoreBreakdown.score,
      score_reasons: endpoint.score_reasons || scoreBreakdown.reasons,
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons:
        endpoint.pool_eligibility_reasons || poolEligibility.reasons,
      unsafe_methods_blocked: true,
    };
  });

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: endpointArtifact
      ? "endpoint-resource-probes"
      : "rpc-endpoint-probes",
    notes: [
      "Endpoint pools are advisory only in v1.",
      "Future proxy/load-balancer routes must block write and unsafe RPC methods by default.",
      "Only Bittensor base-layer RPC/WSS endpoints are pool candidates in v1.",
    ],
    disabled_proxy_contract: {
      enabled: false,
      allowed_methods: [
        "chain_getHeader",
        "chain_getBlockHash",
        "system_health",
        "rpc_methods",
      ],
      denied_method_patterns: [
        "author_",
        "state_call",
        "sudo_",
        "payment_",
        "contracts_",
      ],
      feature_flag: "METAGRAPH_ENABLE_RPC_PROXY",
      rate_limit_required: true,
      waf_required: true,
    },
    eligibility_policy: {
      source: "probe-derived",
      eligible_layers: ["bittensor-base"],
      required_status: "ok",
      requires_public_safe: true,
      requires_no_auth: true,
      user_reports_can_change_health: false,
      notes:
        "Pool eligibility is derived from monitored endpoint state only. Contributor reports can trigger review or re-probes, but cannot set health or uptime.",
    },
    provider_scores: endpointProviderScores(endpoints),
    pools: [
      endpointPool("finney-rpc", "subtensor-rpc", endpoints),
      endpointPool("finney-wss", "subtensor-wss", endpoints),
      endpointPool(
        "finney-archive",
        "archive",
        endpoints.filter((endpoint) => endpoint.archive_support === true),
      ),
      // Testnet base-layer pools (registry/native/test-base-endpoints.json).
      // test-rpc is the proxy target (/rpc/v1/test); test-wss is reference-only
      // (the HTTP proxy can't proxy WSS), parity with finney-wss. Each appended
      // only when that kind is configured, so no empty pools.
      ...(testnetEndpoints.some((endpoint) => endpoint.kind === "subtensor-rpc")
        ? [endpointPool("test-rpc", "subtensor-rpc", testnetEndpoints)]
        : []),
      ...(testnetEndpoints.some((endpoint) => endpoint.kind === "subtensor-wss")
        ? [endpointPool("test-wss", "subtensor-wss", testnetEndpoints)]
        : []),
    ],
  };
}

function endpointPool(id, kind, endpoints) {
  const poolEndpoints = endpoints
    .filter((endpoint) => kind === "archive" || endpoint.kind === kind)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999) ||
        a.id.localeCompare(b.id),
    );
  return {
    id,
    kind,
    endpoint_count: poolEndpoints.length,
    eligible_count: poolEndpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    best_endpoint_id:
      poolEndpoints.find((endpoint) => endpoint.pool_eligible)?.id || null,
    endpoints: poolEndpoints.map((endpoint) => ({
      archive_support: endpoint.archive_support,
      id: endpoint.id,
      surface_id: endpoint.surface_id,
      surface_key: endpoint.surface_key,
      kind: endpoint.kind,
      layer: endpoint.layer || endpointLayer(endpoint.kind),
      health_source: endpoint.health_source || "missing-probe",
      health_stale: endpoint.health_stale ?? endpoint.status !== "ok",
      latency_ms: endpoint.latency_ms,
      latest_block: endpoint.latest_block,
      observed_at: endpoint.observed_at || endpoint.last_checked || null,
      pool_eligible: endpoint.pool_eligible,
      provider: endpoint.provider,
      score: endpoint.score,
      score_reasons: endpoint.score_reasons || [],
      status: endpoint.status,
      url: endpoint.url,
      last_ok: endpoint.last_ok || null,
      pool_eligibility_reasons: endpoint.pool_eligibility_reasons || [],
    })),
  };
}

// Only callable infrastructure (RPC/WSS + the agent-callable surface kinds) can
// have a meaningful "down" incident. Docs / dashboards / websites / repos are
// reference links, not endpoints — a website that returns HTML probes as
// "unsupported" and must NOT be reported as an incident.
const CALLABLE_ENDPOINT_KINDS = new Set([
  "subtensor-rpc",
  "subtensor-wss",
  "subnet-api",
  "openapi",
  "sse",
  "data-artifact",
]);

export function buildEndpointIncidentArtifact({
  endpointArtifact,
  generatedAt,
  contractVersion,
}) {
  const endpoints = endpointArtifact?.endpoints || [];
  const incidents = endpoints
    .filter((endpoint) => CALLABLE_ENDPOINT_KINDS.has(endpoint.kind))
    .filter((endpoint) => endpoint.monitoring_status === "monitored")
    .filter((endpoint) => ["failed", "degraded"].includes(endpoint.status))
    .map((endpoint) => {
      const severity = endpoint.status === "failed" ? "critical" : "warning";
      const reason =
        endpoint.error ||
        endpoint.classification ||
        `${endpoint.status} endpoint probe result`;
      return {
        id: `incident-${endpoint.id}`,
        endpoint_id: endpoint.id,
        surface_id: endpoint.surface_id,
        surface_key: endpoint.surface_key,
        netuid: endpoint.netuid,
        subnet_slug: endpoint.subnet_slug,
        subnet_name: endpoint.subnet_name,
        layer: endpoint.layer,
        kind: endpoint.kind,
        provider: endpoint.provider,
        operator: endpoint.operator,
        status: endpoint.status,
        classification: endpoint.classification,
        observed_at: endpoint.observed_at || endpoint.last_checked || null,
        health_source: endpoint.health_source || "probe-derived",
        health_stale: endpoint.health_stale ?? endpoint.status !== "ok",
        severity,
        state: "active",
        reason,
        detected_at: endpoint.last_checked || generatedAt,
        last_ok: endpoint.last_ok || null,
        last_checked: endpoint.last_checked,
        pool_eligible: false,
        user_reported: false,
        source: "probe-derived",
      };
    })
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.netuid - b.netuid ||
        a.kind.localeCompare(b.kind) ||
        a.endpoint_id.localeCompare(b.endpoint_id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "endpoint-resource-probes",
    notes: [
      "Endpoint incidents are generated from observed probe state only.",
      "Contributor reports can create review or re-probe work, but cannot set uptime, latency, health, or pool eligibility.",
      "Resolved incident history is expected to live in R2/D1 once persistent probe history is enabled.",
    ],
    summary: {
      incident_count: incidents.length,
      active_count: incidents.filter((incident) => incident.state === "active")
        .length,
      by_kind: countRecord(incidents, (incident) => incident.kind),
      by_layer: countRecord(incidents, (incident) => incident.layer),
      by_provider: countRecord(incidents, (incident) => incident.provider),
      by_severity: countRecord(incidents, (incident) => incident.severity),
      by_status: countRecord(incidents, (incident) => incident.status),
    },
    incidents,
  };
}

function endpointLayer(kind) {
  if (isBaseLayerEndpoint(kind) || kind === "archive") {
    return "bittensor-base";
  }
  if (
    ["subnet-api", "openapi", "sse", "dashboard", "sdk", "example"].includes(
      kind,
    )
  ) {
    return "subnet-app";
  }
  if (kind === "data-artifact") {
    return "data-provider";
  }
  return "docs-provider";
}

function endpointHealthMetadata({ health, monitored }) {
  if (!monitored) {
    return {
      observed_at: null,
      health_source: "not-monitored",
      health_stale: false,
      last_checked: null,
      last_ok: null,
    };
  }

  const observedAt = health.verified_at || health.last_checked || null;
  const lastOk = health.last_ok || (health.status === "ok" ? observedAt : null);

  return {
    observed_at: observedAt,
    health_source: observedAt ? "probe-derived" : "missing-probe",
    health_stale: observedAt === null,
    last_checked: observedAt,
    last_ok: lastOk,
  };
}

function isBaseLayerEndpoint(kind) {
  return ["subtensor-rpc", "subtensor-wss"].includes(kind);
}

function endpointMonitoringPolicy(surface) {
  if (!surface.probe) {
    return {
      enabled: false,
      method: null,
      expect: null,
      source: "not-configured",
    };
  }
  return {
    enabled: surface.probe.enabled === true,
    method: surface.probe.method || null,
    expect: surface.probe.expect || null,
    timeout_ms: surface.probe.timeout_ms || null,
    source: "surface-probe-config",
  };
}

function endpointPublicationState({ monitored, poolEligible, surface }) {
  if (surface.public_safe !== true) {
    return "disabled";
  }
  if (poolEligible) {
    return "pool-eligible";
  }
  if (monitored) {
    return "monitored";
  }
  return "verified";
}

function endpointScoreBreakdown(endpoint) {
  let score = 0;
  const reasons = [];
  function add(reason, points) {
    score += points;
    reasons.push({ reason, points });
  }

  if (endpoint.status === "ok") add("status-ok", 50);
  if (endpoint.archive_support === true) add("archive-support", 15);
  if (endpoint.latest_block) add("latest-block-observed", 10);
  const methodSupport = endpoint.methods_supported || endpoint.method_support;
  if (
    methodSupport &&
    typeof methodSupport === "object" &&
    !Array.isArray(methodSupport)
  ) {
    add(
      "method-support",
      Math.min(Object.values(methodSupport).filter(Boolean).length * 5, 20),
    );
  } else if (Array.isArray(methodSupport)) {
    add("method-support", Math.min(methodSupport.length, 20));
  }
  if (Number.isFinite(endpoint.latency_ms))
    add("latency", Math.max(0, 20 - Math.round(endpoint.latency_ms / 100)));
  if (endpoint.auth_required) add("auth-required", -25);
  if (endpoint.status === "degraded") add("status-degraded", -10);
  if (endpoint.status === "failed") add("status-failed", -50);

  return {
    score: Math.max(0, score),
    reasons: reasons.filter((reason) => reason.points !== 0),
  };
}

function endpointPoolEligibility(endpoint) {
  const reasons = [];
  if (!isBaseLayerEndpoint(endpoint.kind)) {
    reasons.push("not-bittensor-base-layer");
  }
  if (endpoint.status !== "ok") {
    reasons.push(`status-${endpoint.status || "unknown"}`);
  }
  if (endpoint.auth_required !== false) {
    reasons.push("auth-required");
  }
  if (endpoint.public_safe !== true) {
    reasons.push("not-public-safe");
  }
  return {
    eligible: reasons.length === 0,
    reasons: reasons.length ? reasons : ["eligible"],
  };
}

function endpointProviderScores(endpoints) {
  const providers = new Map();
  for (const endpoint of endpoints) {
    const provider = endpoint.provider || "unknown";
    const row = providers.get(provider) || {
      provider,
      endpoint_count: 0,
      monitored_count: 0,
      ok_count: 0,
      failed_count: 0,
      degraded_count: 0,
      pool_eligible_count: 0,
      score_total: 0,
    };
    row.endpoint_count += 1;
    if (endpoint.monitoring_status === "monitored") {
      row.monitored_count += 1;
    }
    if (endpoint.status === "ok") row.ok_count += 1;
    if (endpoint.status === "failed") row.failed_count += 1;
    if (endpoint.status === "degraded") row.degraded_count += 1;
    if (endpoint.pool_eligible) row.pool_eligible_count += 1;
    row.score_total += endpoint.score || 0;
    providers.set(provider, row);
  }

  return [...providers.values()]
    .map((row) => {
      const publicRow = { ...row };
      delete publicRow.score_total;
      return {
        ...publicRow,
        average_score: row.endpoint_count
          ? Math.round(row.score_total / row.endpoint_count)
          : 0,
        operational_score:
          row.endpoint_count === 0
            ? 0
            : Math.max(
                0,
                Math.round(
                  (row.ok_count / row.endpoint_count) * 70 +
                    (row.pool_eligible_count / row.endpoint_count) * 20 -
                    (row.failed_count / row.endpoint_count) * 30 -
                    (row.degraded_count / row.endpoint_count) * 10,
                ),
              ),
      };
    })
    .sort(
      (a, b) =>
        b.operational_score - a.operational_score ||
        b.average_score - a.average_score ||
        a.provider.localeCompare(b.provider),
    );
}

function severityRank(severity) {
  return { critical: 3, warning: 2, info: 1 }[severity] || 0;
}

function countRecord(items, keyFn) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        const key = keyFn(item) || "unknown";
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
