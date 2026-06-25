import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { Agent } from "undici";
import {
  ARTIFACT_STORAGE_TIERS,
  R2_STAGING_RELATIVE_ROOT,
  artifactRelativePath,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";
import { sanitizeChainText } from "./lib/formatting.mjs";

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
unsafeIpBlocks.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local (RFC 3879)
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

  // Drop trailing commas (",}" / ",]") outside string literals only. A blanket
  // regex over the whole output spliced commas out of string contents too, so a
  // value like "a, }" lost its comma. Re-walk string-aware; for a removed comma
  // the look-ahead (j) also skips the whitespace up to the closing bracket, so
  // ",\n }" collapses to "}" exactly as the old regex did.
  let result = "";
  inString = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += out[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) {
        j += 1;
      }
      if (out[j] === "}" || out[j] === "]") {
        i = j - 1;
        continue;
      }
    }
    result += ch;
  }
  return result;
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
  // All providers are flat objects in registry/providers/*.json. Trust is the
  // per-file `authority` field (official / provider-claimed / community /
  // registry-observed), NOT the directory — the old registry/providers/community/
  // wrapper lane was flattened (#1678). The `.provider || document` unwrap is kept
  // defensively for any legacy { provider } shape; dedup by id (ids don't collide).
  const files = await listJsonFiles(path.join(repoRoot, "registry/providers"));
  const providers = (await Promise.all(files.map(readJson))).map(
    (document) => document.provider || document,
  );
  const byId = new Map();
  for (const provider of providers) {
    if (provider?.id) byId.set(provider.id, provider);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

export async function loadCandidates(options = {}) {
  const excludeFiles = new Set(
    (options.excludeFiles || []).map((file) => path.resolve(file)),
  );
  const files = (
    await listJsonFilesRecursive(path.join(repoRoot, "registry/candidates"))
  ).filter((file) => !excludeFiles.has(path.resolve(file)));
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

// #1757: the resolved per-surface `curation_level` (the CurationLevel trust
// tier), derived once at the source from the surface's provider `authority`
// (the Authority enum) and its verification state, so consumers stop conflating
// the two distinct enums with `s.curation_level ?? s.authority`. The subnet's
// curation level is the trust ceiling: an official, freshly-verified surface
// inherits the subnet's maintainer-reviewed / adapter-backed tier; otherwise the
// level falls out of authority + freshness, with `native` as the floor.
//   adapter-backed      — subnet is adapter-backed and the surface is official
//   maintainer-reviewed — subnet is maintainer-reviewed and the surface is
//                         official and not stale (a human vetted this surface)
//   machine-verified    — verified (has a last_verified_at) and not stale
//   candidate-discovered — auto-discovered / unverified (registry-observed,
//                         community, provider-claimed, or no verification yet)
//   native              — defensive floor (no authority at all)
export function resolveSurfaceCurationLevel({
  authority,
  lastVerifiedAt,
  stale,
  subnetCurationLevel,
}) {
  const official = authority === "official";
  const verifiedFresh = Boolean(lastVerifiedAt) && stale !== true;
  if (subnetCurationLevel === "adapter-backed" && official) {
    return "adapter-backed";
  }
  if (
    subnetCurationLevel === "maintainer-reviewed" &&
    official &&
    verifiedFresh
  ) {
    return "maintainer-reviewed";
  }
  if (verifiedFresh) {
    return "machine-verified";
  }
  if (authority) {
    return "candidate-discovered";
  }
  return "native";
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
        // #1757: the resolved trust tier for this surface. `stale` is stamped
        // later (withSurfaceFreshness, which carries the nowMs reference), so a
        // surface fresh at flatten time may still resolve down a tier once the
        // freshness pass runs — withSurfaceFreshness re-resolves it there.
        flattened.curation_level = resolveSurfaceCurationLevel({
          authority: surface.authority ?? null,
          lastVerifiedAt: flattened.last_verified_at,
          stale: false,
          subnetCurationLevel: subnet.curation?.level ?? null,
        });
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
  return surfaces.map((surface) => {
    const stale = isSurfaceStale(surface.last_verified_at, surface.kind, nowMs);
    return {
      ...surface,
      stale,
      // #1757: re-resolve the trust tier now that staleness is known — a stale
      // verification demotes machine-verified/maintainer-reviewed down to
      // candidate-discovered, the same demotion the freshness model applies
      // elsewhere. subnet_curation_level isn't carried on the flattened row, so
      // an already-resolved maintainer-reviewed/adapter-backed level (set in
      // flattenSurfaces from the subnet ceiling) is preserved when still fresh.
      curation_level: stale
        ? resolveSurfaceCurationLevel({
            authority: surface.authority ?? null,
            lastVerifiedAt: surface.last_verified_at,
            stale: true,
            subnetCurationLevel: null,
          })
        : (surface.curation_level ??
          resolveSurfaceCurationLevel({
            authority: surface.authority ?? null,
            lastVerifiedAt: surface.last_verified_at,
            stale: false,
            subnetCurationLevel: null,
          })),
    };
  });
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
    if (url.username || url.password) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    return isUnsafeHostname(host);
  } catch {
    return true;
  }
}

export async function resolvePublicUrlAddresses(value, resolver = lookup) {
  try {
    const url = new URL(value);
    if (isUnsafeUrl(url.toString())) {
      return [];
    }

    const host = normalizeHostname(url.hostname);
    if (isIP(host)) {
      return [{ address: host, family: isIP(host) }];
    }

    const records = await resolver(host, { all: true, verbatim: true });
    if (
      records.length === 0 ||
      records.some((record) => isUnsafeIpAddress(record.address))
    ) {
      return [];
    }
    return records.map((record) => ({
      address: record.address,
      family: record.family,
    }));
  } catch {
    return [];
  }
}

export async function isUnsafeResolvedUrl(value, resolver = lookup) {
  return (await resolvePublicUrlAddresses(value, resolver)).length === 0;
}

const SAFE_FETCH_REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// The connect-time DNS lookup that pins the single validated answer: every
// connection for this hop resolves `hostname` to the exact `address` that
// resolvePublicUrlAddresses already vetted, and rejects a lookup for any other
// host — closing the TOCTOU DNS-rebinding window between the safety check and the
// actual socket. Returns a Node `dns.lookup`-shaped callback (single-answer and
// `{ all: true }` array forms). Exported so its branches are unit-covered.
export function createPinnedLookup(hostname, address, family) {
  return (requestedHostname, options, callback) => {
    if (normalizeHostname(requestedHostname) !== hostname) {
      callback(new Error("safeFetch attempted to resolve an unpinned host"));
      return;
    }
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function createPinnedAddressDispatcher(hostname, address, family) {
  return new Agent({
    connect: { lookup: createPinnedLookup(hostname, address, family) },
  });
}

// SSRF-safe outbound GET: re-validates EVERY hop — the initial URL AND each
// redirect Location — against isUnsafeResolvedUrl before connecting, so a public
// host can't 30x-redirect into a private/internal address (169.254.169.254,
// localhost, …). Each validated DNS answer is also pinned into undici's
// connection lookup for that hop, closing the DNS-rebinding gap between the
// safety check and the actual fetch. `redirect: "follow"` would bypass the
// guard; this follows manually, bounded by maxRedirects. Returns exactly one of:
//   { ok: true,  response, status, url }  final non-redirect 2xx response
//   { ok: false, response, status, url }  final non-redirect non-2xx response
//   { ok: false, unsafe: true, url }      a hop resolved to a private/unsafe addr
//   { ok: false, error }                  network error / timeout / too many redirects
// The caller owns response.body (read or cancel it).
export async function safeFetch(
  url,
  {
    accept = "*/*",
    maxRedirects = 5,
    timeoutMs = 12000,
    resolver = lookup,
  } = {},
) {
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const addresses = await resolvePublicUrlAddresses(target, resolver);
    if (addresses.length === 0) {
      return { ok: false, unsafe: true, url: target };
    }
    const targetUrl = new URL(target);
    const host = normalizeHostname(targetUrl.hostname);
    const dispatcher = createPinnedAddressDispatcher(
      host,
      addresses[0].address,
      addresses[0].family,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
        headers: { "user-agent": "metagraphed/0.0", accept },
      });
    } catch (error) {
      return {
        ok: false,
        error: error.name === "AbortError" ? "timeout" : error.message,
      };
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    if (SAFE_FETCH_REDIRECT_CODES.has(response.status) && location) {
      await response.body?.cancel();
      try {
        target = new URL(location, target).toString();
      } catch {
        return { ok: false, error: "invalid redirect location" };
      }
      continue;
    }
    return { ok: response.ok, response, status: response.status, url: target };
  }
  return { ok: false, error: "too many redirects" };
}

function isUnsafeHostname(host) {
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  ) {
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
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // A trailing dot is the FQDN-canonical form of the same hostname, so strip it
  // before the self-domain exemption — otherwise "metagraph.sh." (and real
  // subdomains like "api.metagraph.sh.") fail the `=== SELF_DOMAIN` / `.endsWith`
  // check and get wrongly flagged as impersonating our own domain.
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (host === SELF_DOMAIN || host.endsWith(`.${SELF_DOMAIN}`)) {
    return false;
  }

  const userinfo = `${url.username}:${url.password}`.toLowerCase();
  return (
    /metagraph\.sh(?:[.-]|$)|metagraph-?sh(?:[.-]|$)|metagraphsh/.test(host) ||
    /metagraph\.sh|metagraph-?sh|metagraphsh/.test(userinfo)
  );
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
  /(?:^|[_-])(?:token|secret|api[_-]?key|apikey|password|passwd|pwd|authorization|auth|cookie|session|credential|private[_-]?key|mnemonic|seed[_-]?phrase|bearer|access[_-]?key|refresh[_-]?token|csrf[_-]?token|jwt)(?:[_-]|$)|(?:access|refresh|csrf|session|cookie|password|private|seed|id|auth|client|secret)(?:Token|Key|Id|Secret|Value|Hash|Phrase)\b|(?:apiKey|passwordHash|cookieValue|sessionId|csrfToken|accessToken|refreshToken|authToken|idToken|clientSecret|secretKey|privateKey|seedPhrase|jwt)\b/i;

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
export function fixtureCaptureFailureReason(error) {
  const name = error?.name || null;
  if (name === "SyntaxError") {
    return "invalid json response";
  }
  if (name === "AbortError") {
    return "request timed out";
  }
  if (name === "FixtureCaptureLimitError") {
    return "response exceeds byte limit";
  }
  if (name === "TypeError") {
    return "request failed";
  }
  return "capture failed";
}

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
// an explicit curated overlay value wins (including null suppression); otherwise
// fall back to the cleaned on-chain value; otherwise null. Shared by
// build-artifacts (mergeSubnet) and validate (buildExpectedGeneratedSubnet) so
// the chain backfill can't drift between the generator and the reproducibility
// validator.
export function backfilledIdentityUrl(overlayValue, chainValue) {
  if (overlayValue !== undefined) {
    return overlayValue || null;
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
const EMAIL_ATOM = "[A-Z0-9!#$%&\\'*+/=?^_`{|}~-]+";
const EMAIL_RE = new RegExp(
  `^${EMAIL_ATOM}(?:\\.${EMAIL_ATOM})*@` +
    "(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\\.)+[A-Z]{2,63}$",
  "i",
);
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

/**
 * Returns the committed manifest's `generated_at` when running a local build
 * (no publish env vars set), so `npm run build` never clobbers the live
 * timestamp with the 1970 epoch placeholder. Returns null during publish runs
 * (METAGRAPH_BUILD_TIMESTAMP or METAGRAPH_RUN_ID set) or when no manifest
 * exists yet — callers fall back to generatedAt in those cases.
 */
export async function readCommittedManifestGeneratedAt(manifestPath) {
  if (process.env.METAGRAPH_BUILD_TIMESTAMP || process.env.METAGRAPH_RUN_ID) {
    return null;
  }
  const manifest = await readJson(manifestPath).catch(() => null);
  return manifest?.generated_at ?? null;
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
  const seenTargets = new Map();
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
    const existingSourceNetuid = seenTargets.get(targetNetuid);
    if (
      Number.isInteger(existingSourceNetuid) &&
      existingSourceNetuid !== sourceNetuid
    ) {
      // A testnet subnet can only graduate to one mainnet subnet in the public
      // lineage artifact. Surface conflicting curated approvals instead of
      // publishing ambiguous many-to-one lineage.
      brokenLinks.push({
        source_netuid: sourceNetuid,
        target_netuid: targetNetuid,
        reason: "target-netuid-conflict",
        conflicts_with_source_netuid: existingSourceNetuid,
      });
      continue;
    }
    seen.add(key);
    seenTargets.set(targetNetuid, sourceNetuid);
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

// Hostname-only registrable unit for dedupe / same-site checks (#1636, #1910).
// Mirrors clusterDomainFromUrl but accepts bare hostnames and always returns a
// string (falls back to the last-two-label heuristic for bare suffix hosts).
export function registrableHostDomain(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
  if (!host) return "";
  const labels = host.split(".").filter(Boolean);
  return (
    clusterDomainFromUrl(`https://${host}/`) ??
    (labels.length >= 2 ? labels.slice(-2).join(".") : host)
  );
}

// Same-site check for candidate discovery (#1910): exact hostname match or the
// same registrable host (honors multi-label public suffixes via registrableHostDomain).
export function isLikelyProjectDomain(baseUrl, candidateUrl) {
  try {
    const base = new URL(baseUrl);
    const candidate = new URL(candidateUrl);
    return (
      candidate.hostname === base.hostname ||
      registrableHostDomain(candidate.hostname) ===
        registrableHostDomain(base.hostname)
    );
  } catch {
    return false;
  }
}

// #1004 — derive the conventional `api.` and `docs.` subdomain origins for a
// project's registrable domain so the OpenAPI spec sweep reaches APIs that live
// on api.<domain> (or docs.<domain>) rather than the marketing root — the
// Graphite/Vidaio/Hippius class the website-only probe was blind to. Returns []
// when a service subdomain is meaningless: unparseable input, IP literals,
// multi-tenant platform tenants (api.foo.github.io would belong to the platform,
// not the project), or hosts with no resolvable registrable domain. Pure +
// deterministic, so it is exhaustively unit-tested. Callers still apply their own
// generic-host / safe-fetch policy to the returned origins.
export function apiDocsSubdomainOrigins(origin) {
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return [];
  }
  // IPv4 / IPv6 literals have no subdomain structure.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return [];
  }
  const bare = host.replace(/^www\./, "");
  if (bare.split(".").filter(Boolean).length < 2) {
    return [];
  }
  // Multi-tenant platform tenant (foo.github.io, bar.vercel.app): a service
  // subdomain of the registrable domain would belong to the platform, never the
  // project, so don't derive one.
  for (const suffix of MULTI_TENANT_HOST_SUFFIXES) {
    if (bare === suffix || bare.endsWith(`.${suffix}`)) {
      return [];
    }
  }
  const registrable = clusterSuffixDomain(bare);
  if (!registrable) {
    return [];
  }
  return [`https://api.${registrable}`, `https://docs.${registrable}`];
}

// Provenance auto-elevation (Move A): a callable-API surface (openapi/subnet-api)
// that is (1) live-verified and (2) hosted on the subnet's OWN on-chain-asserted
// registrable domain (Subtensor SubnetIdentitiesV3 subnet_url) is trustworthy
// WITHOUT a human review — the chain itself vouches for the domain and we probed
// the API live. This computes that set so promote-reviewed can lift those subnets
// to the maintainer-reviewed trust tier automatically, and validate can treat the
// machine decision as backing for the tier. Pure + deterministic (sorted, deduped)
// so it is unit-testable and the committed auto-reviewed.json can be drift-checked.
//
// Provenance bar (kept strict so a blind common-path guess never auto-trusts):
//   - openapi  : source must be a probe-confirmed spec ("openapi-probe") or a
//                human intake ("community-pr-intake") — never a blind path guess.
//   - subnet-api: any source EXCEPT the blind "project-website-common-path" sweep.
// Both require: kind on the chain-asserted domain + verification live/redirected +
// the verify step judged the response content-type to match the kind.
const AUTO_ELEVATE_OPENAPI_SOURCES = new Set([
  "openapi-probe",
  "community-pr-intake",
]);
export function computeProvenanceElevations({
  candidates = [],
  nativeSubnets = [],
  verificationResults = [],
}) {
  const authByNetuid = new Map();
  for (const subnet of nativeSubnets) {
    const url = subnet?.chain_identity?.subnet_url;
    const domain = url ? clusterDomainFromUrl(url) : null;
    if (domain) authByNetuid.set(subnet.netuid, domain);
  }
  const verByCandidate = new Map(
    verificationResults
      .filter((result) => result?.candidate_id)
      .map((result) => [result.candidate_id, result]),
  );
  const byNetuid = new Map();
  for (const candidate of candidates) {
    if (candidate.kind !== "openapi" && candidate.kind !== "subnet-api") {
      continue;
    }
    const auth = authByNetuid.get(candidate.netuid);
    if (!auth || clusterDomainFromUrl(candidate.url) !== auth) {
      continue;
    }
    if (
      candidate.kind === "openapi"
        ? !AUTO_ELEVATE_OPENAPI_SOURCES.has(candidate.source_type)
        : candidate.source_type === "project-website-common-path"
    ) {
      continue;
    }
    const verification = verByCandidate.get(candidate.id);
    if (
      !verification ||
      (verification.classification !== "live" &&
        verification.classification !== "redirected") ||
      verification.quality_signals?.content_type_matches_kind !== true
    ) {
      continue;
    }
    if (!byNetuid.has(candidate.netuid)) {
      byNetuid.set(candidate.netuid, {
        netuid: candidate.netuid,
        slug: candidate.slug ?? null,
        domain: auth,
        source_urls: new Set(),
        kinds: new Set(),
      });
    }
    const entry = byNetuid.get(candidate.netuid);
    entry.source_urls.add(candidate.url);
    entry.kinds.add(candidate.kind);
    if (!entry.slug && candidate.slug) entry.slug = candidate.slug;
  }
  return [...byNetuid.values()]
    .map((entry) => ({
      netuid: entry.netuid,
      slug: entry.slug,
      domain: entry.domain,
      kinds: [...entry.kinds].sort(),
      source_urls: [...entry.source_urls].sort(),
    }))
    .sort((a, b) => a.netuid - b.netuid);
}

// Build the provenance review queue document from the elevation set: the subnets
// a maintainer should elevate next, i.e. provenance-strong live APIs whose subnet
// is NOT already at the top trust tier (maintainer-reviewed / adapter-backed).
// Deterministic (generated_at is the fixed build placeholder) so the committed
// queue is drift-checked by validate.mjs. Pure — takes the already-loaded inputs.
const TOP_TRUST_LEVELS = new Set(["maintainer-reviewed", "adapter-backed"]);
export function buildProvenanceReviewQueue({
  candidates = [],
  nativeSubnets = [],
  verificationResults = [],
  subnets = [],
}) {
  const levelByNetuid = new Map(
    subnets.map((subnet) => [subnet.netuid, subnet.curation?.level ?? null]),
  );
  const slugByNetuid = new Map(
    subnets.map((subnet) => [subnet.netuid, subnet.slug]),
  );
  const elevations = computeProvenanceElevations({
    candidates,
    nativeSubnets,
    verificationResults,
  });
  const queue = elevations
    .filter((entry) => !TOP_TRUST_LEVELS.has(levelByNetuid.get(entry.netuid)))
    .map((entry) => ({
      netuid: entry.netuid,
      slug:
        slugByNetuid.get(entry.netuid) ?? entry.slug ?? `sn-${entry.netuid}`,
      current_level: levelByNetuid.get(entry.netuid) ?? null,
      kinds: entry.kinds,
      domain: entry.domain,
      source_urls: entry.source_urls,
      rationale:
        `Live ${entry.kinds.join(" + ")} on the subnet's on-chain-asserted ` +
        `domain (${entry.domain}). Strong provenance — elevate by adding a ` +
        `decision to maintainer-reviewed.json after a quick confirm.`,
    }));
  return {
    schema_version: 1,
    generated_by: "metagraphed-review-queue",
    generated_at: buildTimestamp(),
    notes:
      "Suggested maintainer-review elevations: provenance-strong, live callable " +
      "APIs on each subnet's own on-chain-asserted domain that are not yet at the " +
      "top trust tier. Machine-proposed; promote by moving an entry into " +
      "maintainer-reviewed.json. Regenerate with `npm run review:queue`.",
    queue,
  };
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

// Chain-text formatting and sanitization helpers were extracted to
// scripts/lib/formatting.mjs (#510 maintainability decomposition). Re-exported
// here verbatim so every existing importer of scripts/lib.mjs keeps its import
// path unchanged — pure code-motion with byte-identical artifact output.
export {
  slugify,
  formatLlmMarkdownText,
  classifyNativeName,
  nativeNameQuality,
  nativeDisplayName,
  sanitizeChainText,
  stripUrls,
  cleanDescription,
  deriveDescriptionFromNotes,
} from "./lib/formatting.mjs";

// README link selection + classification was extracted to scripts/lib/readme-links.mjs
// (#510 maintainability decomposition). Re-exported here verbatim so every existing
// importer of scripts/lib.mjs keeps its import path unchanged — pure code-motion
// with byte-identical artifact output.
export {
  README_LINK_LIMIT,
  README_KIND_LIMITS,
  isLikelyExampleLink,
  selectReviewableReadmeLinks,
  isReviewableReadmeLink,
} from "./lib/readme-links.mjs";

// Economics + endpoint artifact derivation were extracted to dedicated modules
// under scripts/lib/ (#510 maintainability decomposition). They are re-exported
// here verbatim so every existing importer of scripts/lib.mjs keeps its import
// path unchanged — this is pure code-motion with byte-identical artifact output.
export {
  computeMinerReadiness,
  buildEconomicsArtifact,
} from "./lib/economics-artifacts.mjs";
export {
  buildRpcEndpointArtifact,
  buildEndpointResourceArtifact,
  buildEndpointPoolArtifact,
  buildEndpointIncidentArtifact,
} from "./lib/endpoint-artifacts.mjs";
