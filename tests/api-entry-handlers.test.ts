// The deployed entry must expose every handler the raw handler does.
//
// wrangler.jsonc's "main" is workers/api.entry.ts, NOT workers/api.ts -- the
// entry composes GitHub OAuth on top and re-exports the rest. Cloudflare only
// sees what THAT object exports, and a queue consumer is registered at deploy
// time only if the deployed Worker exports a `queue` handler.
//
// #9655 added queue() to api.ts and declared both consumers in wrangler.jsonc,
// but the composed object here was never extended. Measured on the live
// account before the fix:
//
//   webhook-deliveries      producers 1 (worker:metagraphed)  consumers 0
//   webhook-deliveries-dlq  producers 0                       consumers 0
//   sync-batches            producers 1 (data-api)            consumers 1
//
// The producer registered from the SAME config block, because a producer is
// only a binding and needs no handler -- which is what made this read as a
// Cloudflare-side inconsistency between two Workers rather than a missing
// export. metagraphed-data-api's queues work because its wrangler "main"
// points straight at the raw handler.
//
// api.entry.ts is excluded from COVERAGE (vitest.config.ts) as a thin
// composition layer. That is a statement about line coverage, not about
// whether the composition is correct: nothing else in the suite can catch a
// handler being added to api.ts and silently not reaching production.

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

// The real provider imports `cloudflare:` modules the node test environment
// cannot resolve, and it is irrelevant to the question this file asks -- which
// KEYS the composed object carries, not what fetch does with them.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    fetch() {
      return new Response("stub");
    }
  },
}));

async function entryHandler() {
  return (await import("../workers/api.entry.ts")).default as Record<
    string,
    unknown
  >;
}

async function rawHandler() {
  return (await import("../workers/api.ts")).default as Record<string, unknown>;
}

describe("api.entry handler parity", () => {
  test("exposes every handler the raw handler does", async () => {
    const entry = await entryHandler();
    const handler = await rawHandler();
    assert.deepEqual(
      Object.keys(entry).sort(),
      Object.keys(handler).sort(),
      "workers/api.ts gained a handler that workers/api.entry.ts does not " +
        "re-export, so the deployed Worker does not have it. For `queue` this " +
        "silently leaves the queue consumers unregistered; for a future " +
        "handler it would be the same class of bug.",
    );
  });

  test("exports `queue`, which is what registers the consumers", async () => {
    // Named separately from the parity check so the failure says WHY, and so
    // the specific regression stays pinned even if the parity assertion is
    // ever relaxed.
    const entry = await entryHandler();
    assert.equal(
      typeof entry.queue,
      "function",
      "without a queue handler on the DEPLOYED entry, Cloudflare registers no " +
        "consumer for webhook-deliveries or webhook-deliveries-dlq, and an " +
        "enqueued delivery is never processed",
    );
  });

  test("the entry's queue delegates to the raw handler, not a reimplementation", async () => {
    const entry = await entryHandler();
    const seen: unknown[] = [];
    const handler = await rawHandler();
    const original = handler.queue;
    handler.queue = async (batch: unknown) => {
      seen.push(batch);
    };
    try {
      await (
        entry.queue as (b: unknown, e: unknown, c: unknown) => Promise<void>
      )({ queue: "webhook-deliveries", messages: [] }, {}, {});
    } finally {
      handler.queue = original;
    }
    assert.equal(seen.length, 1, "the entry must forward the batch through");
    assert.equal(
      (seen[0] as { queue: string }).queue,
      "webhook-deliveries",
      "the batch must arrive unmodified — the DLQ branch in api.ts keys off it",
    );
  });
});
