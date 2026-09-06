import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test, vi } from "vitest";
import {
  CARD_VERSION,
  OG_IMAGE_FILE_NAMES,
  OG_IMAGE_FILE_NAME,
} from "../src/og-card-version.ts";

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
  ])(
    "records truthful completion and preserves current artwork: %s",
    async (mode) => {
      vi.resetModules();
      const png = Buffer.from("complete-rendered-PNG");
      const published = new Map(
        OG_IMAGE_FILE_NAMES.map((name) => [name, Buffer.from("prior-" + name)]),
      );
      const pending = new Map<string, Buffer>();
      const writes: string[] = [];
      const renames: [string, string][] = [];
      vi.doMock("node:fs/promises", () => ({
        mkdir: async () => {},
        readFile: async () => {
          if (mode === "missing-summary") throw new Error("missing");
          return JSON.stringify({ subnet_count: 128 });
        },
        writeFile: async (file: string, bytes: Buffer) => {
          writes.push(file);
          const stage = file.endsWith(OG_IMAGE_FILE_NAME + ".pending")
            ? "current"
            : "legacy";
          if (mode === stage + "-write-failure") throw new Error("disk full");
          pending.set(file, bytes);
        },
        rename: async (from: string, to: string) => {
          renames.push([from, to]);
          const name = to.split("/").at(-1)!;
          const stage = name === OG_IMAGE_FILE_NAME ? "current" : "legacy";
          if (mode === stage + "-rename-failure")
            throw new Error("rename failed");
          published.set(name, Buffer.from(pending.get(from)!));
        },
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
      vi.doMock("../src/og-card-fonts.ts", () => ({
        loadCardFonts: async () => [],
      }));
      vi.doMock("satori", () => ({
        default: async () => {
          if (mode === "render-failure")
            throw new Error("renderer unavailable");
          return "svg";
        },
      }));
      vi.doMock("@resvg/resvg-js", () => ({
        Resvg: class {
          render() {
            return { asPng: () => png };
          }
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
      assert.equal(result.renderer_version, CARD_VERSION);
      if (mode === "success" || mode === "missing-summary") {
        assert.equal(result.status, "rendered");
        assert.equal(
          result.sha256,
          createHash("sha256").update(png).digest("hex"),
        );
        assert.equal(result.stat_line, mode === "success" ? "128 subnets" : "");
        assert.deepEqual(
          result.artifact_paths,
          OG_IMAGE_FILE_NAMES.map((name) => `/metagraph/${name}`),
        );
        for (const name of OG_IMAGE_FILE_NAMES)
          assert.deepEqual(published.get(name), png);
        assert.deepEqual(
          renames,
          writes.map((file) => [file, file.replace(/\.pending$/, "")]),
        );
        assert.ok(writes[0].endsWith("og-image.png.pending"));
        assert.ok(writes[1].endsWith(OG_IMAGE_FILE_NAME + ".pending"));
      } else {
        assert.equal(result.status, "skipped");
        assert.equal(result.sha256, undefined);
        assert.equal(
          published.get(OG_IMAGE_FILE_NAME)!.toString(),
          "prior-" + OG_IMAGE_FILE_NAME,
        );
        if (mode.startsWith("current"))
          assert.deepEqual(published.get("og-image.png"), png);
        if (mode === "render-failure") assert.deepEqual(writes, []);
      }
    },
  );
});
