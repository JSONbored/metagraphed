// Runtime upgrade radar (#8702) — where the next runtime is, right now.
//
// Subtensor runtime upgrades reach mainnet with zero on-chain warning: they are
// sudo-applied, and the Scheduler pallet's queue is empty (#8697), so there is
// no `scheduled` event to read and nothing on-chain to poll. The lifecycle that
// IS observable is entirely off-chain and short:
//
//   GitHub release (RaoFoundation/subtensor, every 2-3 days)
//     -> testnet deploy   (test.finney.opentensor.ai)
//       -> mainnet deploy (entrypoint-finney.opentensor.ai)
//
// This module is the pure derivation over those three readings. The Worker owns
// the RPC calls, the KV cache, and the GitHub fetch; everything here is total
// and side-effect free.
//
// THE RULE THAT SHAPES THE WHOLE MODULE: never state more than the readings
// prove. A missing reading is `unknown`, never `none` — "no upgrade pending" and
// "we could not tell" are opposite answers to the only question this route
// exists to answer, and collapsing them would make a testnet RPC outage look
// like calm. Positive evidence still wins over a null elsewhere (see
// derivePendingUpgrade), so one dead upstream degrades the answer rather than
// erasing it.
//
// And no ETAs. The deploy gap is empirically days-scale, but the foundation
// publishes no schedule, so a predicted date would be our guess wearing the
// costume of a fact. The radar reports observed states only.

/**
 * The upgrade lifecycle state, derived from the three spec-version readings.
 *
 * `unknown` is a first-class state, not an error: it is what an incomplete set
 * of readings honestly supports.
 */
export type PendingUpgradeState =
  "none" | "testnet_soaking" | "released_undeployed" | "unknown";

/**
 * Extract a runtime spec version from a release tag.
 *
 * Parsed from the REAL tag corpus (captured 2026-07-29 via
 * `gh api repos/opentensor/subtensor/releases?per_page=100`), which has three
 * eras and is not the single format the issue's example implies:
 *
 *   current  v440              -> 440   (bare spec)
 *   middle   v3.4.9-424        -> 424   (semver + "-" + spec)
 *            3.2.14-345        -> 345   (same, no leading "v" — one real tag)
 *   oldest   v3.2.7            -> null  (spec not encoded at all)
 *
 * The middle era is the trap: the first digits of `v3.4.9-424` are `3`, so any
 * "grab the number" parser silently reports spec 3 for two years of releases.
 * The oldest era is why this returns null instead of throwing — those tags are
 * legitimately unparseable, and dropping them is correct, since every one of
 * them is far below any live chain's spec version anyway.
 */
export function specVersionFromTag(tag: unknown): number | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim().replace(/^v/i, "");
  // Bare spec: "440".
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare) return Number(bare[1]);
  // Semver with a spec suffix: "3.4.9-424". Anchored on the full string so a
  // tag like "3.4.9-rc1-424" (never seen, but cheap to exclude) doesn't parse.
  const suffixed = /^\d+\.\d+\.\d+-(\d+)$/.exec(trimmed);
  if (suffixed) return Number(suffixed[1]);
  return null;
}

/** A GitHub release reduced to the fields the radar reports. */
export interface ReleaseRecord {
  tag: string;
  spec_version: number;
  /** ISO timestamp, or null when GitHub omitted it. */
  published_at: string | null;
  /** GitHub's own html_url — never constructed (see selectLatestRelease). */
  url: string | null;
  name: string | null;
  prerelease: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Pick the highest-spec release from a GitHub releases listing.
 *
 * WHY NOT `GET /releases/latest`: GitHub's "latest" excludes prereleases, and
 * every proposed runtime ships as `prerelease: true`. Captured 2026-07-29, with
 * both chains live on 440: /releases/latest returned **v438**. Using it would
 * make `released_undeployed` unreachable in production — that state arises only
 * from a release ahead of both chains, which is exactly the proposed-runtime
 * case the endpoint filters out. So: enumerate, drop drafts, take the max.
 *
 * Drafts are excluded because they are unpublished and not visible to anyone
 * but the repo's maintainers; prereleases are kept for the reason above.
 *
 * Max-by-spec rather than by publish date, and rather than "first in the list":
 * two tags can carry the same spec (`v3.3.7-374` and `v3.3.8-374` both exist),
 * and a patch release for an older runtime can be published after a newer one.
 * Ties resolve to the first seen, which is GitHub's own newest-first order.
 *
 * `url` comes from the payload's `html_url` and is never built from the repo
 * name: `opentensor/subtensor` now redirects to `RaoFoundation/subtensor`, so a
 * constructed URL would encode a name that no longer owns the releases.
 */
export function selectLatestRelease(
  releases: readonly unknown[] | null | undefined,
): ReleaseRecord | null {
  if (!Array.isArray(releases)) return null;
  let best: ReleaseRecord | null = null;
  for (const entry of releases) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true) continue;
    const tag = asString(record.tag_name);
    if (!tag) continue;
    const specVersion = specVersionFromTag(tag);
    if (specVersion == null) continue;
    if (best && specVersion <= best.spec_version) continue;
    best = {
      tag,
      spec_version: specVersion,
      published_at: asString(record.published_at),
      url: asString(record.html_url),
      name: asString(record.name),
      prerelease: record.prerelease === true,
    };
  }
  return best;
}

/**
 * Read `specVersion` out of a `state_getRuntimeVersion` response.
 *
 * Accepts either the full JSON-RPC envelope or a bare result object, since the
 * Worker's RPC helper unwraps `result` and a recorded fixture does not. Returns
 * null for anything else — an RPC error body, a timeout's `null`, or an HTML
 * error page parsed into an object all land here, and all of them mean the same
 * thing to the caller: no reading.
 */
export function specVersionFromRuntimeVersion(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  const result =
    envelope.result && typeof envelope.result === "object"
      ? (envelope.result as Record<string, unknown>)
      : envelope;
  const spec = result.specVersion;
  return Number.isInteger(spec) && (spec as number) >= 0
    ? (spec as number)
    : null;
}

/** The three readings the state is derived from. Any may be null. */
export interface UpgradeReadings {
  mainnetSpec: number | null;
  testnetSpec: number | null;
  releaseSpec: number | null;
}

/**
 * Derive the lifecycle state from the three readings.
 *
 * Evaluation order encodes "prove the strongest claim the readings support,
 * then fall back to honest ignorance":
 *
 *  1. `testnet_soaking` — testnet is ahead of mainnet. The headline state, and
 *     provable from two readings, so it still fires when the GitHub fetch fails.
 *  2. `released_undeployed` — a release exists above BOTH chains. Requires all
 *     three: with a null testnet reading we know the release is ahead of
 *     mainnet but NOT that testnet hasn't already taken it, and reporting
 *     "undeployed" on that basis would assert something unmeasured.
 *  3. `unknown` — any reading is missing and nothing above was provable. This
 *     is the branch that keeps a dead testnet RPC from reading as calm.
 *  4. `none` — all three readings present and no upgrade in flight.
 *
 * Mainnet-behind-testnet is the only ordering that means "in flight". The
 * reverse (mainnet ahead of testnet, which happens when testnet lags a cycle)
 * is `none`: nothing is pending for mainnet, which is what the state describes.
 */
export function derivePendingUpgrade(
  readings: UpgradeReadings,
): PendingUpgradeState {
  const { mainnetSpec, testnetSpec, releaseSpec } = readings;
  if (mainnetSpec == null) return "unknown";
  if (testnetSpec != null && testnetSpec > mainnetSpec)
    return "testnet_soaking";
  if (
    releaseSpec != null &&
    testnetSpec != null &&
    releaseSpec > mainnetSpec &&
    releaseSpec > testnetSpec
  ) {
    return "released_undeployed";
  }
  if (testnetSpec == null || releaseSpec == null) return "unknown";
  return "none";
}

/** One chain's reading, as reported in the payload. */
export interface ChainReading {
  network: string;
  spec_version: number | null;
  /** When this reading was taken; null when the read failed. */
  observed_at: string | null;
}

/** The `current` block appended to GET /api/v1/runtime. */
export interface UpgradeRadar {
  mainnet: ChainReading;
  testnet: ChainReading;
  latest_release: ReleaseRecord | null;
  pending_upgrade: PendingUpgradeState;
  /**
   * How far mainnet trails the furthest-along reading, or null when unknown.
   * A count of spec versions — deliberately NOT a duration, and there is no
   * companion "expected" date anywhere in this payload (see the module header).
   */
  versions_behind: number | null;
}

function chainReading(
  network: string,
  spec: number | null,
  observedAt: string | null,
): ChainReading {
  return {
    network,
    spec_version: spec,
    // A null reading has no observation time — stamping one would imply we
    // successfully read something at that moment.
    observed_at: spec == null ? null : observedAt,
  };
}

/**
 * Assemble the radar block.
 *
 * Total: every argument may be null, and the result is always schema-stable, so
 * the route's shape never depends on whether an upstream answered.
 */
export function buildUpgradeRadar(input: {
  mainnetSpec: number | null;
  testnetSpec: number | null;
  release: ReleaseRecord | null;
  observedAt: string;
}): UpgradeRadar {
  const { mainnetSpec, testnetSpec, release, observedAt } = input;
  const releaseSpec = release?.spec_version ?? null;
  const pending = derivePendingUpgrade({
    mainnetSpec,
    testnetSpec,
    releaseSpec,
  });
  // Only meaningful against a known mainnet reading; the "ahead" side falls back
  // through testnet to the release so a GitHub outage doesn't blank it.
  let versionsBehind: number | null = null;
  if (mainnetSpec != null) {
    const ahead = Math.max(mainnetSpec, testnetSpec ?? 0, releaseSpec ?? 0);
    versionsBehind = ahead - mainnetSpec;
  }
  return {
    mainnet: chainReading("mainnet", mainnetSpec, observedAt),
    testnet: chainReading("testnet", testnetSpec, observedAt),
    latest_release: release,
    pending_upgrade: pending,
    versions_behind: versionsBehind,
  };
}

// ── feed items ──────────────────────────────────────────────────────────────

/** The tag every radar item carries, so `?tag=upgrade` works on day one. */
export const UPGRADE_FEED_TAG = "upgrade";

/** Shape-compatible with src/feeds.ts' FeedItem, duplicated to avoid a cycle. */
export interface UpgradeFeedItem {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
}

/**
 * Feed items for the release watcher.
 *
 * One item per published release carrying a parseable spec version. The id is
 * keyed on the tag, so re-polling the same release produces a byte-identical
 * item and the feed does not churn.
 *
 * Releases with no `published_at` are dropped rather than stamped with "now": a
 * feed item's timestamp is a claim about when the thing happened, and the whole
 * point of this module is not to invent those.
 */
export function releaseFeedItems(
  releases: readonly unknown[] | null | undefined,
  options: { repoUrl?: string } = {},
): UpgradeFeedItem[] {
  if (!Array.isArray(releases)) return [];
  const items: UpgradeFeedItem[] = [];
  for (const entry of releases) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true) continue;
    const tag = asString(record.tag_name);
    const publishedAt = asString(record.published_at);
    if (!tag || !publishedAt) continue;
    const specVersion = specVersionFromTag(tag);
    if (specVersion == null) continue;
    const url = asString(record.html_url) ?? options.repoUrl ?? "";
    if (!url) continue;
    const proposed = record.prerelease === true;
    items.push({
      id: `upgrade:release:${tag}`,
      url,
      title: `Runtime ${specVersion} released${proposed ? " (proposed)" : ""}`,
      summary:
        `Subtensor release ${tag} published on GitHub` +
        `${proposed ? " as a proposed runtime" : ""}. ` +
        `Deployment to testnet and mainnet is not scheduled publicly.`,
      timestamp: publishedAt,
      tags: ["chain", UPGRADE_FEED_TAG, "release"],
    });
  }
  return items;
}

/** One chain advancing to a new spec version, as recorded by the poller. */
export interface ObservedTransition {
  network: string;
  spec_version: number;
  /** When the poller first SAW this version — not when the chain upgraded. */
  observed_at: string;
}

/**
 * Append a transition to the ledger when a chain's reading has moved.
 *
 * WHY A LEDGER AND NOT THE BLOCK TIMELINE: `/api/v1/runtime`'s `transitions`
 * come from our own indexed blocks, which exist for mainnet only — we do not
 * index testnet. Testnet advancing is precisely the event this whole feature
 * exists to announce, so it cannot be sourced from block data, and using two
 * different mechanisms per network would give the two halves of one feed
 * different semantics. One poller-observed ledger covers both identically.
 *
 * The honesty cost is stated rather than hidden: a 30-minute poll cannot pin
 * the upgrade instant, so `observed_at` means "first seen by us at", and the
 * item copy says so. The exact mainnet block stays available on the runtime
 * timeline, which the item links to.
 *
 * Only forward movement is recorded. A reading that goes backwards is an RPC
 * serving stale state or a node rolling back, not an upgrade; a null reading
 * records nothing at all rather than looking like a change.
 */
export function appendTransitions(
  ledger: readonly ObservedTransition[] | null | undefined,
  readings: readonly { network: string; spec_version: number | null }[],
  observedAt: string,
  maxEntries = 50,
): ObservedTransition[] {
  const next = Array.isArray(ledger) ? [...ledger] : [];
  for (const reading of readings) {
    if (reading?.spec_version == null) continue;
    if (!Number.isInteger(reading.spec_version)) continue;
    const seen = next
      .filter((entry) => entry?.network === reading.network)
      .map((entry) => entry.spec_version);
    const highest = seen.length ? Math.max(...seen) : null;
    if (highest != null && reading.spec_version <= highest) continue;
    next.push({
      network: reading.network,
      spec_version: reading.spec_version,
      observed_at: observedAt,
    });
  }
  // Newest last; keep the tail so the ledger cannot grow without bound.
  return next.slice(-maxEntries);
}

/** KV key holding the observed-transition ledger. */
export const TRANSITION_LEDGER_KEY = "upgrade-radar:transitions";

/**
 * Feed items for observed chain transitions.
 *
 * Links to the runtime timeline rather than to a block: for mainnet the block
 * is on that page, and for testnet no block of ours exists. Pointing both at
 * the same place keeps one destination for "show me the upgrade history".
 */
export function transitionFeedItems(
  transitions: readonly ObservedTransition[] | null | undefined,
  options: { siteUrl: string } = { siteUrl: "" },
): UpgradeFeedItem[] {
  if (!Array.isArray(transitions)) return [];
  const items: UpgradeFeedItem[] = [];
  for (const transition of transitions) {
    if (!transition?.observed_at) continue;
    if (!Number.isInteger(transition.spec_version)) continue;
    const network = transition.network;
    if (network !== "mainnet" && network !== "testnet") continue;
    const label = network === "mainnet" ? "Mainnet" : "Testnet";
    items.push({
      id: `upgrade:${network}:spec:${transition.spec_version}`,
      url: `${options.siteUrl}/runtime`,
      title: `${label} now on runtime ${transition.spec_version}`,
      summary:
        `${label} was first observed running spec version ` +
        `${transition.spec_version} at this time. The radar polls twice an ` +
        `hour, so this is when the change was detected, not when it was applied.`,
      timestamp: transition.observed_at,
      tags: ["chain", UPGRADE_FEED_TAG, network],
    });
  }
  return items;
}

/**
 * Feed items for BIT (Bittensor Improvement Template) documents.
 *
 * Low volume by design — `opentensor/bits` last saw a push 2026-04-13 — so this
 * is cheap completeness rather than a system of its own. Keyed on the file's
 * blob sha, so an edited BIT produces a new item and an untouched one does not.
 */
export function bitFeedItems(
  entries: readonly unknown[] | null | undefined,
  options: { observedAt: string },
): UpgradeFeedItem[] {
  if (!Array.isArray(entries)) return [];
  const items: UpgradeFeedItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "file") continue;
    const name = asString(record.name);
    const sha = asString(record.sha);
    const url = asString(record.html_url);
    if (!name || !sha || !url) continue;
    if (!/\.mdx?$/i.test(name)) continue;
    // "BIT-0004-subnet-deregistration.md" -> number 0004, slug the rest.
    const parsed = /^BIT-(\d+)-(.+)\.mdx?$/i.exec(name);
    const label = parsed
      ? `BIT-${parsed[1]}: ${parsed[2].replace(/[-_]+/g, " ")}`
      : name;
    items.push({
      id: `upgrade:bit:${sha}`,
      url,
      title: label,
      summary: `Bittensor improvement document ${name} in opentensor/bits.`,
      timestamp: options.observedAt,
      tags: ["chain", UPGRADE_FEED_TAG, "bit"],
    });
  }
  return items;
}

// ── ops alert ───────────────────────────────────────────────────────────────

/**
 * Should the soak alert fire for this reading?
 *
 * The #8611 quiet-channel rule: an alert that repeats every poll trains people
 * to ignore it, which is worse than not having it. So the alert is keyed on the
 * spec version now soaking, and fires only when that key changes.
 *
 * `lastAlertedSpec` is the value the caller persisted from the previous fire —
 * a KV read. A null/unparseable stored value means "never alerted", so a KV
 * outage errs toward one duplicate alert rather than toward silence.
 *
 * Only `testnet_soaking` alerts. `released_undeployed` is normal and frequent
 * (a release sits unproposed for days); paging on it would be the exact noise
 * this guard exists to prevent.
 */
export function shouldAlertSoak(input: {
  state: PendingUpgradeState;
  testnetSpec: number | null;
  lastAlertedSpec: unknown;
}): boolean {
  if (input.state !== "testnet_soaking") return false;
  if (input.testnetSpec == null) return false;
  const last = Number(input.lastAlertedSpec);
  if (!Number.isInteger(last)) return true;
  return last !== input.testnetSpec;
}

/** KV key holding the last spec version the soak alert fired for. */
export const SOAK_ALERT_STATE_KEY = "upgrade-radar:last-soak-alert-spec";

// ── loaders ─────────────────────────────────────────────────────────────────
//
// Split by upstream, because the two upstreams have opposite constraints.
//
// SPEC VERSIONS are read live on the request path with a short KV cache, the
// same shape as loadNetworkParameters (src/network-parameters.ts): the chains
// answer in milliseconds, we hold no credential, and there is no per-caller
// rate-limit exposure since the cache key is fixed.
//
// GITHUB IS NOT READ ON THE REQUEST PATH AT ALL, and the calls it does make are
// authenticated. Two separate decisions:
//
//   * AUTHENTICATED (env.GITHUB_TOKEN, set via `wrangler secret put GITHUB_TOKEN
//     --name metagraphed`). Unauthenticated GitHub allows 60 requests/hour per
//     IP, and a Worker's egress comes from Cloudflare's SHARED addresses — a
//     budget we neither control nor have to ourselves, so an unauthenticated
//     radar would fail intermittently for reasons entirely outside this repo.
//     Authenticated raises that to 5,000/hour against OUR account. The token is
//     optional at runtime: if it is unset the calls still go out, and a throttle
//     degrades to null upstreams the same way any other failure does.
//   * OFF THE REQUEST PATH regardless. The radar route is cached and
//     high-traffic; making its latency and availability depend on GitHub's
//     would be wrong even with unlimited quota. The cron captures into KV on a
//     fixed schedule and the request path only ever reads KV, so GitHub being
//     down costs freshness, never a response.
//
// Requirement 2 of #8702 asks for live RPC on the spec versions specifically;
// the release feed carries no such requirement, and a twice-hourly capture sits
// well inside the upstream's 2-3 day release cadence.

export const UPGRADE_RADAR_KV_TTL = 300; // seconds
export const UPGRADE_RADAR_NEGATIVE_KV_TTL = 30; // seconds
export const UPGRADE_RADAR_RPC_TIMEOUT_MS = 5000;
export const UPGRADE_RADAR_GITHUB_TIMEOUT_MS = 8000;

/**
 * How long a captured GitHub snapshot stays usable.
 *
 * Deliberately far longer than the 15-minute refresh cadence: a stale release
 * reading is materially better than a null one, because null degrades
 * `pending_upgrade` to `unknown` and hides a soak that the two chain readings
 * could still have proven. The snapshot carries `captured_at` so a consumer can
 * see the staleness rather than infer it.
 */
export const UPGRADE_RADAR_SOURCES_KV_TTL = 86_400; // 24h

export const UPGRADE_RADAR_CACHE_KEY = "upgrade-radar:current";
export const UPGRADE_RADAR_SOURCES_KEY = "upgrade-radar:github-sources";

export const MAINNET_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";
export const TESTNET_RPC_URL = "https://test.finney.opentensor.ai:443";

// The releases listing is the canonical GitHub source. `opentensor/subtensor`
// is kept as the requested path even though it now redirects to
// RaoFoundation/subtensor: GitHub serves the redirect transparently, and
// pinning the new owner here would break again on the next transfer, whereas
// the URLs we actually publish come from each release's own html_url.
export const SUBTENSOR_RELEASES_URL =
  "https://api.github.com/repos/opentensor/subtensor/releases?per_page=100";
export const SUBTENSOR_REPO_URL = "https://github.com/opentensor/subtensor";
export const BITS_CONTENTS_URL =
  "https://api.github.com/repos/opentensor/bits/contents/bits";

/** A captured GitHub snapshot, as persisted in KV by the cron. */
export interface UpgradeRadarSources {
  schema_version: 1;
  captured_at: string;
  releases: unknown[];
  bits: unknown[];
}

/**
 * Build the GitHub request headers, authenticating when a token is available.
 *
 * Exported for the test that proves the Authorization header is actually sent —
 * an auth bug here is invisible until GitHub starts throttling, which is
 * exactly when nobody is looking.
 */
export function githubHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    // GitHub rejects API requests with no user-agent.
    "user-agent": "metagraphed-upgrade-radar",
    // Pin the API version so a future default change cannot reshape the
    // payloads this module's parsers were captured against.
    "x-github-api-version": "2022-11-28",
  };
  const token = env?.GITHUB_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    headers.authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function fetchJson(
  env: Env,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: githubHeaders(env),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Read one chain's spec version via `state_getRuntimeVersion`.
 *
 * Returns null on any failure — timeout, non-2xx, RPC error body, or an
 * unparseable payload. The caller turns null into `unknown`, never `none`.
 */
export async function fetchSpecVersion(
  rpcUrl: string,
  timeoutMs = UPGRADE_RADAR_RPC_TIMEOUT_MS,
): Promise<number | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_getRuntimeVersion",
        params: [],
      }),
    });
    if (!response.ok) return null;
    return specVersionFromRuntimeVersion(await response.json());
  } catch {
    return null;
  }
}

/**
 * Cron path: capture GitHub's release + BIT state into KV.
 *
 * Each upstream is fetched independently and a failure of one does not discard
 * the other. A capture that got NOTHING is not written at all, so a GitHub
 * outage leaves the previous (stale but real) snapshot in place rather than
 * overwriting it with emptiness — the distinction between "no releases" and
 * "could not ask" matters here for exactly the reason it matters in
 * derivePendingUpgrade.
 */
export async function refreshUpgradeRadarSources(
  env: Env,
): Promise<UpgradeRadarSources | null> {
  const [releases, bits] = await Promise.all([
    fetchJson(env, SUBTENSOR_RELEASES_URL, UPGRADE_RADAR_GITHUB_TIMEOUT_MS),
    fetchJson(env, BITS_CONTENTS_URL, UPGRADE_RADAR_GITHUB_TIMEOUT_MS),
  ]);
  if (!Array.isArray(releases) && !Array.isArray(bits)) return null;
  const snapshot: UpgradeRadarSources = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    releases: Array.isArray(releases) ? releases : [],
    bits: Array.isArray(bits) ? bits : [],
  };
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.put) {
    try {
      await kv.put(UPGRADE_RADAR_SOURCES_KEY, JSON.stringify(snapshot), {
        expirationTtl: UPGRADE_RADAR_SOURCES_KV_TTL,
      });
    } catch {
      // A KV write failure costs this tick's capture, nothing more.
    }
  }
  return snapshot;
}

/** Read the last captured GitHub snapshot. Null when never captured. */
export async function readUpgradeRadarSources(
  env: Env,
): Promise<UpgradeRadarSources | null> {
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.get) return null;
  try {
    const cached = await kv.get<UpgradeRadarSources>(
      UPGRADE_RADAR_SOURCES_KEY,
      { type: "json" },
    );
    return cached ?? null;
  } catch {
    return null;
  }
}

/**
 * Request path: the assembled radar, KV-cached.
 *
 * The negative TTL is short so a transient RPC blip resolves within half a
 * minute rather than pinning `unknown` for the full 5 minutes — the same
 * two-TTL split loadNetworkParameters uses, and for the same reason.
 */
export async function loadUpgradeRadar(env: Env): Promise<UpgradeRadar> {
  const kv = env?.METAGRAPH_CONTROL;
  if (kv?.get) {
    try {
      const cached = await kv.get<UpgradeRadar>(UPGRADE_RADAR_CACHE_KEY, {
        type: "json",
      });
      if (cached) return cached;
    } catch {
      // Fall through to a live read.
    }
  }

  const observedAt = new Date().toISOString();
  const [mainnetSpec, testnetSpec, sources] = await Promise.all([
    fetchSpecVersion(MAINNET_RPC_URL),
    fetchSpecVersion(TESTNET_RPC_URL),
    readUpgradeRadarSources(env),
  ]);
  const radar = buildUpgradeRadar({
    mainnetSpec,
    testnetSpec,
    release: selectLatestRelease(sources?.releases),
    observedAt,
  });

  if (kv?.put) {
    try {
      await kv.put(UPGRADE_RADAR_CACHE_KEY, JSON.stringify(radar), {
        expirationTtl:
          radar.pending_upgrade === "unknown"
            ? UPGRADE_RADAR_NEGATIVE_KV_TTL
            : UPGRADE_RADAR_KV_TTL,
      });
    } catch {
      // Non-fatal.
    }
  }
  return radar;
}

/**
 * Feed path: every upgrade item, from KV only.
 *
 * No network calls — the feed route is cached and high-traffic, and everything
 * it needs was captured by the cron. An empty result (cold KV, or a Worker with
 * no control binding) yields no items rather than an error, so the feeds that
 * merge these keep working before the first capture lands.
 */
export async function loadUpgradeFeedItems(
  env: Env,
  options: { siteUrl: string },
): Promise<UpgradeFeedItem[]> {
  const kv = env?.METAGRAPH_CONTROL;
  if (!kv?.get) return [];
  try {
    const [sources, ledger] = await Promise.all([
      kv.get<UpgradeRadarSources>(UPGRADE_RADAR_SOURCES_KEY, { type: "json" }),
      kv.get<ObservedTransition[]>(TRANSITION_LEDGER_KEY, { type: "json" }),
    ]);
    return [
      ...releaseFeedItems(sources?.releases, { repoUrl: SUBTENSOR_REPO_URL }),
      ...transitionFeedItems(ledger, options),
      ...bitFeedItems(sources?.bits, {
        // BIT files carry no per-file timestamp in the contents listing, so the
        // capture time is the only date we can honestly attach.
        observedAt: sources?.captured_at ?? new Date().toISOString(),
      }),
    ];
  } catch {
    return [];
  }
}

/**
 * Cron path: refresh sources, then decide whether the soak alert fires.
 *
 * Returns the decision rather than emitting it, so the Worker owns the ops
 * channel and this stays testable without a transport. The KV write that marks
 * a version as alerted happens here, immediately after the decision, so a
 * caller that drops the returned value still cannot double-fire.
 */
export async function evaluateUpgradeRadarScan(env: Env): Promise<{
  state: PendingUpgradeState;
  mainnetSpec: number | null;
  testnetSpec: number | null;
  alert: boolean;
}> {
  await refreshUpgradeRadarSources(env);
  const [mainnetSpec, testnetSpec, sources] = await Promise.all([
    fetchSpecVersion(MAINNET_RPC_URL),
    fetchSpecVersion(TESTNET_RPC_URL),
    readUpgradeRadarSources(env),
  ]);
  const state = derivePendingUpgrade({
    mainnetSpec,
    testnetSpec,
    releaseSpec: selectLatestRelease(sources?.releases)?.spec_version ?? null,
  });

  const kv = env?.METAGRAPH_CONTROL;

  // Record any forward movement before deciding on the alert, so the feed has
  // the item even on a tick whose alert is suppressed as a duplicate.
  if (kv?.get && kv?.put) {
    try {
      const ledger = await kv.get<ObservedTransition[]>(TRANSITION_LEDGER_KEY, {
        type: "json",
      });
      const next = appendTransitions(
        ledger,
        [
          { network: "mainnet", spec_version: mainnetSpec },
          { network: "testnet", spec_version: testnetSpec },
        ],
        new Date().toISOString(),
      );
      // Only write when something actually moved — an unchanged ledger written
      // twice an hour is pure KV churn.
      if (!ledger || next.length !== ledger.length) {
        await kv.put(TRANSITION_LEDGER_KEY, JSON.stringify(next));
      }
    } catch {
      // A ledger miss costs feed items, not correctness of the state above.
    }
  }

  let lastAlertedSpec: unknown = null;
  if (kv?.get) {
    try {
      lastAlertedSpec = await kv.get(SOAK_ALERT_STATE_KEY);
    } catch {
      // Treated as "never alerted" — one duplicate beats silence.
    }
  }

  const alert = shouldAlertSoak({ state, testnetSpec, lastAlertedSpec });
  if (alert && kv?.put) {
    try {
      // Written BEFORE the caller emits anything: a crash between the write and
      // the emit costs one missed alert, whereas the reverse order would let
      // every subsequent tick re-fire.
      await kv.put(SOAK_ALERT_STATE_KEY, String(testnetSpec));
    } catch {
      // Non-fatal; the next tick may duplicate.
    }
  }
  return { state, mainnetSpec, testnetSpec, alert };
}
