import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPlaceholderIdentityUrl,
  readJson,
  repoRoot,
  safeFetch,
  stableStringify,
} from "./lib.ts";

// First-party logo cache (#8288).
//
// Subnet logos came from ~40 third-party origins on every list page. Those URLs
// are NOT ours: they live in `registry/native/*.json`, the machine-captured
// on-chain identity snapshot, so their content is set by whoever registered the
// subnet. build-artifacts.ts's `backfilledIdentityUrl(overlay?.logo_url,
// nativeSubnet.chain_identity?.logo_url)` falls through to that raw value when a
// subnet has no curated overlay logo, and it reaches the served payload verbatim.
//
// This fetches them once at build time, validates hard, and stores them
// content-addressed under the app's own /logos/cache/ tree. The projection then
// serves ONLY the first-party path, so a raw third-party URL never reaches the
// DOM and no visitor's browser is enumerated by 40 unrelated hosts.
//
// Deliberately NOT routed through the icon proxy: that endpoint takes a `host`
// and never an arbitrary URL, which is the SSRF-safety decision that keeps it
// small. Widening it to accept registry-supplied URLs would undo that. Instead
// this reuses `safeFetch`, which re-validates every redirect hop against
// isUnsafeResolvedUrl and pins the resolved address into the connection, closing
// the DNS-rebinding window between check and connect.

const CACHE_DIR_REL = "apps/ui/public/logos/cache";
const MANIFEST_REL = "registry/generated/logo-cache.json";
const FIRST_PARTY_PREFIX = "/logos/cache/";

// Images only, and only formats a browser will render as an <img>. An HTML
// error page served with 200 is the common failure here (a dead CDN path), and
// without this it would be cached as a "logo" and render as a broken icon.
const ALLOWED_CONTENT_TYPES = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
]);

// 512 KiB. Every legitimate logo observed is far under this; the cap exists so a
// hostile or misconfigured origin can't stream an unbounded body into the build.
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface LogoCacheEntry {
  /** The third-party URL exactly as it appears in the identity snapshot. */
  source_url: string;
  /** First-party path the projection should serve instead. */
  cached_path: string;
  sha256: string;
  content_type: string;
  size_bytes: number;
}

export type LogoCacheManifest = {
  generated_at: string;
  entries: LogoCacheEntry[];
};

export type SkipReason =
  | "placeholder"
  | "already-first-party"
  | "unsafe-url"
  | "fetch-failed"
  | "bad-content-type"
  | "too-large"
  | "empty";

/**
 * Whether a URL is worth attempting at all. Pure, so the policy is testable
 * without network.
 *
 * `already-first-party` matters as much as the safety checks: re-fetching our
 * own `/logos/*` through this pipeline would content-address a file we already
 * ship, doubling the bytes for nothing.
 */
export function classifyLogoUrl(
  value: unknown,
): { attempt: true; url: string } | { attempt: false; reason: SkipReason } {
  if (typeof value !== "string" || !value.trim()) {
    return { attempt: false, reason: "empty" };
  }
  const raw = value.trim();
  if (isPlaceholderIdentityUrl(raw)) {
    return { attempt: false, reason: "placeholder" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { attempt: false, reason: "unsafe-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { attempt: false, reason: "unsafe-url" };
  }
  if (parsed.hostname === "metagraph.sh") {
    return { attempt: false, reason: "already-first-party" };
  }
  return { attempt: true, url: raw };
}

/**
 * Validate a fetched body. Split from the fetch so the content-type allowlist
 * and the size cap are directly testable — these are the two guards that stop a
 * 200-with-HTML error page or an unbounded stream becoming a "logo".
 */
export function validateLogoBody(
  contentType: string | null,
  bytes: Uint8Array,
):
  | { ok: true; ext: string; contentType: string }
  | { ok: false; reason: SkipReason } {
  const normalized = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED_CONTENT_TYPES.get(normalized);
  if (!ext) return { ok: false, reason: "bad-content-type" };
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > MAX_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, ext, contentType: normalized };
}

/** Every distinct identity logo_url in the native chain snapshots. */
export function collectIdentityLogoUrls(nativeSnapshots: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "logo_url" && typeof value === "string") out.add(value);
      else walk(value);
    }
  };
  for (const snapshot of nativeSnapshots) walk(snapshot);
  return [...out];
}

async function cacheOne(
  url: string,
): Promise<
  | { ok: true; entry: Omit<LogoCacheEntry, "source_url">; bytes: Uint8Array }
  | { ok: false; reason: SkipReason }
> {
  const result = await safeFetch(url, {
    accept: "image/*",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!result.ok || !result.response) {
    // Covers unsafe hops, non-2xx (taofi's documented 402), and timeouts alike:
    // a logo we cannot fetch is simply absent, never a retry loop at page load.
    return { ok: false, reason: result.unsafe ? "unsafe-url" : "fetch-failed" };
  }
  const contentType = result.response.headers.get("content-type");
  const buffer = new Uint8Array(await result.response.arrayBuffer());
  const validated = validateLogoBody(contentType, buffer);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return {
    ok: true,
    bytes: buffer,
    entry: {
      cached_path: `${FIRST_PARTY_PREFIX}${sha256}.${validated.ext}`,
      sha256,
      content_type: validated.contentType,
      size_bytes: buffer.byteLength,
    },
  };
}

/**
 * Decides whether to keep a previous run's entry when the fetch just failed.
 * Pure: takes the prior entry (if any) and a file-exists probe, so the sticky
 * behavior -- a build-time blip must not silently demote a logo to a monogram
 * -- is directly testable. `safeFetch`'s own SSRF check rejects any localhost
 * target, so a real mock-server integration test (the r2-upload.test.ts
 * pattern) is not possible for the network half; this is what IS testable.
 */
export function retainPreviousEntry(
  prior: LogoCacheEntry | undefined,
  fileExists: (cachedPath: string) => boolean,
): LogoCacheEntry | null {
  if (!prior) return null;
  return fileExists(prior.cached_path) ? prior : null;
}

/** Prior manifest entries, keyed by source_url. Empty when absent. */
function loadPreviousEntries(): Map<string, LogoCacheEntry> {
  try {
    const raw = readFileSync(path.join(repoRoot, MANIFEST_REL), "utf8");
    const manifest = JSON.parse(raw) as LogoCacheManifest;
    return new Map((manifest.entries ?? []).map((e) => [e.source_url, e]));
  } catch {
    return new Map();
  }
}

// #8288: shared by build-artifacts.ts's mergeSubnet AND validate.ts's
// buildExpectedGeneratedSubnet, so both compute the SAME projected value from
// the same raw chain_identity.logo_url -- the reproducibility validator
// compares one against the other, so a resolver that existed in only one place
// would fail that check by construction, not by an actual bug.
//
// `nativeSubnet.chain_identity.logo_url` is on-chain identity — whoever
// registered the subnet chose that URL — and it used to flow verbatim into the
// served payload, so every list page reached ~40 third-party origins. Maps it
// to the build-time cached copy and returns null when there is no cached copy,
// so a raw upstream URL can NEVER reach the DOM; null degrades to BrandIcon's
// documented monogram fallback.
//
// Absolute, not the manifest's relative path: backfilledIdentityUrl normalizes
// through normalizePublicUrl, which requires a real http(s) URL.
const FIRST_PARTY_LOGO_ORIGIN = "https://metagraph.sh";
let logoCacheMap: Map<string, string> | null = null;

export function firstPartyLogoUrl(chainLogoUrl: unknown): string | null {
  if (typeof chainLogoUrl !== "string" || !chainLogoUrl) return null;
  const map = (logoCacheMap ??= loadLogoCacheMapSync());
  const cached = map.get(chainLogoUrl);
  return cached ? `${FIRST_PARTY_LOGO_ORIGIN}${cached}` : null;
}

export async function main(): Promise<number> {
  const nativeDir = path.join(repoRoot, "registry/native");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(nativeDir)).filter((f) => f.endsWith(".json"));
  const snapshots = await Promise.all(
    files.map((f) => readJson(path.join(nativeDir, f))),
  );

  const urls = collectIdentityLogoUrls(snapshots);
  const skips = new Map<SkipReason, number>();
  const bump = (r: SkipReason) => skips.set(r, (skips.get(r) ?? 0) + 1);

  const entries: LogoCacheEntry[] = [];
  const cacheDir = path.join(repoRoot, CACHE_DIR_REL);
  await mkdir(cacheDir, { recursive: true });

  // Previously-cached entries are STICKY. Without this, one transient network
  // blip at build time silently demotes a subnet's logo to a monogram until
  // some later build happens to succeed -- a flaky build should never mutate
  // published output. A prior entry is reused whenever its content-addressed
  // file is still on disk; the fetch is still attempted first, so a genuinely
  // changed upstream is picked up and lands at a new hash.
  const previous = loadPreviousEntries();
  let retained = 0;

  for (const url of urls) {
    const classified = classifyLogoUrl(url);
    if (!classified.attempt) {
      bump(classified.reason);
      continue;
    }
    const cached = await cacheOne(classified.url);
    if (!cached.ok) {
      const retain = retainPreviousEntry(previous.get(classified.url), (p) =>
        existsSync(path.join(cacheDir, path.basename(p))),
      );
      if (retain) {
        entries.push(retain);
        retained += 1;
        continue;
      }
      bump(cached.reason);
      continue;
    }
    const file = path.join(cacheDir, path.basename(cached.entry.cached_path));
    // Content-addressed: identical bytes from two subnets write the same file
    // once, and a changed upstream lands at a new path instead of mutating one
    // browsers may have cached immutably.
    await writeFile(file, cached.bytes);
    entries.push({ source_url: classified.url, ...cached.entry });
  }

  entries.sort((a, b) => a.source_url.localeCompare(b.source_url));
  const manifest: LogoCacheManifest = {
    // Deterministic: the epoch marker, matching every other built artifact
    // (#349) so the file's bytes change only when the cache contents do.
    generated_at: "1970-01-01T00:00:00.000Z",
    entries,
  };
  await mkdir(path.dirname(path.join(repoRoot, MANIFEST_REL)), {
    recursive: true,
  });
  await writeFile(
    path.join(repoRoot, MANIFEST_REL),
    `${stableStringify(manifest)}\n`,
  );

  const skipSummary = [...skips]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`)
    .join(" ");
  console.log(
    `logo cache: ${entries.length} cached of ${urls.length} identity URLs ` +
      `(${retained} retained from a previous run)  [${skipSummary}]`,
  );
  return 0;
}

/**
 * Loads the manifest as a `source_url -> cached_path` map for the build.
 *
 * Sync on purpose: the only consumer is build-artifacts.ts's `mergeSubnet`,
 * which is synchronous and runs once per subnet, so a lazily-read module-level
 * map avoids threading a promise through the whole projection.
 *
 * An absent manifest is NOT a build failure — the projection then has no
 * first-party replacement and simply drops the third-party URL, which is the
 * intended degradation (cached logo -> monogram), never a raw upstream URL.
 */
export function loadLogoCacheMapSync(): Map<string, string> {
  try {
    const raw = readFileSync(path.join(repoRoot, MANIFEST_REL), "utf8");
    const manifest = JSON.parse(raw) as LogoCacheManifest;
    return new Map(
      (manifest.entries ?? []).map((e) => [e.source_url, e.cached_path]),
    );
  } catch {
    return new Map();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
