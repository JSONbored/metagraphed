// #8705 PR3: generate weekly digests from the published feeds and store them.
//
// WHY IT READS OUR OWN API rather than the database. Per-subnet feed items are
// assembled in the Worker from three tiers at once -- committed GitHub signals,
// published artifacts, and D1 chain rows. A build-time script can reach the
// first two and not the third, so a script that rebuilt the window itself would
// both miss ~30% of items and restate the Worker's merge. The feed endpoint is
// the one thing that already IS that merge.
//
// WHY NOT THE INDEXER. ADR 0014 decision 5 -- "one first-party live indexer is
// enough" -- and ADR 0015, which chose a Postgres outbox over an indexer push
// precisely so nothing new lands in indexer-rs's critical path. indexer-rs
// indexes chain state; a weekly digest is derived editorial content. It does
// not belong there.
//
// So this is the same shape as scripts/github-signals.ts: fetch live, write a
// committed file, and a scheduled workflow opens a PR when it changes. Tolerant
// by design -- a fetch that fails leaves the last committed digests intact.
//
//   node scripts/refresh-digests.ts [--write]
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTimestamp,
  loadSubnets,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.ts";
import {
  digestKey,
  generateDigests,
  mergeDigestStore,
  type DigestStore,
} from "../src/weekly-digest-store.ts";
import type { DigestSourceItem, WeeklyDigest } from "../src/weekly-digest.ts";

export const digestsPath = path.join(
  repoRoot,
  "registry/generated/digests.json",
);

const API_BASE = process.env.METAGRAPH_API_BASE || "https://api.metagraph.sh";

/** How many feed items to ask for per subject. The cap the feed itself uses. */
const FEED_LIMIT = 50;

/** Concurrent feed fetches. Same limit github-signals.ts uses for GitHub. */
const CONCURRENCY = 8;

interface JsonFeedItem {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  summary?: unknown;
  content_text?: unknown;
  date_published?: unknown;
  date_modified?: unknown;
  tags?: unknown;
}

/**
 * A JSON Feed item as the digest generator wants it.
 *
 * Returns null rather than a partial: an item with no id cannot be cited, and
 * one with no timestamp cannot be placed in a week. Both would be dropped
 * downstream anyway -- dropping them here keeps the reason legible.
 */
export function toDigestItem(raw: JsonFeedItem): DigestSourceItem | null {
  const id = typeof raw?.id === "string" ? raw.id : "";
  const timestamp =
    typeof raw?.date_published === "string"
      ? raw.date_published
      : typeof raw?.date_modified === "string"
        ? raw.date_modified
        : "";
  if (id === "" || timestamp === "") return null;
  return {
    id,
    url: typeof raw?.url === "string" ? raw.url : "",
    title: typeof raw?.title === "string" ? raw.title : "",
    summary:
      typeof raw?.summary === "string"
        ? raw.summary
        : typeof raw?.content_text === "string"
          ? raw.content_text
          : "",
    timestamp,
    tags: Array.isArray(raw?.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

async function fetchFeedItems(feedPath: string): Promise<DigestSourceItem[]> {
  const url = `${API_BASE}${feedPath}?format=json&limit=${FEED_LIMIT}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${feedPath} -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body?.items) ? body.items : [];
  return items
    .map((raw) => toDigestItem(raw as JsonFeedItem))
    .filter((item): item is DigestSourceItem => item !== null);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const next = queue.shift() as T;
        results.push(await mapper(next));
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const shouldWrite = process.argv.slice(2).includes("--write");
  // Tolerant by design, same posture as github-signals.ts and
  // refresh-native-snapshot.ts: this must never be the reason a publish fails.
  // On any error the last committed digests stand, unchanged.
  try {
    const now = new Date();
    const generatedAt = buildTimestamp();
    const existing = (await readJson(digestsPath).catch(
      () => null,
    )) as DigestStore | null;
    const existingKeys = new Set(
      (Array.isArray(existing?.digests) ? existing.digests : []).map(
        (digest: WeeklyDigest) => digestKey(digest.netuid, digest.slug),
      ),
    );

    const overlays = await loadSubnets();
    const netuids = overlays
      .map((overlay) => Number((overlay as { netuid?: unknown }).netuid))
      .filter((netuid) => Number.isInteger(netuid) && netuid > 0)
      .sort((a, b) => a - b);

    const produced: WeeklyDigest[] = [];
    const failures: string[] = [];

    const perSubnet = await mapLimit(netuids, CONCURRENCY, async (netuid) => {
      try {
        const items = await fetchFeedItems(`/api/v1/feeds/subnets/${netuid}`);
        return generateDigests({
          netuid,
          items,
          now,
          generatedAt,
          existingKeys,
        }).digests;
      } catch (error) {
        // One subject's feed failing costs that subject's digests this run,
        // never the run -- next week picks it up, because nothing was written
        // for it and the week stays a candidate.
        failures.push(
          `sn${netuid}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    });
    for (const digests of perSubnet) produced.push(...digests);

    // The network-wide digest reads the registry feed -- the same window a
    // reader of /api/v1/feeds/registry sees.
    try {
      const items = await fetchFeedItems("/api/v1/feeds/registry");
      produced.push(
        ...generateDigests({
          netuid: null,
          items,
          now,
          generatedAt,
          existingKeys,
        }).digests,
      );
    } catch (error) {
      failures.push(
        `network: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const merged = mergeDigestStore(existing, produced, generatedAt);
    if (shouldWrite) {
      await fs.mkdir(path.dirname(digestsPath), { recursive: true });
      await writeJson(digestsPath, merged.store);
    }

    console.log(
      stableStringify({
        mode: shouldWrite ? "write" : "dry-run",
        subjects: netuids.length + 1,
        added: merged.added,
        total: merged.store.digests.length,
        failed_subjects: failures.length,
      }),
    );
    if (failures.length > 0) {
      console.warn(
        `::warning::${failures.length} feed(s) could not be read this run: ${failures.slice(0, 5).join("; ")}`,
      );
    }
  } catch (error) {
    console.warn(
      `::warning::digest refresh failed; keeping the last committed digests. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Only run when invoked directly, not when imported for its exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
