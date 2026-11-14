import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, stat, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const baselinePaths = [
  "20261105000100_modern_core.sql",
  "20261105000200_durable_work.sql",
  "20261105000300_service_registry.sql",
] as const;
const manifestMaximum = 8192;
const fileMaximum = 1024 * 1024;
const baselineDescriptor = {
  paths: baselinePaths,
  format: "metagraphed.postgres-fixture.v1",
  schemaContract: 1,
} as const;
const servingDescriptor = {
  paths: ["serving-contract.sql"],
  format: "metagraphed.postgres-serving-fixture.v1",
  schemaContract: 5,
  baselineFixtureSha256:
    "21739945180cd5c610f4ceb40775f380bb6ecf0c3721ebf3b86eebc491504795",
} as const;

function signature(value: BigIntStats) {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.nlink,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");
}

function utf8(bytes: Buffer) {
  const value = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  assert.ok(
    !value.includes("\0") && !value.startsWith("\ufeff"),
    "Fixture must contain plain UTF-8 bytes",
  );
  assert.ok(
    Buffer.from(value, "utf8").equals(bytes),
    "Fixture UTF-8 bytes must round-trip without normalization",
  );
  return value;
}

function directoryPath(directory: string | URL) {
  if (directory instanceof URL) {
    assert.ok(
      directory.protocol === "file:" &&
        directory.hostname === "" &&
        directory.search === "" &&
        directory.hash === "",
      "Fixture directory must be a local file URL",
    );
    return resolve(fileURLToPath(directory));
  }
  assert.ok(
    directory.length > 0 &&
      !directory.includes("\0") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(directory),
    "Fixture directory must be a local path",
  );
  return resolve(directory);
}

async function unlinkedDirectory(root: string) {
  const anchor = parse(root).root;
  let current = anchor;
  const ancestry = [];
  for (const part of [
    "",
    ...root.slice(anchor.length).split("/").filter(Boolean),
  ]) {
    if (part !== "") current = join(current, part);
    const info = await lstat(current, { bigint: true });
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      "Fixture directory must not traverse a link or non-directory",
    );
    ancestry.push({
      path: current,
      dev: info.dev,
      ino: info.ino,
      ...(current === root ? { rootSignature: signature(info) } : {}),
    });
  }
  return ancestry;
}

async function boundedFile(root: string, name: string, maximum: number) {
  const path = join(root, name);
  const named = await lstat(path, { bigint: true });
  assert.ok(
    named.isFile() && !named.isSymbolicLink() && named.nlink === 1n,
    "Fixture requires independent regular files",
  );
  assert.ok(
    named.size > 0n && named.size <= BigInt(maximum),
    "Fixture file exceeds its size bounds",
  );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    assert.equal(signature(before), signature(named), "Fixture file changed");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    assert.equal(BigInt(length), before.size, "Fixture read was incomplete");
    assert.equal(
      signature(await file.stat({ bigint: true })),
      signature(before),
      "Fixture file changed during reading",
    );
    assert.equal(
      signature(await lstat(path, { bigint: true })),
      signature(before),
      "Fixture pathname changed during reading",
    );
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function entries(root: string, maximum: number) {
  const directory = await opendir(root, { bufferSize: maximum + 1 });
  try {
    const names = [];
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      assert.ok(
        names.length < maximum,
        "Fixture inventory exceeds its reviewed-file bound",
      );
      names.push(entry.name);
    }
    return names.sort();
  } finally {
    await directory.close();
  }
}

async function descriptorRoot(handle: FileHandle, before: BigIntStats) {
  // These kernel-owned names resolve the held directory independently of its
  // original ancestors. Darwin has no usable /dev/fd/<fd>/child traversal.
  let alias: string;
  if (process.platform === "linux") alias = `/proc/self/fd/${handle.fd}`;
  else if (process.platform === "darwin")
    alias = `/.vol/${before.dev}/${before.ino}`;
  else throw new Error("Fixture descriptor-root capability is unsupported");
  const located = await stat(alias, { bigint: true });
  assert.ok(
    located.isDirectory(),
    "Fixture descriptor root must be a directory",
  );
  // Intermediate parents may receive unrelated siblings. Pin their identity;
  // the final fixture leaf receives the separate full-signature checks below.
  assert.equal(
    located.dev,
    before.dev,
    "Fixture descriptor root does not identify the held directory",
  );
  assert.equal(
    located.ino,
    before.ino,
    "Fixture descriptor root does not identify the held directory",
  );
  return alias;
}

async function openedDirectory(
  path: string,
  named?: BigIntStats,
  final = false,
) {
  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      constants.O_DIRECTORY,
  );
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isDirectory(), "Fixture directory required");
    if (named) {
      assert.equal(before.dev, named.dev, "Fixture path component changed");
      assert.equal(before.ino, named.ino, "Fixture path component changed");
      if (final)
        assert.equal(
          signature(before),
          signature(named),
          "Fixture directory changed",
        );
    }
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function acquireDirectory(
  root: string,
  expected: { dev: bigint; ino: bigint; rootSignature?: string },
) {
  const anchor = parse(root).root;
  const parts = root.slice(anchor.length).split("/").filter(Boolean);
  let held = await openedDirectory(anchor);
  try {
    for (const [index, part] of parts.entries()) {
      const parent = held;
      const alias = await descriptorRoot(parent.handle, parent.before);
      const child = join(alias, part);
      const named = await lstat(child, { bigint: true });
      assert.ok(
        named.isDirectory() && !named.isSymbolicLink(),
        "Fixture path component must be a directory without links",
      );
      held = await openedDirectory(child, named, index === parts.length - 1);
      await parent.handle.close();
    }
    assert.equal(
      held.before.dev,
      expected.dev,
      "Fixture directory differs from initial ancestry leaf",
    );
    assert.equal(
      held.before.ino,
      expected.ino,
      "Fixture directory differs from initial ancestry leaf",
    );
    assert.equal(
      signature(held.before),
      expected.rootSignature,
      "Fixture directory differs from initial ancestry leaf",
    );
    return held;
  } catch (error) {
    await held.handle.close();
    throw error;
  }
}

// This verifies a generated public projection, not equality to private canonical
// migrations. Native package admission owns that comparison against its inputs.
async function loadFixture(
  directory: string | URL,
  descriptor: typeof baselineDescriptor | typeof servingDescriptor,
): Promise<{
  manifestSha256: string;
  manifestBytes: Buffer;
  files: { path: string; bytes: Buffer }[];
}> {
  const { paths } = descriptor;
  const inventory = [...paths, "manifest.json"].sort();
  const manifestSchema = z
    .object({
      ...("baselineFixtureSha256" in descriptor
        ? {
            baseline_fixture_sha256: z.literal(
              descriptor.baselineFixtureSha256,
            ),
          }
        : {}),
      files: z
        .array(
          z
            .object({
              path: z.enum(paths),
              sha256: z.string().regex(/^[0-9a-f]{64}$/),
              size_bytes: z.int().min(1).max(fileMaximum),
            })
            .strict(),
        )
        .length(paths.length),
      format: z.literal(descriptor.format),
      schema_contract: z.literal(descriptor.schemaContract),
    })
    .strict();
  const root = directoryPath(directory);
  const ancestry = await unlinkedDirectory(root);
  const expected = ancestry.at(-1);
  assert.ok(expected, "Fixture ancestry must include its filesystem root");
  const { handle, before } = await acquireDirectory(root, expected);
  try {
    const pinned = await descriptorRoot(handle, before);
    assert.deepEqual(
      await entries(pinned, inventory.length),
      inventory,
      "Fixture inventory must contain exactly the reviewed files and manifest",
    );
    const manifestBytes = await boundedFile(
      pinned,
      "manifest.json",
      manifestMaximum,
    );
    const manifest = manifestSchema.parse(JSON.parse(utf8(manifestBytes)));
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      paths,
      "Fixture migration paths must be unique and sorted",
    );
    const canonical = Buffer.from(
      JSON.stringify({
        ...("baselineFixtureSha256" in descriptor
          ? { baseline_fixture_sha256: descriptor.baselineFixtureSha256 }
          : {}),
        files: manifest.files.map(({ path, sha256, size_bytes }) => ({
          path,
          sha256,
          size_bytes,
        })),
        format: manifest.format,
        schema_contract: manifest.schema_contract,
      }) + "\n",
      "utf8",
    );
    assert.ok(
      canonical.equals(manifestBytes),
      "Fixture manifest must be canonical, duplicate-free JSON with one newline",
    );
    const files = [];
    for (const entry of manifest.files) {
      const bytes = await boundedFile(pinned, entry.path, fileMaximum);
      assert.equal(
        bytes.length,
        entry.size_bytes,
        "Fixture size differs from manifest",
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        entry.sha256,
        "Fixture digest differs from manifest",
      );
      utf8(bytes);
      files.push({ path: entry.path, bytes });
    }
    assert.deepEqual(
      await entries(pinned, inventory.length),
      inventory,
      "Fixture inventory changed during reading",
    );
    assert.deepEqual(
      await unlinkedDirectory(root),
      ancestry,
      "Fixture directory ancestry changed during reading",
    );
    assert.equal(
      signature(await handle.stat({ bigint: true })),
      signature(before),
      "Fixture directory changed during reading",
    );
    assert.equal(
      signature(await lstat(root, { bigint: true })),
      signature(before),
      "Fixture directory pathname changed during reading",
    );
    return {
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      manifestBytes,
      files,
    };
  } finally {
    await handle.close();
  }
}

export function loadModernPostgresFixture(
  directory: string | URL = new URL(
    "../../tests/fixtures/modern-postgres/",
    import.meta.url,
  ),
) {
  return loadFixture(directory, baselineDescriptor);
}

// Synthetic serving relations are versioned separately from the retained
// migration corpus. They do not issue or qualify native producer publications.
export async function loadModernServingFixture(
  directory: string | URL = new URL(
    "../../tests/fixtures/modern-serving/",
    import.meta.url,
  ),
) {
  return {
    ...(await loadFixture(directory, servingDescriptor)),
    baselineFixtureSha256: servingDescriptor.baselineFixtureSha256,
  };
}
