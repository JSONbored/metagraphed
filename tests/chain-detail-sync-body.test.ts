import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { readChainDetailSyncBody } from "../src/chain-detail-sync-body.ts";
import { CHAIN_DETAIL_SYNC_MAX_BODY_BYTES } from "../src/chain-detail-sync-payload.ts";

const encoder = new TextEncoder();

function request(chunks: Uint8Array[], length?: string) {
  let index = 0;
  return new Request("https://example.test/internal/chain-detail-sync", {
    method: "POST",
    headers: length === undefined ? {} : { "content-length": length },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: "half",
  } as RequestInit);
}

describe("chain-detail normalized text admission", () => {
  for (const [index, wire] of [
    encoder.encode('{"text":"ASCII"}'),
    encoder.encode('\ufeff{"text":"界 😀 \\ud800"}'),
    new Uint8Array([34, 0xff, 0xc2, 34]),
    new Uint8Array([0xef, 0xbb, 0xbf]),
    new Uint8Array([0xef, 0xbb]),
    new Uint8Array([0xf0, 0x9f, 0x98]),
    new Uint8Array(),
  ].entries()) {
    test(`matches native Request.text for case ${index} at every split`, async () => {
      const expected = await request([wire]).text();
      for (let split = 0; split <= wire.length; split += 1) {
        const actual = await readChainDetailSyncBody(
          request([
            wire.subarray(0, split),
            new Uint8Array(),
            wire.subarray(split),
          ]),
        );
        assert.equal(actual, expected);
      }
    });
  }

  test("keeps workerd's single-BOM rule instead of Node's double-BOM quirk", async () => {
    const wire = encoder.encode("\ufeff\ufeff{}");
    assert.equal(await request([wire]).text(), "{}");
    for (let split = 0; split <= wire.length; split += 1) {
      const actual = await readChainDetailSyncBody(request([
        wire.subarray(0, split), wire.subarray(split),
      ]));
      assert.equal(actual, "\ufeff{}");
    }
  });

  test("preserves a BOM-prefixed request at the decoded ceiling despite its larger wire length", async () => {
    const text = "x".repeat(CHAIN_DETAIL_SYNC_MAX_BODY_BYTES);
    const bytes = encoder.encode(`\ufeff${text}`);
    assert.equal(bytes.byteLength, CHAIN_DETAIL_SYNC_MAX_BODY_BYTES + 3);
    const actual = await readChainDetailSyncBody(
      request([bytes], String(bytes.byteLength)),
    );
    assert.equal(actual, text);
  });

  test("counts replacement characters and the final decoder flush before acceptance", async () => {
    const prefix = encoder.encode(
      "x".repeat(CHAIN_DETAIL_SYNC_MAX_BODY_BYTES - 2),
    );
    const wire = [prefix, new Uint8Array([0xc2])];
    const native = await request(wire).text();
    assert.equal(
      encoder.encode(native).byteLength,
      CHAIN_DETAIL_SYNC_MAX_BODY_BYTES + 1,
    );
    assert.equal(await readChainDetailSyncBody(request(wire)), null);
    assert.equal(
      await readChainDetailSyncBody(request([prefix, new Uint8Array([0xff])])),
      null,
    );
  });

  test("does not add a Content-Length acceptance rule", async () => {
    for (const length of [undefined, "0", "1", "garbage", "9".repeat(100)]) {
      assert.equal(
        await readChainDetailSyncBody(request([encoder.encode("{}")], length)),
        "{}",
      );
    }
  });

  test("preserves absent, consumed, locked and errored body behavior", async () => {
    assert.equal(
      await readChainDetailSyncBody(
        new Request("https://example.test", { method: "POST" }),
      ),
      "",
    );
    const used = request([encoder.encode("{}")]);
    await used.text();
    await assert.rejects(readChainDetailSyncBody(used), TypeError);
    const locked = request([encoder.encode("{}")]);
    const reader = locked.body!.getReader();
    await assert.rejects(readChainDetailSyncBody(locked), TypeError);
    reader.releaseLock();
    const failure = new Error("source interrupted");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const failed = new Request("https://example.test", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await assert.rejects(
      readChainDetailSyncBody(failed),
      (error) => error === failure,
    );
    assert.equal(stream.locked, false);
  });

  test("cancels at the first over-limit prefix without awaiting cancellation", async () => {
    const chunk = encoder.encode(
      "x".repeat(CHAIN_DETAIL_SYNC_MAX_BODY_BYTES + 1),
    );
    for (const kind of ["reject", "pending"] as const) {
      let reads = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
            return kind === "reject"
              ? Promise.reject(new Error("cancel failed"))
              : new Promise<void>(() => undefined);
          },
        },
        { highWaterMark: 0 },
      );
      const req = new Request("https://example.test", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit);
      assert.equal(await readChainDetailSyncBody(req), null);
      assert.equal(reads, 1);
      assert.equal(cancelled, true);
      assert.equal(stream.locked, false);
    }
  });
});
