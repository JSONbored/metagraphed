import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  loadModernPostgresFixture,
  loadModernServingFixture,
} from "../scripts/lib/modern-postgres-fixture.ts";

const fileHook = vi.hoisted(() => ({
  path: undefined as string | undefined,
  fired: 0,
  afterOpen: undefined as
    | ((handle: import("node:fs/promises").FileHandle) => Promise<void>)
    | undefined,
  beforeLstatPath: undefined as string | undefined,
  beforeLstat: undefined as (() => Promise<void>) | undefined,
  lstatFired: 0,
  afterLstatPath: undefined as string | undefined,
  afterLstat: undefined as (() => Promise<void>) | undefined,
  afterLstatFired: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fileHook.path && fileHook.afterOpen) {
        try {
          // The helper opens through a descriptor-root alias. Match the actual
          // inode, not its spelling, so physical mutation coverage cannot vanish.
          const wanted = await actual.lstat(fileHook.path, { bigint: true });
          const opened = await handle.stat({ bigint: true });
          if (wanted.dev === opened.dev && wanted.ino === opened.ino) {
            const callback = fileHook.afterOpen;
            fileHook.path = undefined;
            fileHook.fired++;
            await callback(handle);
          }
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return handle;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === fileHook.beforeLstatPath && fileHook.beforeLstat) {
        const callback = fileHook.beforeLstat;
        fileHook.beforeLstatPath = undefined;
        fileHook.lstatFired++;
        await callback();
      }
      const result = await actual.lstat(...args);
      if (args[0] === fileHook.afterLstatPath && fileHook.afterLstat) {
        const callback = fileHook.afterLstat;
        fileHook.afterLstatPath = undefined;
        fileHook.afterLstatFired++;
        await callback();
      }
      return result;
    },
  };
});

type Manifest = {
  baseline_fixture_sha256?: string;
  files: { path: string; sha256: string; size_bytes: number }[];
  format: string;
  schema_contract: number;
};
let baseline: Awaited<ReturnType<typeof loadModernPostgresFixture>>;
let serving: Awaited<ReturnType<typeof loadModernServingFixture>>;
const roots: string[] = [];
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("separately versioned public PostgreSQL serving fixture", () => {
  test("binds the unchanged baseline and loads one exact independent SQL file", async () => {
    const { root } = await fixture(serving);
    const loaded = await loadModernServingFixture(pathToFileURL(root));
    expect(loaded.manifestBytes).toEqual(serving.manifestBytes);
    expect(loaded.files).toEqual(serving.files);
    expect(loaded.files[0]!.bytes).not.toBe(serving.files[0]!.bytes);
    expect(loaded.files.map((file) => file.path)).toEqual([
      "serving-contract.sql",
    ]);
    expect(loaded.manifestSha256).toBe(hash(loaded.manifestBytes));
    const manifest = JSON.parse(
      loaded.manifestBytes.toString("utf8"),
    ) as Manifest;
    expect(manifest.baseline_fixture_sha256).toBe(baseline.manifestSha256);
    expect(loaded.baselineFixtureSha256).toBe(baseline.manifestSha256);
    expect(baseline.manifestSha256).toBe(
      "21739945180cd5c610f4ceb40775f380bb6ecf0c3721ebf3b86eebc491504795",
    );
    expect(manifest.schema_contract).toBe(4);
    expect(loaded.manifestBytes.toString("utf8")).toBe(canonical(manifest));
  });

  test("never admits either artifact as the other fixture", async () => {
    const original = await fixture();
    const modern = await fixture(serving);
    await expect(loadModernPostgresFixture(modern.root)).rejects.toThrow();
    await expect(loadModernServingFixture(original.root)).rejects.toThrow();
  });

  test.each([
    [
      "baseline mismatch",
      (m: Manifest) => {
        m.baseline_fixture_sha256 = "f".repeat(64);
      },
    ],
    [
      "missing baseline",
      (m: Manifest) => {
        delete m.baseline_fixture_sha256;
      },
    ],
    [
      "wrong format",
      (m: Manifest) => {
        m.format = "metagraphed.postgres-fixture.v1";
      },
    ],
    [
      "old contract",
      (m: Manifest) => {
        m.schema_contract = 1;
      },
    ],
    [
      "pre-normalization contract",
      (m: Manifest) => {
        m.schema_contract = 2;
      },
    ],
    [
      "pre-stake contract",
      (m: Manifest) => {
        m.schema_contract = 3;
      },
    ],
    [
      "missing file",
      (m: Manifest) => {
        m.files = [];
      },
    ],
    [
      "duplicate file",
      (m: Manifest) => {
        m.files.push({ ...m.files[0]! });
      },
    ],
    [
      "other path",
      (m: Manifest) => {
        m.files[0]!.path = "other.sql";
      },
    ],
    [
      "escaping path",
      (m: Manifest) => {
        m.files[0]!.path = "../serving-contract.sql";
      },
    ],
    [
      "size mismatch",
      (m: Manifest) => {
        m.files[0]!.size_bytes++;
      },
    ],
    [
      "oversized file",
      (m: Manifest) => {
        m.files[0]!.size_bytes = 1048577;
      },
    ],
    [
      "digest mismatch",
      (m: Manifest) => {
        m.files[0]!.sha256 = "f".repeat(64);
      },
    ],
    [
      "extra field",
      (m: Manifest) => {
        Object.assign(m, { extra: true });
      },
    ],
  ] as const)("refuses %s", async (_name, mutate) => {
    const { root, manifest } = await fixture(serving);
    mutate(manifest);
    await fs.writeFile(join(root, "manifest.json"), canonical(manifest));
    await expect(loadModernServingFixture(root)).rejects.toThrow();
  });

  test.each([
    [
      "duplicate baseline",
      (s: string) =>
        s.replace(
          '"baseline_fixture_sha256":',
          '"baseline_fixture_sha256":"' +
            "0".repeat(64) +
            '","baseline_fixture_sha256":',
        ),
    ],
    [
      "duplicate file key",
      (s: string) => s.replace('"path":', '"path":"other.sql","path":'),
    ],
    [
      "pretty JSON",
      (s: string) => JSON.stringify(JSON.parse(s), null, 2) + "\n",
    ],
    ["no newline", (s: string) => s.slice(0, -1)],
    ["malformed JSON", () => "{\n"],
  ] as const)("refuses %s without normalization", async (_name, mutate) => {
    const { root } = await fixture(serving);
    await fs.writeFile(
      join(root, "manifest.json"),
      mutate(serving.manifestBytes.toString("utf8")),
    );
    await expect(loadModernServingFixture(root)).rejects.toThrow();
  });

  test.each(["manifest.json", "serving-contract.sql"])(
    "refuses missing %s",
    async (name) => {
      const { root } = await fixture(serving);
      await fs.unlink(join(root, name));
      await expect(loadModernServingFixture(root)).rejects.toThrow(/inventory/);
    },
  );

  test.each(["file", "directory"])("refuses an extra %s", async (kind) => {
    const { root } = await fixture(serving);
    if (kind === "file") await fs.writeFile(join(root, "extra"), "extra");
    else await fs.mkdir(join(root, "extra"));
    await expect(loadModernServingFixture(root)).rejects.toThrow(/inventory/);
  });

  test.each([
    ["symlink", "serving-contract.sql"],
    ["hardlink", "serving-contract.sql"],
    ["directory", "serving-contract.sql"],
    ["fifo", "serving-contract.sql"],
    ["symlink", "manifest.json"],
    ["hardlink", "manifest.json"],
  ])("refuses a %s backing %s", async (kind, name) => {
    const { root, owner } = await fixture(serving);
    const path = join(root, name),
      target = join(owner, "original");
    await fs.rename(path, target);
    if (kind === "symlink") await fs.symlink(target, path);
    else if (kind === "hardlink") await fs.link(target, path);
    else if (kind === "directory") await fs.mkdir(path);
    else execFileSync("mkfifo", [path], { timeout: 2000, stdio: "ignore" });
    await expect(loadModernServingFixture(root)).rejects.toThrow(
      /regular files/,
    );
  });

  test("refuses changed SQL bytes, including a physical change after opening", async () => {
    const { root, first } = await fixture(serving);
    const changed = Buffer.from(serving.files[0]!.bytes);
    changed[0] = changed[0]! ^ 1;
    await fs.writeFile(join(root, first), changed);
    await expect(loadModernServingFixture(root)).rejects.toThrow(/digest/);
    await fs.writeFile(join(root, first), serving.files[0]!.bytes);
    fileHook.path = join(root, first);
    fileHook.afterOpen = async () => {
      await fs.appendFile(join(root, first), "\n");
    };
    await expect(loadModernServingFixture(root)).rejects.toThrow(
      /file changed/,
    );
    expect(fileHook.fired).toBe(1);
  });
});

function canonical(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)]),
      );
    return item;
  }
  return JSON.stringify(sorted(value)) + "\n";
}

async function fixture(source = baseline) {
  const owner = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "metagraphed-modern-postgres-")),
  );
  roots.push(owner);
  const root = join(owner, "fixture");
  await fs.mkdir(root);
  await fs.writeFile(join(root, "manifest.json"), source.manifestBytes);
  for (const file of source.files)
    await fs.writeFile(join(root, file.path), file.bytes);
  const manifest = JSON.parse(
    source.manifestBytes.toString("utf8"),
  ) as Manifest;
  return { owner, root, manifest, first: source.files[0]!.path };
}

beforeAll(async () => {
  // The native exporter owns this actual reviewed corpus. Negative tests mutate
  // copies; they do not maintain an alternative SQL implementation.
  baseline = await loadModernPostgresFixture();
  serving = await loadModernServingFixture();
});
afterEach(async () => {
  fileHook.path = undefined;
  fileHook.fired = 0;
  fileHook.afterOpen = undefined;
  fileHook.beforeLstatPath = undefined;
  fileHook.beforeLstat = undefined;
  fileHook.lstatFired = 0;
  fileHook.afterLstatPath = undefined;
  fileHook.afterLstat = undefined;
  fileHook.afterLstatFired = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("generated modern PostgreSQL conformance fixture", () => {
  test("loads exact independent bytes through the fixed default and a local directory URL", async () => {
    const { root } = await fixture();
    const loaded = await loadModernPostgresFixture(pathToFileURL(root));
    expect(loaded.manifestBytes).toEqual(baseline.manifestBytes);
    expect(loaded.manifestSha256).toBe(hash(baseline.manifestBytes));
    expect(loaded.files.map((file) => file.path)).toEqual([
      "20261105000100_modern_core.sql",
      "20261105000200_durable_work.sql",
      "20261105000300_service_registry.sql",
    ]);
    expect(
      loaded.files.reduce((total, file) => total + file.bytes.length, 0),
    ).toBe(33234);
    for (const [index, file] of loaded.files.entries()) {
      expect(file.bytes).toEqual(baseline.files[index]!.bytes);
      expect(file.bytes).not.toBe(baseline.files[index]!.bytes);
    }
    expect(loaded.manifestBytes.toString("utf8")).toBe(
      canonical(JSON.parse(loaded.manifestBytes.toString("utf8"))),
    );
  });

  test.each([
    "",
    "https://example.com/fixture",
    "file:///tmp/fixture",
    "fixture\0path",
    new URL("https://example.com/fixture"),
    new URL("file://example.com/fixture"),
    new URL("file:///tmp/fixture#override"),
    new URL("file:///tmp/fixture?override=1"),
  ])("refuses a remote or ambiguous directory input %s", async (directory) => {
    await expect(loadModernPostgresFixture(directory)).rejects.toThrow();
  });

  test.each([
    [
      "wrong format",
      (manifest: Manifest) => {
        manifest.format = "other";
      },
    ],
    [
      "wrong schema",
      (manifest: Manifest) => {
        manifest.schema_contract = 2;
      },
    ],
    [
      "duplicate path",
      (manifest: Manifest) => {
        manifest.files[1]!.path = manifest.files[0]!.path;
      },
    ],
    [
      "unsorted paths",
      (manifest: Manifest) => {
        manifest.files.reverse();
      },
    ],
    [
      "escaping path",
      (manifest: Manifest) => {
        manifest.files[0]!.path = "../outside.sql";
      },
    ],
    [
      "missing entry",
      (manifest: Manifest) => {
        manifest.files.pop();
      },
    ],
    [
      "wrong size",
      (manifest: Manifest) => {
        manifest.files[0]!.size_bytes++;
      },
    ],
    [
      "unbounded size",
      (manifest: Manifest) => {
        manifest.files[0]!.size_bytes = 1048577;
      },
    ],
    [
      "fractional size",
      (manifest: Manifest) => {
        manifest.files[0]!.size_bytes = 1.5;
      },
    ],
    [
      "wrong digest",
      (manifest: Manifest) => {
        manifest.files[0]!.sha256 = "f".repeat(64);
      },
    ],
    [
      "noncanonical digest",
      (manifest: Manifest) => {
        manifest.files[0]!.sha256 = "A".repeat(64);
      },
    ],
    [
      "extra field",
      (manifest: Manifest) => {
        Object.assign(manifest, { unexpected: true });
      },
    ],
  ] as const)("refuses manifest %s", async (_name, mutate) => {
    const { root, manifest } = await fixture();
    mutate(manifest);
    await fs.writeFile(join(root, "manifest.json"), canonical(manifest));
    await expect(loadModernPostgresFixture(root)).rejects.toThrow();
  });

  test.each([
    [
      "duplicate root key",
      (text: string) =>
        text.replace(
          '"format":',
          '"format":"metagraphed.postgres-fixture.v1","format":',
        ),
    ],
    [
      "duplicate file key",
      (text: string) =>
        text.replace(
          '"sha256":',
          '"sha256":"' + "f".repeat(64) + '","sha256":',
        ),
    ],
    [
      "pretty JSON",
      (text: string) => JSON.stringify(JSON.parse(text), null, 2) + "\n",
    ],
    ["missing newline", (text: string) => text.slice(0, -1)],
    ["extra newline", (text: string) => text + "\n"],
    ["malformed JSON", () => "{\n"],
  ] as const)(
    "refuses %s without normalizing the manifest",
    async (_name, mutate) => {
      const { root } = await fixture();
      await fs.writeFile(
        join(root, "manifest.json"),
        mutate(baseline.manifestBytes.toString("utf8")),
      );
      await expect(loadModernPostgresFixture(root)).rejects.toThrow();
    },
  );

  test.each([
    "manifest.json",
    ...[
      "20261105000100_modern_core.sql",
      "20261105000200_durable_work.sql",
      "20261105000300_service_registry.sql",
    ],
  ])("refuses a missing %s", async (name) => {
    const { root } = await fixture();
    await fs.unlink(join(root, name));
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(/inventory/);
  });

  test.each(["file", "directory"])("refuses an unexpected %s", async (kind) => {
    const { root } = await fixture();
    if (kind === "file") await fs.writeFile(join(root, "unexpected"), "extra");
    else await fs.mkdir(join(root, "unexpected"));
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(/inventory/);
  });

  test.each([
    ["symlink", "20261105000100_modern_core.sql"],
    ["hardlink", "20261105000100_modern_core.sql"],
    ["directory", "20261105000100_modern_core.sql"],
    ["fifo", "20261105000100_modern_core.sql"],
    ["symlink", "manifest.json"],
    ["hardlink", "manifest.json"],
    ["directory", "manifest.json"],
    ["fifo", "manifest.json"],
  ])("refuses a %s backing %s", async (kind, name) => {
    const { owner, root } = await fixture();
    const path = join(root, name);
    const target = join(owner, "original");
    await fs.rename(path, target);
    if (kind === "symlink") await fs.symlink(target, path);
    else if (kind === "hardlink") await fs.link(target, path);
    else if (kind === "directory") await fs.mkdir(path);
    else execFileSync("mkfifo", [path], { timeout: 2000, stdio: "ignore" });
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(
      /regular files/,
    );
  });

  test("refuses a linked fixture directory or directory ancestor", async () => {
    const { owner, root } = await fixture();
    const alias = join(owner, "alias");
    await fs.symlink(root, alias);
    await expect(loadModernPostgresFixture(alias)).rejects.toThrow(/link/);
    const parent = join(owner, "parent");
    await fs.symlink(owner, parent);
    await expect(
      loadModernPostgresFixture(join(parent, "fixture")),
    ).rejects.toThrow(/link/);
  });

  test.each([
    ["empty manifest", "manifest.json", 0],
    ["oversized manifest", "manifest.json", 8193],
    ["empty migration", "20261105000100_modern_core.sql", 0],
    ["oversized migration", "20261105000100_modern_core.sql", 1048577],
  ] as const)("refuses an %s", async (_name, path, size) => {
    const { root } = await fixture();
    await fs.writeFile(join(root, path), Buffer.alloc(size, 0x20));
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(
      /size bounds/,
    );
  });

  test("refuses altered migration bytes with the original manifest", async () => {
    const { root, first } = await fixture();
    const bytes = Buffer.from(baseline.files[0]!.bytes);
    bytes[0] = bytes[0]! ^ 1;
    await fs.writeFile(join(root, first), bytes);
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(/digest/);
  });

  test.each([
    ["invalid UTF-8", Buffer.from([0xff])],
    ["NUL", Buffer.from([0])],
    ["BOM", Buffer.from("\ufeff", "utf8")],
  ] as const)(
    "refuses migration %s even when its size and digest match",
    async (_name, prefix) => {
      const { root, first, manifest } = await fixture();
      const bytes = Buffer.concat([prefix, baseline.files[0]!.bytes]);
      await fs.writeFile(join(root, first), bytes);
      manifest.files[0]!.size_bytes = bytes.length;
      manifest.files[0]!.sha256 = hash(bytes);
      await fs.writeFile(join(root, "manifest.json"), canonical(manifest));
      await expect(loadModernPostgresFixture(root)).rejects.toThrow();
    },
  );

  test.each([
    ["invalid UTF-8", Buffer.from([0xff])],
    ["NUL", Buffer.from([0])],
    ["BOM", Buffer.from("\ufeff", "utf8")],
  ] as const)(
    "refuses manifest %s without stripping or repairing bytes",
    async (_name, prefix) => {
      const { root } = await fixture();
      await fs.writeFile(
        join(root, "manifest.json"),
        Buffer.concat([prefix, baseline.manifestBytes]),
      );
      await expect(loadModernPostgresFixture(root)).rejects.toThrow();
    },
  );

  test("refuses a physical file changed between pathname admission and descriptor admission", async () => {
    const { root, first } = await fixture();
    fileHook.path = join(root, first);
    fileHook.afterOpen = async () => {
      await fs.appendFile(join(root, first), "\n");
    };
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(
      /file changed/,
    );
    expect(fileHook.fired).toBe(1);
  });

  test("refuses a short descriptor read", async () => {
    const { root, first } = await fixture();
    fileHook.path = join(root, first);
    fileHook.afterOpen = async (handle) => {
      vi.spyOn(handle, "read").mockResolvedValue({
        bytesRead: 0,
        buffer: Buffer.alloc(0),
      });
    };
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(/incomplete/);
    expect(fileHook.fired).toBe(1);
  });

  test("refuses descriptor identity drift after reading", async () => {
    const { root, first } = await fixture();
    fileHook.path = join(root, first);
    fileHook.afterOpen = async (handle) => {
      const before = await handle.stat({ bigint: true });
      const changed = Object.assign(Object.create(before) as typeof before, {
        ino: before.ino + 1n,
      });
      vi.spyOn(handle, "stat")
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(changed);
    };
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(
      /changed during reading/,
    );
    expect(fileHook.fired).toBe(1);
  });

  test("refuses directory inventory mutation during a file read", async () => {
    const { root, first } = await fixture();
    fileHook.path = join(root, first);
    fileHook.afterOpen = async () => {
      await fs.writeFile(join(root, "unexpected"), "extra");
    };
    await expect(loadModernPostgresFixture(root)).rejects.toThrow(/inventory/);
    expect(fileHook.fired).toBe(1);
  });

  test("allows unrelated sibling activity without weakening the held directory checks", async () => {
    const { owner, root, first } = await fixture();
    fileHook.path = join(root, first);
    fileHook.afterOpen = async () => {
      await fs.mkdir(join(owner, "sibling"));
    };
    const loaded = await loadModernPostgresFixture(root);
    expect(fileHook.fired).toBe(1);
    expect(loaded.manifestBytes).toEqual(baseline.manifestBytes);
    expect(loaded.files).toEqual(baseline.files);
  });

  test("keeps the held corpus through an ancestor rename-to-symlink ABA and never accepts the alternate corpus", async () => {
    const { owner, root: initial, first, manifest } = await fixture();
    const ancestor = join(owner, "ancestor");
    const saved = join(owner, "saved-ancestor");
    const alternateParent = join(owner, "alternate");
    await fs.mkdir(ancestor);
    const root = join(ancestor, "fixture");
    await fs.rename(initial, root);
    await fs.mkdir(alternateParent);
    const alternate = join(alternateParent, "fixture");
    await fs.mkdir(alternate);
    for (const file of baseline.files)
      await fs.writeFile(join(alternate, file.path), file.bytes);
    const changed = Buffer.concat([
      baseline.files[0]!.bytes,
      Buffer.from(
        "\n-- Alternate corpus used only for the custody attack fixture.\n",
      ),
    ]);
    await fs.writeFile(join(alternate, first), changed);
    manifest.files[0]!.sha256 = hash(changed);
    manifest.files[0]!.size_bytes = changed.length;
    await fs.writeFile(join(alternate, "manifest.json"), canonical(manifest));
    const alternateValue = await loadModernPostgresFixture(alternate);
    expect(alternateValue.manifestSha256).not.toBe(baseline.manifestSha256);
    expect(alternateValue.files[0]!.bytes).toEqual(changed);

    let swapped = false;
    let restored = false;
    const restore = async () => {
      await fs.unlink(ancestor);
      await fs.rename(saved, ancestor);
      restored = true;
    };
    fileHook.path = root;
    fileHook.afterOpen = async () => {
      // The original directory is already held. Substitute every absolute child
      // pathname until the final original-ancestry check, then restore that path.
      await fs.rename(ancestor, saved);
      await fs.symlink(alternateParent, ancestor);
      swapped = true;
      fileHook.beforeLstatPath = ancestor;
      fileHook.beforeLstat = restore;
    };
    const loaded = await loadModernPostgresFixture(root).finally(async () => {
      fileHook.beforeLstatPath = undefined;
      fileHook.beforeLstat = undefined;
      if (swapped && !restored) await restore();
    });
    expect(fileHook.fired).toBe(1);
    expect(fileHook.lstatFired).toBe(1);
    expect(swapped).toBe(true);
    expect(restored).toBe(true);
    expect(loaded.manifestBytes).toEqual(baseline.manifestBytes);
    expect(loaded.manifestSha256).toBe(baseline.manifestSha256);
    expect(loaded.manifestSha256).not.toBe(alternateValue.manifestSha256);
    expect(loaded.files).toEqual(baseline.files);
    expect(loaded.files[0]!.bytes).not.toEqual(changed);
  });

  test.each(["directory", "symlink"])(
    "refuses a pre-open %s substitution even with a final ancestry ABA scheduled",
    async (kind) => {
      const { owner, root: initial, first, manifest } = await fixture();
      const ancestor = join(owner, "ancestor");
      const saved = join(owner, "saved-ancestor");
      const alternateParent = join(owner, "alternate");
      await fs.mkdir(ancestor);
      const root = join(ancestor, "fixture");
      await fs.rename(initial, root);
      await fs.mkdir(alternateParent);
      const alternate = join(alternateParent, "fixture");
      await fs.mkdir(alternate);
      for (const file of baseline.files)
        await fs.writeFile(join(alternate, file.path), file.bytes);
      const changed = Buffer.concat([
        baseline.files[0]!.bytes,
        Buffer.from("\n-- Alternate pre-open custody attack corpus.\n"),
      ]);
      await fs.writeFile(join(alternate, first), changed);
      manifest.files[0]!.sha256 = hash(changed);
      manifest.files[0]!.size_bytes = changed.length;
      await fs.writeFile(join(alternate, "manifest.json"), canonical(manifest));
      const alternateValue = await loadModernPostgresFixture(alternate);
      expect(alternateValue.manifestSha256).not.toBe(baseline.manifestSha256);
      expect(alternateValue.files[0]!.bytes).toEqual(changed);

      let active = false;
      const swap = async () => {
        await fs.rename(ancestor, saved);
        if (kind === "directory") await fs.rename(alternateParent, ancestor);
        else await fs.symlink(alternateParent, ancestor);
        active = true;
      };
      const restore = async () => {
        if (!active) return;
        if (kind === "directory") await fs.rename(ancestor, alternateParent);
        else await fs.unlink(ancestor);
        await fs.rename(saved, ancestor);
        active = false;
      };
      fileHook.afterLstatPath = root;
      fileHook.afterLstat = async () => {
        // Return the original leaf's captured stat, but replace its ancestors
        // before acquisition. A later A→B switch after the final ancestry walk
        // would also defeat a pathname-only final check without the new gate.
        await swap();
        fileHook.beforeLstatPath = ancestor;
        fileHook.beforeLstat = async () => {
          await restore();
          fileHook.afterLstatPath = root;
          fileHook.afterLstat = swap;
        };
      };
      try {
        await expect(loadModernPostgresFixture(root)).rejects.toThrow(
          kind === "directory"
            ? /differs from initial ancestry leaf/
            : /path component must be a directory without links/,
        );
      } finally {
        fileHook.beforeLstatPath = undefined;
        fileHook.beforeLstat = undefined;
        fileHook.afterLstatPath = undefined;
        fileHook.afterLstat = undefined;
        await restore();
      }
      expect(fileHook.afterLstatFired).toBe(1);
      expect(fileHook.lstatFired).toBe(0);
      expect(active).toBe(false);
      const original = await loadModernPostgresFixture(root);
      expect(original.manifestBytes).toEqual(baseline.manifestBytes);
      expect(original.manifestSha256).not.toBe(alternateValue.manifestSha256);
      expect(original.files).toEqual(baseline.files);
    },
  );
});
