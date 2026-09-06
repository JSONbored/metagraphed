import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { fallbackResponse } from "../src/og-image.ts";

const PNG = readFileSync(
  new URL("../public/brand/og-fallback.png", import.meta.url),
);
const previewUrl = new URL("https://api.metagraph.sh/og.png");
const headers = { "content-type": "image/png" };

describe("the API fallback validates the asset response", () => {
  test("a real full-size PNG survives multiple chunks and MIME parameters", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG.subarray(0, 20));
        controller.enqueue(PNG.subarray(20));
        controller.close();
      },
    });
    const response = await fallbackResponse(
      {
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": " Image/PNG ; charset=binary" },
          }),
      },
      previewUrl,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  });

  test("HTML200, missing MIME, empty and null200 bodies cannot become cached images", async () => {
    for (const asset of [
      new Response("<html>not an image</html>", {
        headers: { "content-type": "text/html" },
      }),
      new Response(PNG),
      new Response("", { headers }),
      new Response(null, { headers }),
      new Response(null, { status: 404 }),
    ]) {
      const response = await fallbackResponse(
        { fetch: async () => asset },
        previewUrl,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  test("wrong signature, truncated IHDR, wrong dimensions and non-IHDR headers reject", async () => {
    const badSignature = Buffer.from(PNG);
    badSignature[0] = 0;
    const wrongLength = Buffer.from(PNG);
    wrongLength.writeUInt32BE(12, 8);
    const wrongType = Buffer.from(PNG);
    wrongType.write("IDAT", 12);
    const wrongWidth = Buffer.from(PNG);
    wrongWidth.writeUInt32BE(1, 16);
    const wrongHeight = Buffer.from(PNG);
    wrongHeight.writeUInt32BE(1, 20);
    for (const body of [
      badSignature,
      PNG.subarray(0, 24),
      wrongLength,
      wrongType,
      wrongWidth,
      wrongHeight,
    ]) {
      const response = await fallbackResponse(
        { fetch: async () => new Response(body, { headers }) },
        previewUrl,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });

  test("declared or actual oversize cancels the asset stream", async () => {
    for (const declared of [true, false]) {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(declared ? PNG : new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          canceled = true;
        },
      });
      const response = await fallbackResponse(
        {
          fetch: async () =>
            new Response(body, {
              headers: {
                ...headers,
                ...(declared
                  ? { "content-length": String(1024 * 1024 + 1) }
                  : { "content-length": "1" }),
              },
            }),
        },
        previewUrl,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(canceled, true);
    }
  });

  test("a stream read failure degrades to503no-store", async () => {
    const response = await fallbackResponse(
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("asset read failed"));
              },
            }),
            { headers },
          ),
      },
      previewUrl,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
