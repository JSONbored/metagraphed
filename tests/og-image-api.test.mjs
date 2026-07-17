// Unit tests for workers/og-image-api.mjs -- the dedicated OG-image Worker
// split out of workers/api.mjs (#6502). This is a thin `fetch` wrapper
// around src/og-image.mjs's handleOgImage (already covered directly by
// tests/og-image.test.mjs); these tests exist to cover this file's own two
// lines of glue: the URL construction + the 404 fallback when
// handleOgImage declines the route.
import assert from "node:assert/strict";
import { test } from "vitest";
import worker from "../workers/og-image-api.mjs";

test("delegates /og.png to handleOgImage and returns its response", async () => {
  const res = await worker.fetch(
    new Request("https://api.metagraph.sh/og.png", { method: "HEAD" }),
    {},
  );
  // HEAD short-circuits inside handleOgImage before any render/fetch work --
  // real behavior, not a mock -- confirming this file's own request/env
  // plumbing reaches the real handler correctly.
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("returns 404 for a path handleOgImage doesn't own", async () => {
  const res = await worker.fetch(
    new Request("https://api.metagraph.sh/not-og", { method: "GET" }),
    {},
  );
  assert.equal(res.status, 404);
});
