// Unit tests for the /og.png (alias /og) proxy (workers/api.mjs's
// handleOgImageProxy), which forwards to the dedicated OG-image Worker via
// the OG_IMAGE_API service binding (#6502). The downstream Worker's own
// rendering logic is covered by tests/og-image.test.mjs (handleOgImage
// directly) and tests/og-image-markup.test.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function ogRequest(path = "/og.png", { method = "GET" } = {}) {
  return new Request(`https://api.metagraph.sh${path}`, { method });
}

test("returns 503 when OG_IMAGE_API is not bound", async () => {
  const res = await handleRequest(ogRequest(), {}, {});
  assert.equal(res.status, 503);
});

test("forwards the request to OG_IMAGE_API and relays its response verbatim", async () => {
  let receivedUrl;
  const pngBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
  const res = await handleRequest(
    ogRequest(),
    {
      OG_IMAGE_API: {
        fetch(req) {
          receivedUrl = req.url;
          return new Response(pngBytes, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "cache-control": "public, max-age=3600",
            },
          });
        },
      },
    },
    {},
  );
  assert.equal(receivedUrl, "https://api.metagraph.sh/og.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), pngBytes);
});

test("the /og alias reaches the same proxy", async () => {
  let calls = 0;
  const res = await handleRequest(
    ogRequest("/og"),
    {
      OG_IMAGE_API: {
        fetch() {
          calls += 1;
          return new Response(null, { status: 200 });
        },
      },
    },
    {},
  );
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
});

test("relays a non-2xx upstream status (e.g. a downstream 503) unchanged", async () => {
  const res = await handleRequest(
    ogRequest(),
    {
      OG_IMAGE_API: {
        fetch() {
          return new Response("og image temporarily unavailable\n", {
            status: 503,
            headers: { "cache-control": "no-store" },
          });
        },
      },
    },
    {},
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("HEAD requests are forwarded unchanged (no method rewrite)", async () => {
  let receivedMethod;
  await handleRequest(
    ogRequest("/og.png", { method: "HEAD" }),
    {
      OG_IMAGE_API: {
        fetch(req) {
          receivedMethod = req.method;
          return new Response(null, { status: 200 });
        },
      },
    },
    {},
  );
  assert.equal(receivedMethod, "HEAD");
});
