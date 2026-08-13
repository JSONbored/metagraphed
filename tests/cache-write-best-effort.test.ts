// #11022. A `cache.put` can reject -- most often `Network connection lost.`
// when the caller disconnected and the response body being cloned is gone. An
// unhandled rejection inside `waitUntil` is recorded by the runtime as an
// exception, so a visitor closing a tab produced an ERROR carrying
// `outcome: "ok"`: the request succeeded and we filed a fault anyway.
//
// That was ~27% of this Worker's entire error channel over a 3-day window, and
// the routes it named are exactly the cache-eligible ones.
//
// The property under test is that a REJECTING put does not produce an
// unhandled rejection. Asserting the response is still 200 would pass either
// way -- the response was always fine; the background task was not.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const globalWithCaches = globalThis as unknown as { caches?: unknown };
const originalCaches = globalWithCaches.caches;
afterEach(() => {
  globalWithCaches.caches = originalCaches;
});

/** A cache whose every write fails the way a disconnected client's does. */
function installFailingCache() {
  let puts = 0;
  globalWithCaches.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        puts += 1;
        throw new Error("Network connection lost.");
      },
    },
  } as unknown as Row;
  return () => puts;
}

describe("a failed cache write is a miss, not an incident (#11022)", () => {
  test("a rejecting put does not escape the waitUntil", async () => {
    const puts = installFailingCache();
    const waits: Promise<unknown>[] = [];
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets"),
      createLocalArtifactEnv() as unknown as Parameters<
        typeof handleRequest
      >[1],
      { waitUntil: (p: Promise<unknown>) => waits.push(p) },
    );
    assert.equal(res.status, 200);
    assert.ok(puts() > 0, "the write must actually have been attempted");
    // THE assertion: awaiting what was handed to waitUntil must not reject.
    // Before this, the raw put promise went in and its rejection became an
    // exception span event.
    await Promise.all(waits);
  });

  test("the same holds for a chain-detail answer", async () => {
    const puts = installFailingCache();
    const waits: Promise<unknown>[] = [];
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/blocks/777"),
      {} as unknown as Parameters<typeof handleRequest>[1],
      { waitUntil: (p: Promise<unknown>) => waits.push(p) },
    );
    assert.equal(res.status, 200);
    void puts;
    await Promise.all(waits);
  });
});
