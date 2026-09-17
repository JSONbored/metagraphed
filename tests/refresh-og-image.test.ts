import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { CARD_VERSION, OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("publish-time preview artifact", () => {
  test.each([
    "success",
    "missing-summary",
    "render-failure",
    "legacy-write-failure",
    "legacy-rename-failure",
    "current-write-failure",
    "current-rename-failure",
    "receipt-write-failure",
    "receipt-rename-failure",
  ])("a complete receipt is the final success marker: %s", async (mode) => {
    const png = Buffer.from("complete-rendered-PNG");
    const files = new Map<string, Buffer>(
      OG_IMAGE_FILE_NAMES.map((name) => [name, Buffer.from("prior-" + name)]),
    );
    const writes: string[] = [];
    const stageOf = (file: string) =>
      file.includes("og-image-render.json")
        ? "receipt"
        : file.includes("og-image-v")
          ? "current"
          : "legacy";
    vi.doMock("node:fs/promises", () => ({
      mkdir: async () => {},
      readFile: async () => {
        if (mode === "missing-summary") throw new Error("missing");
        return Buffer.from('{"subnet_count":128}');
      },
      writeFile: async (file: string, bytes: string | Buffer) => {
        writes.push(file);
        if (
          file.endsWith(".pending") &&
          mode === stageOf(file) + "-write-failure"
        )
          throw new Error("disk full");
        files.set(file.split("/").at(-1)!, Buffer.from(bytes));
      },
      rename: async (from: string, to: string) => {
        if (mode === stageOf(to) + "-rename-failure")
          throw new Error("rename failed");
        files.set(to.split("/").at(-1)!, files.get(from.split("/").at(-1)!)!);
      },
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "a".repeat(40),
    }));
    vi.doMock("../scripts/lib.ts", () => ({
      repoRoot: "/local-preview-fixture",
      stableStringify: JSON.stringify,
    }));
    vi.doMock("../scripts/observability.ts", () => ({
      initObservability: () => {},
      endSessionAndFlush: async () => {},
      captureExceptionAndContinue: async () => {},
    }));
    vi.doMock("../scripts/og-image-render.ts", () => ({
      renderImageRelease: async () => {
        if (mode === "render-failure") throw new Error("renderer unavailable");
        return {
          receipt: {
            status: "rendered",
            renderer_version: CARD_VERSION,
            source_sha256: "source",
            artifacts: OG_IMAGE_FILE_NAMES,
          },
          pngs: Object.fromEntries(
            OG_IMAGE_FILE_NAMES.map((name) => [`/metagraph/${name}`, png]),
          ),
        };
      },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("fixture-exit");
    });
    await assert.rejects(
      import("../scripts/refresh-og-image.ts"),
      /fixture-exit/,
    );
    assert.equal(exit.mock.calls[0][0], 0);
    const result = JSON.parse(log.mock.calls.at(-1)![0]);
    const saved = JSON.parse(files.get("og-image-render.json")!.toString());
    assert.equal(result.renderer_version, CARD_VERSION);
    assert.equal(result.status, mode === "success" ? "rendered" : "skipped");
    assert.equal(saved.status, result.status);
    assert.ok(
      writes[0].endsWith("og-image-render.json"),
      "invalidate any old receipt first",
    );
    if (mode === "success") {
      for (const name of OG_IMAGE_FILE_NAMES)
        assert.deepEqual(files.get(name), png);
      assert.ok(writes.at(-1)!.endsWith("og-image-render.json.pending"));
    } else
      assert.equal(
        saved.source_sha256,
        undefined,
        "partial output cannot retain an earlier success receipt",
      );
  });
});
