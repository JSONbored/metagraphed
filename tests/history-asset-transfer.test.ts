import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  transferHistoryAssets,
  type HistoryTransferIo,
  type HistoryTransferSource,
} from "../src/history-asset-transfer.ts";

vi.mock("node:crypto", { spy: true });

const hash = (kind: string, bytes: Uint8Array) =>
  createHash(kind).update(bytes).digest("hex");
function source(raw: Uint8Array, prefix = "immutable") {
  const sha256 = hash("sha256", raw);
  return {
    key: `${prefix}/${sha256}.bin`,
    sha256,
    etag: hash("md5", raw),
    bytes: raw.length,
  };
}
function setup(raws = [new Uint8Array([1, 2, 3])]) {
  const sources = raws.map((raw, i) => source(raw, `immutable/${i}`));
  const uploaded = new Map<string, Uint8Array>();
  const io: HistoryTransferIo = {
    get: vi.fn(async (ref) => ({
      size: ref.bytes,
      etag: ref.etag,
      body: new Response(raws[sources.findIndex((s) => s.key === ref.key)])
        .body,
    })),
    session: vi.fn<HistoryTransferIo["session"]>(async (_part, manifest) => ({
      jwt: "upload-token",
      buckets: [Object.values(manifest).map((f) => f.hash)],
    })),
    upload: vi.fn(async (_jwt, form) => {
      for (const [key, file] of form.entries()) {
        const bytes = Buffer.from(await (file as Blob).text(), "base64");
        expect(hash("sha256", bytes).slice(0, 32)).toBe(key);
        uploaded.set(hash("sha256", bytes), bytes);
      }
      return { jwt: "completion-token" };
    }),
  };
  return { sources, io, uploaded };
}

describe("one-read immutable history transfer", () => {
  it("rejects a truncated upload-hash collision before opening a session", async () => {
    const raw = new Uint8Array(128 * 1024 + 1);
    raw[raw.length - 1] = 1;
    const { sources, io } = setup([raw]);
    const original = (
      await vi.importActual<typeof import("node:crypto")>("node:crypto")
    ).createHash;
    const collision = (suffix: string) =>
      ({
        update: () => ({ digest: () => "0".repeat(32) + suffix.repeat(32) }),
      }) as unknown as ReturnType<typeof createHash>;
    vi.mocked(createHash)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => collision("1"))
      .mockImplementationOnce(() => collision("2"));
    try {
      await expect(transferHistoryAssets(sources, io)).rejects.toThrow(
        "hash collision",
      );
      expect(io.session).not.toHaveBeenCalled();
    } finally {
      vi.mocked(createHash).mockRestore();
    }
  });

  it("restores exact files from discovered chunks with one source read each", async () => {
    const raw = new Uint8Array(128 * 1024 * 2 + 7);
    raw.fill(17, 0, 128 * 1024);
    raw.fill(29, 128 * 1024);
    const { sources, io, uploaded } = setup([raw, raw.slice(0, 128 * 1024)]);
    const result = await transferHistoryAssets(sources, io);
    expect(io.get).toHaveBeenCalledTimes(2);
    expect(result.sourceBytes).toBe(raw.length + 128 * 1024);
    expect(result.uploadedBytes).toBe(raw.length);
    for (const file of result.files) {
      const restored = Buffer.concat(
        file.chunks.map((c) => uploaded.get(c.sha256)!),
      );
      expect(restored.length).toBe(file.source.bytes);
      expect(hash("sha256", restored)).toBe(file.source.sha256);
      expect(hash("md5", restored)).toBe(file.source.etag);
    }
  });

  it("honors already present assets and does not upload or disclose tokens", async () => {
    const { sources, io } = setup();
    io.session = vi.fn(async () => ({
      jwt: "private-completion",
      buckets: [],
    }));
    const result = await transferHistoryAssets(sources, io);
    expect(result.uploadedBytes).toBe(0);
    expect(io.upload).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-completion");
  });

  it("honors provider upload buckets and requires final completion", async () => {
    const raw = new Uint8Array(128 * 1024 * 40);
    for (let i = 0; i < 40; i++)
      raw.fill(i, i * 128 * 1024, (i + 1) * 128 * 1024);
    const { sources, io } = setup([raw]);
    io.session = vi.fn<HistoryTransferIo["session"]>(async (_p, manifest) => ({
      jwt: "upload",
      buckets: Object.values(manifest).map((v) => [v.hash]),
    }));
    await transferHistoryAssets(sources, io);
    expect(io.upload).toHaveBeenCalledTimes(40);
  });

  it("bounds upload concurrency and waits for active lanes when one fails", async () => {
    const raw = new Uint8Array(128 * 1024 * 40);
    for (let i = 0; i < 40; i++)
      raw.fill(i, i * 128 * 1024, (i + 1) * 128 * 1024);
    const { sources, io } = setup([raw]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    io.session = vi.fn(async () => {
      const index = calls++;
      if (index === 0) throw new Error("partition failed");
      await gate;
      return { jwt: "complete", buckets: [] };
    });
    let settled = false;
    const pending = transferHistoryAssets(sources, io).finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toThrow("partition failed");
    // Reading the source is asynchronous; wait for the first wave to start.
    await vi.waitFor(() => expect(calls).toBe(4));
    expect(settled).toBe(false);
    release();
    await assertion;
    expect(calls).toBe(4);
    expect(io.get).toHaveBeenCalledOnce();
  });

  it.each([
    (s: HistoryTransferSource) => ({ ...s, bytes: 0 }),
    (s: HistoryTransferSource) => ({ ...s, bytes: 1.5 }),
    (s: HistoryTransferSource) => ({ ...s, bytes: 16 * 1024 ** 2 + 1 }),
    (s: HistoryTransferSource) => ({ ...s, sha256: "invalid" }),
    (s: HistoryTransferSource) => ({ ...s, etag: "invalid" }),
    (s: HistoryTransferSource) => ({ ...s, key: "mutable/latest.bin" }),
  ])("rejects invalid source identity before I/O", async (change) => {
    const { sources, io } = setup();
    await expect(
      transferHistoryAssets([change(sources[0])], io),
    ).rejects.toThrow("Invalid");
    expect(io.get).not.toHaveBeenCalled();
  });

  it("rejects empty, oversized, duplicate, and over-budget batches before I/O", async () => {
    const { sources, io } = setup();
    for (const batch of [
      [],
      Array(17).fill(sources[0]),
      [sources[0], sources[0]],
    ]) {
      await expect(transferHistoryAssets(batch, io)).rejects.toThrow("Invalid");
    }
    await expect(
      transferHistoryAssets(
        [
          { ...sources[0], bytes: 16 * 1024 ** 2 },
          { ...sources[0], key: `other/${sources[0].sha256}.bin` },
        ],
        io,
      ),
    ).rejects.toThrow("memory budget");
    expect(io.get).not.toHaveBeenCalled();
  });

  it.each(["missing", "body", "size", "etag"])(
    "rejects changed source %s",
    async (kind) => {
      const { sources, io } = setup();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      io.get = vi.fn(async () =>
        kind === "missing"
          ? null
          : {
              body: kind === "body" ? null : body,
              size: kind === "size" ? 7 : sources[0].bytes,
              etag: kind === "etag" ? "changed" : sources[0].etag,
            },
      );
      await expect(transferHistoryAssets(sources, io)).rejects.toThrow(
        "identity changed",
      );
      expect(io.session).not.toHaveBeenCalled();
      if (kind === "size" || kind === "etag")
        expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["oversize", "truncated", "sha256", "md5", "stream"])(
    "rejects corrupt source %s",
    async (kind) => {
      const { sources, io } = setup();
      const ref = sources[0];
      if (kind === "md5") ref.etag = "0".repeat(32);
      const cancel = vi.fn();
      io.get = vi.fn(async () => ({
        size: ref.bytes,
        etag: ref.etag,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            if (kind === "stream") controller.error(new Error("stream failed"));
            else {
              controller.enqueue(
                new Uint8Array(
                  kind === "oversize"
                    ? [1, 2, 3, 4]
                    : kind === "truncated"
                      ? [1]
                      : kind === "sha256"
                        ? [3, 2, 1]
                        : [1, 2, 3],
                ),
              );
              if (kind !== "oversize") controller.close();
            }
          },
          cancel,
        }),
      }));
      await expect(transferHistoryAssets(sources, io)).rejects.toThrow();
      expect(io.session).not.toHaveBeenCalled();
      if (kind === "oversize") expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { jwt: "", buckets: [] },
    { jwt: "x".repeat(8193), buckets: [] },
    { jwt: 4, buckets: [] },
    { jwt: "x", buckets: null },
    { jwt: "x", buckets: [[]] },
    { jwt: "x", buckets: ["bad"] },
    { jwt: "x", buckets: [["unknown"]] },
  ])("rejects malformed session without uploading: %j", async (value) => {
    const { sources, io } = setup();
    io.session = vi.fn(
      async () =>
        value as unknown as Awaited<ReturnType<HistoryTransferIo["session"]>>,
    );
    await expect(transferHistoryAssets(sources, io)).rejects.toThrow();
    expect(io.upload).not.toHaveBeenCalled();
  });

  it("rejects duplicate requests across provider buckets", async () => {
    const { sources, io } = setup();
    io.session = vi.fn<HistoryTransferIo["session"]>(async (_p, manifest) => {
      const h = Object.values(manifest)[0].hash;
      return { jwt: "x", buckets: [[h], [h]] };
    });
    await expect(transferHistoryAssets(sources, io)).rejects.toThrow(
      "unknown bytes",
    );
    expect(io.upload).not.toHaveBeenCalled();
  });

  it.each([{}, { jwt: "" }])(
    "fails without provider completion: %j",
    async (value) => {
      const { sources, io } = setup();
      io.upload = vi.fn(async () => value);
      await expect(transferHistoryAssets(sources, io)).rejects.toThrow(
        "completion missing",
      );
      expect(io.get).toHaveBeenCalledOnce();
    },
  );

  it("propagates upload failure without rereading or reporting success", async () => {
    const { sources, io } = setup();
    io.upload = vi.fn(async () => {
      throw new Error("upload unavailable");
    });
    await expect(transferHistoryAssets(sources, io)).rejects.toThrow(
      "upload unavailable",
    );
    expect(io.get).toHaveBeenCalledOnce();
  });
});
