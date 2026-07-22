// Publish-time change-feed dispatcher (ADR 0001 webhooks).
//
// Runs after the data publish (r2:upload + kv:publish) in the scheduled refresh.
// Reads the freshly-built changelog, derives the public change event, lists the
// webhook subscriptions from the METAGRAPH_CONTROL KV namespace, and fires
// HMAC-SHA256-signed POSTs to each matching subscriber (bounded fan-out, retries,
// delivery-time URL re-validation). Individual delivery failures are logged but
// NEVER fail the publish — a bad subscriber must not block the data pipeline.
//
// Safe by default: --dry-run (the default without --write) prints the event and
// makes no network/KV calls. A real dispatch additionally requires
// METAGRAPH_ALLOW_WEBHOOK_DISPATCH=1 + METAGRAPH_KV_NAMESPACE_ID.
import { spawnSync } from "node:child_process";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import {
  artifactFilePath,
  readJson,
  repoRoot,
  stableStringify,
} from "./lib.mjs";
import { selectDispatchKeys } from "./lib/webhook-dispatch-selection.mjs";
import {
  buildChangeEvent,
  dispatchWithRedelivery,
  isPublicWebhookAddress,
  WEBHOOK_KV_PREFIX,
  WEBHOOK_REDELIVERY_LIST_LIMIT,
  WEBHOOK_REDELIVERY_MAX_PER_RUN,
  WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION,
} from "../src/webhooks.ts";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const dryRun = args.has("--dry-run") || !write;
const MAX_DISPATCH_SUBSCRIPTIONS = 128;

// changelog.json is R2-only (#1003) — resolve via the tier-aware path so this
// reads the freshly-built dist/ copy in the publish flow (was public/).
const changelog: Row = await readJson(artifactFilePath("changelog.json"));
// build-summary.json is R2-only (#1003) — tier-aware read (dist/).
const buildSummary: Row = await readJson(
  artifactFilePath("build-summary.json"),
);
const pointer = {
  published_at: buildSummary.published_at || null,
  contract_version:
    changelog.contract_version || buildSummary.contract_version || null,
};
const event = buildChangeEvent({ changelog, pointer });

if (dryRun) {
  console.log(
    stableStringify({
      mode: "dry-run",
      event: {
        type: event.type,
        published_at: event.published_at,
        change_kinds: event.change_kinds,
        affected_netuids: event.affected_netuids,
        summary: event.summary,
      },
    }),
  );
  process.exit(0);
}

if (process.env.METAGRAPH_ALLOW_WEBHOOK_DISPATCH !== "1") {
  console.error(
    "Refusing to dispatch without METAGRAPH_ALLOW_WEBHOOK_DISPATCH=1.",
  );
  process.exit(1);
}
const namespaceId = process.env.METAGRAPH_KV_NAMESPACE_ID;
if (!namespaceId) {
  console.error("METAGRAPH_KV_NAMESPACE_ID is required to dispatch webhooks.");
  process.exit(1);
}

const allKeys = listKvKeys(namespaceId, WEBHOOK_KV_PREFIX);
if (allKeys.length > MAX_DISPATCH_SUBSCRIPTIONS) {
  console.error(
    `::warning::webhook dispatch capped at ${MAX_DISPATCH_SUBSCRIPTIONS} of ${allKeys.length} registered subscriptions`,
  );
}
// Fair rotation across runs (#5546): once the total exceeds the cap, a fixed
// lexicographic slice would starve every subscription sorting after the cap
// forever. Seed the selection with the wall-clock so each run rotates the
// window; every subscription is dispatched within a bounded number of runs.
const keys = selectDispatchKeys(allKeys, {
  max: MAX_DISPATCH_SUBSCRIPTIONS,
  seed: Date.now(),
}) as string[];
if (keys.length === 0) {
  console.log("No webhook subscriptions registered; nothing to dispatch.");
  process.exit(0);
}

const subscriptions: Row[] = [];
for (const key of keys) {
  const raw = getKvValue(namespaceId, key);
  if (!raw) continue;
  try {
    subscriptions.push(JSON.parse(raw));
  } catch {
    console.error(`::warning::skipping malformed subscription at ${key}`);
  }
}

// At-least-once delivery: fires the fresh event and retries the now-due backlog of
// previously-failed deliveries, persisting state to the same METAGRAPH_CONTROL namespace.
const { delivered, redelivered } = await dispatchWithRedelivery({
  subscriptions,
  event,
  fetchFn: safeWebhookFetch,
  now: () => new Date().toISOString(),
  store: makeDeliveryStore(namespaceId),
  concurrency: 8,
  timeoutMs: 8000,
  maxAttempts: 3,
  resolveHostnames: resolvePublicHostnames,
  redeliveryListLimit: WEBHOOK_REDELIVERY_LIST_LIMIT,
  maxRedeliveriesPerRun: WEBHOOK_REDELIVERY_MAX_PER_RUN,
  maxRedeliveriesPerSubscription: WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION,
});

const tally = delivered.reduce((acc: Record<string, number>, result) => {
  const status = result.status as string;
  acc[status] = (acc[status] || 0) + 1;
  return acc;
}, {});
for (const failure of delivered.filter(
  (result) => result.status === "failed",
)) {
  const fate = failure.retryable ? "parked for redelivery" : "dropped";
  console.error(
    `::warning::webhook ${failure.id} failed after ${failure.attempts} attempt(s): ${failure.reason} (status ${failure.status_code ?? "-"}) — ${fate}`,
  );
}
const redeliveryTally = redelivered.reduce(
  (acc: Record<string, number>, result) => {
    const status = result.status as string;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  },
  {},
);
console.log(
  stableStringify({
    mode: "dispatch",
    subscription_count: subscriptions.length,
    results: tally,
    redelivered: redeliveryTally,
  }),
);
// Exit 0 regardless of per-subscriber failures: the data publish already
// succeeded, and one broken endpoint must not fail the run.

function listKvKeys(
  nsId: string,
  prefix: string,
  { limit }: { limit?: number } = {},
): string[] {
  const stdout = runWrangler([
    "kv",
    "key",
    "list",
    "--namespace-id",
    nsId,
    "--prefix",
    prefix,
    "--remote",
  ]);
  if (!stdout) return [];
  try {
    const entries = JSON.parse(stdout);
    const keys: string[] = Array.isArray(entries)
      ? entries.map((entry: Row) => entry.name as string).filter(Boolean)
      : [];
    return Number.isFinite(limit) && (limit as number) >= 0
      ? keys.slice(0, limit)
      : keys;
  } catch {
    return [];
  }
}

function getKvValue(nsId: string, key: string): string | null {
  return runWrangler([
    "kv",
    "key",
    "get",
    key,
    "--namespace-id",
    nsId,
    "--remote",
  ]);
}

function putKvValue(
  nsId: string,
  key: string,
  value: string,
  ttlSeconds: number | undefined,
): void {
  const wranglerArgs = [
    "kv",
    "key",
    "put",
    key,
    value,
    "--namespace-id",
    nsId,
    "--remote",
  ];
  if (Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0) {
    wranglerArgs.push("--ttl", String(Math.floor(ttlSeconds as number)));
  }
  runWrangler(wranglerArgs);
}

function deleteKvValue(nsId: string, key: string): void {
  runWrangler(["kv", "key", "delete", key, "--namespace-id", nsId, "--remote"]);
}

// KV-backed delivery store for dispatchWithRedelivery. Best-effort: runWrangler
// logs + returns null on failure, so a KV hiccup never fails the publish.
function makeDeliveryStore(nsId: string): {
  listKeys: (prefix: string, options: { limit?: number }) => Promise<string[]>;
  get: (key: string) => Promise<Row | null>;
  put: (
    key: string,
    value: Row,
    options: { ttlSeconds: number },
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
} {
  return {
    async listKeys(prefix, options = {}) {
      return listKvKeys(nsId, prefix, options);
    },
    async get(key) {
      const raw = getKvValue(nsId, key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async put(key, value, { ttlSeconds } = { ttlSeconds: undefined as never }) {
      putKvValue(nsId, key, JSON.stringify(value), ttlSeconds);
    },
    async delete(key) {
      deleteKvValue(nsId, key);
    },
  };
}

async function resolvePublicHostnames(hostname: string): Promise<string[]> {
  return (await resolvePublicAddressRecords(hostname)).map(
    (record) => record.address,
  );
}

interface AddressRecord {
  address: string;
  family: number;
}

async function resolvePublicAddressRecords(
  hostname: string,
): Promise<AddressRecord[]> {
  const [v4, v6] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const records: AddressRecord[] = [
    ...(v4.status === "fulfilled"
      ? v4.value.map((address) => ({ address, family: 4 }))
      : []),
    ...(v6.status === "fulfilled"
      ? v6.value.map((address) => ({ address, family: 6 }))
      : []),
  ];
  if (records.some((record) => !isPublicWebhookAddress(record.address))) {
    const error = new Error("unsafe webhook DNS result") as Error & {
      code?: string;
    };
    error.code = "UNSAFE_WEBHOOK_DNS_RESULT";
    throw error;
  }
  if (records.length === 0) {
    const rejected = [v4, v6]
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (rejected.length > 0) {
      throw new AggregateError(rejected, "webhook DNS resolution failed");
    }
    throw new Error("no public webhook DNS result");
  }
  return records;
}

function safeWebhookFetch(
  requestUrl: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(String(requestUrl));
    } catch (error) {
      reject(error);
      return;
    }

    const req = httpsRequest(
      url,
      {
        method: init.method || "GET",
        headers: init.headers as Record<string, string>,
        signal: init.signal as AbortSignal,
        lookup(
          hostname: string,
          options: { family?: number } | undefined,
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void,
        ) {
          resolvePublicAddressRecords(hostname)
            .then((records) => {
              const family = options?.family;
              const match = family
                ? records.find((record) => record.family === family)
                : records[0];
              if (!match) {
                callback(new Error("no public webhook DNS result"), "", 0);
                return;
              }
              callback(null, match.address, match.family);
            })
            .catch((error) => callback(error, "", 0));
        },
      } as never,
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(new Response(null, { status: response.statusCode || 0 }));
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body as string);
    req.end();
  });
}

// Best-effort: a KV/wrangler hiccup here must NOT fail the publish run (the data
// is already live and the smoke step still needs to run). Log a warning and
// return null so the caller degrades to "no subscriptions / skip".
function runWrangler(wranglerArgs: string[]): string | null {
  const bin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(bin, wranglerArgs, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    console.error(
      `::warning::wrangler ${wranglerArgs[1] ?? ""} failed; skipping webhook dispatch. ${(result.stderr || result.stdout || "").trim()}`,
    );
    return null;
  }
  return result.stdout;
}
