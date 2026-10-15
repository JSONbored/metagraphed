import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { extrinsicRawUrl, fetchExtrinsicRaw, MAX_EXTRINSIC_RAW_BYTES } from "./extrinsic-raw";
import { setApiBase, setNetwork } from "./config";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setApiBase("");
  setNetwork("mainnet");
});

const url = "https://api.example/api/v1/extrinsics/0xabc";
function response(text: string, init?: ResponseInit) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text, init)));
}

describe("bounded exact extrinsic API response text", () => {
  it("preserves BOM, whitespace, CRLF, escapes and unsafe numeric tokens without JSON roundtrip", async () => {
    const text =
      '\uFEFF{\r\n "ok": true, "data": {"extrinsic":{"call_args":{"n":340282366920938463463374607431768211455,"s":"\\u0061"}}}}\r\n';
    response(text);
    expect(await fetchExtrinsicRaw(url)).toBe(text);
  });

  it("uses the selected base and network and validates the reference", () => {
    setApiBase("https://fixture.example");
    setNetwork("testnet");
    expect(extrinsicRawUrl("123-4")).toBe(
      "https://fixture.example/api/v1/testnet/extrinsics/123-4",
    );
    expect(() => extrinsicRawUrl("../../secrets")).toThrow("Invalid extrinsic hash");
  });

  it.each([
    [404, "not_found"],
    [410, "history_pruned"],
    [422, "unsupported_runtime"],
  ])("preserves HTTP %i and %s distinctions", async (status, code) => {
    response(
      JSON.stringify({ ok: false, error: { code, message: code }, meta: { network: "testnet" } }),
      { status },
    );
    await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({
      status,
      code,
      network: "testnet",
    });
  });

  it("retains logical errors, degraded tiers and absent records as unavailable", async () => {
    response('{"ok":false,"error":{"code":"unsupported_runtime","message":"unsupported"}}');
    await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({
      code: "unsupported_runtime",
      status: 200,
    });
    response('{"ok":true,"data":{}}', { headers: { "x-metagraph-degraded": "tier_unavailable" } });
    await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({ code: "data_tier_unavailable" });
    response('{"ok":true,"data":{"extrinsic":null}}');
    await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({ code: "raw_record_unavailable" });
    response('{"ok":true');
    await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({ code: "invalid_raw_record" });
  });

  it.each([200, 503])(
    "cancels an oversized streamed body including HTTP %i errors",
    async (status) => {
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(MAX_EXTRINSIC_RAW_BYTES + 1));
              },
              cancel,
            }),
            { status },
          ),
        ),
      );
      await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({
        code: "raw_record_too_large",
        status,
      });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("accepts the exact byte boundary and split multibyte UTF-8", async () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    response(prefix + "x".repeat(MAX_EXTRINSIC_RAW_BYTES - prefix.length - suffix.length) + suffix);
    expect((await fetchExtrinsicRaw(url)).length).toBe(MAX_EXTRINSIC_RAW_BYTES);
    const bytes = new TextEncoder().encode('{"value":"α"}');
    const at = bytes.indexOf(206);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, at + 1));
              controller.enqueue(bytes.slice(at + 1));
              controller.close();
            },
          }),
        ),
      ),
    );
    expect(await fetchExtrinsicRaw(url)).toBe('{"value":"α"}');
  });

  it("rejects invalid UTF-8 without replacement characters or a partial copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff]))));
    await expect(fetchExtrinsicRaw(url)).rejects.toBeInstanceOf(ApiError);
  });

  it.each([0, 1])(
    "bounds streams of %i-byte chunks independently of the byte limit",
    async (size) => {
      let chunks = 0;
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream({
              pull(controller) {
                chunks++;
                controller.enqueue(new Uint8Array(size));
              },
              cancel,
            }),
          ),
        ),
      );
      await expect(fetchExtrinsicRaw(url)).rejects.toMatchObject({
        code: "raw_record_chunk_limit",
      });
      expect(chunks).toBeLessThanOrEqual(4098);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["caller", "deadline"])(
    "cancels a stalled body on %s without waiting for cancellation acknowledgement",
    async (kind) => {
      const caller = new AbortController();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
      );
      const pending = fetchExtrinsicRaw(url, caller.signal);
      await Promise.resolve();
      (kind === "caller" ? caller : deadline).abort(new DOMException("stopped", "AbortError"));
      if (kind === "caller") await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      else await expect(pending).rejects.toMatchObject({ code: "raw_record_timeout" });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
