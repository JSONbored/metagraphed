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
import {
  buildChangeEvent,
  dispatchChangeEvent,
  isPublicWebhookAddress,
  WEBHOOK_KV_PREFIX,
} from "../src/webhooks.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const dryRun = args.has("--dry-run") || !write;
const MAX_DISPATCH_SUBSCRIPTIONS = 128;

// changelog.json is R2-only (#1003) — resolve via the tier-aware path so this
// reads the freshly-built dist/ copy in the publish flow (was public/).
const changelog = await readJson(artifactFilePath("changelog.json"));
// build-summary.json is R2-only (#1003) — tier-aware read (dist/).
const buildSummary = await readJson(artifactFilePath("build-summary.json"));
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
const keys = allKeys.slice(0, MAX_DISPATCH_SUBSCRIPTIONS);
if (keys.length === 0) {
  console.log("No webhook subscriptions registered; nothing to dispatch.");
  process.exit(0);
}

const subscriptions = [];
for (const key of keys) {
  const raw = getKvValue(namespaceId, key);
  if (!raw) continue;
  try {
    subscriptions.push(JSON.parse(raw));
  } catch {
    console.error(`::warning::skipping malformed subscription at ${key}`);
  }
}

const results = await dispatchChangeEvent({
  subscriptions,
  event,
  fetchFn: safeWebhookFetch,
  now: () => new Date().toISOString(),
  concurrency: 8,
  timeoutMs: 8000,
  maxAttempts: 3,
  resolveHostnames: resolvePublicHostnames,
});

const tally = results.reduce((acc, result) => {
  acc[result.status] = (acc[result.status] || 0) + 1;
  return acc;
}, {});
for (const failure of results.filter((result) => result.status === "failed")) {
  console.error(
    `::warning::webhook ${failure.id} failed after ${failure.attempts} attempt(s): ${failure.reason} (status ${failure.status_code ?? "-"})`,
  );
}
console.log(
  stableStringify({
    mode: "dispatch",
    subscription_count: subscriptions.length,
    results: tally,
  }),
);
// Exit 0 regardless of per-subscriber failures: the data publish already
// succeeded, and one broken endpoint must not fail the run.

function listKvKeys(nsId, prefix) {
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
    return Array.isArray(entries)
      ? entries.map((entry) => entry.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function getKvValue(nsId, key) {
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

async function resolvePublicHostnames(hostname) {
  return (await resolvePublicAddressRecords(hostname)).map(
    (record) => record.address,
  );
}

async function resolvePublicAddressRecords(hostname) {
  const [v4, v6] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const records = [
    ...(v4.status === "fulfilled"
      ? v4.value.map((address) => ({ address, family: 4 }))
      : []),
    ...(v6.status === "fulfilled"
      ? v6.value.map((address) => ({ address, family: 6 }))
      : []),
  ];
  if (
    records.length === 0 ||
    records.some((record) => !isPublicWebhookAddress(record.address))
  ) {
    throw new Error("unsafe webhook DNS result");
  }
  return records;
}

function safeWebhookFetch(requestUrl, init = {}) {
  return new Promise((resolve, reject) => {
    let url;
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
        headers: init.headers,
        signal: init.signal,
        lookup(hostname, options, callback) {
          resolvePublicAddressRecords(hostname)
            .then((records) => {
              const family = options?.family;
              const match = family
                ? records.find((record) => record.family === family)
                : records[0];
              if (!match) {
                callback(new Error("no public webhook DNS result"));
                return;
              }
              callback(null, match.address, match.family);
            })
            .catch((error) => callback(error));
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(new Response(null, { status: response.statusCode || 0 }));
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// Best-effort: a KV/wrangler hiccup here must NOT fail the publish run (the data
// is already live and the smoke step still needs to run). Log a warning and
// return null so the caller degrades to "no subscriptions / skip".
function runWrangler(wranglerArgs) {
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
