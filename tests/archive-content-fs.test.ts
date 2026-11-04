import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { afterEach, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFilesystemArchiveContent } from "../src/archive-content-fs.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
  };
});
const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
  vi.mocked(fs.link).mockReset().mockImplementation(actualFs.link);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actualFs.unlink);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
async function fixture(bounds = {}) {
  const directory = await mkdtemp(join(tmpdir(), "metagraphed-content-"));
  directories.push(directory);
  const options = {
    directory,
    maxConcurrentOperations: 2,
    maxChunkBytes: 1024,
    ...bounds,
  };
  return {
    directory,
    options,
    store: await createFilesystemArchiveContent(options),
  };
}

test("publishes verified immutable chunks and returns exact bytes after reopening", async () => {
  const { directory, store, options } = await fixture();
  const bytes = Buffer.from([0, 1, 2, 255]);
  const id = sha(bytes);
  await store.publish(id, bytes, signal());
  const reopened = await createFilesystemArchiveContent(options);
  const response = await reopened.get(id, signal());
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("content-encoding"), "identity");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(await readFile(join(directory, `${id}.mgpack`)), bytes);
  await Promise.all([
    store.publish(id, bytes, signal()),
    store.publish(id, bytes, signal()),
  ]);
  assert.deepEqual(await readdir(directory), [`${id}.mgpack`]);
});

test("rejects invalid bounds, inaccessible directories and writable shared directories", async () => {
  const { directory, options } = await fixture();
  for (const bounds of [
    { maxConcurrentOperations: 0 },
    { maxConcurrentOperations: 65 },
    { maxConcurrentOperations: 1.1 },
    { maxChunkBytes: 0 },
    { maxChunkBytes: 524289 },
    { maxChunkBytes: NaN },
  ])
    await assert.rejects(
      createFilesystemArchiveContent({ ...options, ...bounds }),
      /bounds/,
    );
  await assert.rejects(
    createFilesystemArchiveContent({
      ...options,
      directory: join(directory, "missing"),
    }),
    /ENOENT/,
  );
  await chmod(directory, 0o777);
  await assert.rejects(createFilesystemArchiveContent(options), /owned/);
  await chmod(directory, 0o700);
});

test("rejects traversal, bad digests, invalid sizes and aborted work before file creation", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("content");
  for (const id of ["../escape", "A".repeat(64), "a".repeat(63), ""]) {
    await assert.rejects(store.get(id, signal()), /digest/);
    await assert.rejects(store.publish(id, bytes, signal()), /digest/);
  }
  await assert.rejects(
    store.get(
      { toString: () => "a".repeat(64) } as unknown as string,
      signal(),
    ),
    /digest/,
  );
  for (const value of [Buffer.alloc(0), Buffer.alloc(1025)])
    await assert.rejects(store.publish(sha(value), value, signal()), /bounds/);
  await assert.rejects(
    store.publish("a".repeat(64), bytes, signal()),
    /checksum/,
  );
  const controller = new AbortController();
  controller.abort(new Error("fixture aborted"));
  await assert.rejects(
    store.get(sha(bytes), controller.signal),
    /fixture aborted/,
  );
  await assert.rejects(
    store.publish(sha(bytes), bytes, controller.signal),
    /fixture aborted/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("missing, corrupt, oversized and symlinked files fail without serving fallback bytes", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("right");
  const id = sha(bytes),
    path = join(directory, `${id}.mgpack`);
  await assert.rejects(store.get(id, signal()), /ENOENT/);
  await writeFile(path, "wrong");
  await assert.rejects(store.get(id, signal()), /checksum/);
  await assert.rejects(store.publish(id, bytes, signal()), /checksum/);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  await writeFile(path, Buffer.alloc(1025));
  await assert.rejects(store.get(id, signal()), /bounds/);
  await writeFile(path, "");
  await assert.rejects(store.get(id, signal()), /bounds/);
  await rm(path);
  await symlink(join(directory, "missing"), path);
  await assert.rejects(store.get(id, signal()), /ELOOP/);
});

test("admission is bounded and released after failures", async () => {
  const { store } = await fixture({ maxConcurrentOperations: 1 });
  const id = "a".repeat(64);
  const first = store.get(id, signal());
  await assert.rejects(store.get(id, signal()), /capacity/);
  await assert.rejects(first, /ENOENT/);
  await assert.rejects(store.get(id, signal()), /ENOENT/);
});

test("directory validation rejects files and another owner's directory", async () => {
  const { directory, options } = await fixture();
  const file = join(directory, "ordinary-file");
  await writeFile(file, "data");
  await assert.rejects(
    createFilesystemArchiveContent({ ...options, directory: file }),
    /owned/,
  );
  const owner = process.getuid!();
  vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
  await assert.rejects(createFilesystemArchiveContent(options), /owned/);
});

test("growing and non-regular content is refused and aborted reads close their handle", async () => {
  const { directory, store } = await fixture();
  const bytes = Buffer.from("original bytes"),
    id = sha(bytes);
  await store.publish(id, bytes, signal());
  const originalOpen = actualFs.open;
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    const originalStat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => {
      const stat = await originalStat();
      stat.size = 1;
      return stat;
    });
    return file;
  });
  await assert.rejects(store.get(id, signal()), /checksum/);
  const controller = new AbortController();
  let closed = false;
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    const originalStat = file.stat.bind(file),
      originalClose = file.close.bind(file);
    vi.spyOn(file, "stat").mockImplementationOnce(async () => {
      controller.abort(new Error("aborted during read"));
      return originalStat();
    });
    vi.spyOn(file, "close").mockImplementationOnce(async () => {
      closed = true;
      await originalClose();
    });
    return file;
  });
  await assert.rejects(store.get(id, controller.signal), /aborted during read/);
  assert.equal(closed, true);
  await rm(join(directory, `${id}.mgpack`));
  await fs.mkdir(join(directory, `${id}.mgpack`));
  await assert.rejects(store.get(id, signal()), /bounds/);
});

test("write failure and mid-write cancellation never publish a destination", async () => {
  const { directory, store } = await fixture();
  const originalOpen = actualFs.open;
  const bytes = Buffer.from("publish me"),
    id = sha(bytes);
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    vi.spyOn(file, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    return file;
  });
  await assert.rejects(store.publish(id, bytes, signal()), /disk full/);
  assert.deepEqual(await readdir(directory), []);
  const controller = new AbortController();
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args),
      write = file.writeFile.bind(file);
    vi.spyOn(file, "writeFile").mockImplementationOnce(async (...params) => {
      await write(...params);
      controller.abort(new Error("aborted during write"));
    });
    return file;
  });
  await assert.rejects(
    store.publish(id, bytes, controller.signal),
    /aborted during write/,
  );
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(store.publish(id, {} as Uint8Array, signal()), /bounds/);
});

test("link and cleanup failures are reported without claiming successful publication", async () => {
  const { directory, store } = await fixture();
  const bytes = Buffer.from("publish me"),
    id = sha(bytes);
  vi.mocked(fs.link).mockRejectedValueOnce(
    Object.assign(new Error("link refused"), { code: "EACCES" }),
  );
  await assert.rejects(store.publish(id, bytes, signal()), /link refused/);
  assert.deepEqual(await readdir(directory), []);
  vi.mocked(fs.unlink).mockRejectedValue(
    Object.assign(new Error("cleanup refused"), { code: "EACCES" }),
  );
  await assert.rejects(store.publish(id, bytes, signal()), /cleanup refused/);
});

test("constructor snapshots its admission and chunk limits", async () => {
  const { options, store } = await fixture();
  options.maxChunkBytes = 1;
  options.maxConcurrentOperations = 0;
  const bytes = Buffer.from("retained constructor limits");
  await store.publish(sha(bytes), bytes, signal());
  assert.equal(
    await (await store.get(sha(bytes), signal())).text(),
    bytes.toString(),
  );
});

test("failed close cannot skip temporary cleanup or replace the original write failure", async () => {
  const { store, directory } = await fixture();
  const bytes = Buffer.from("cleanup fixture"),
    id = sha(bytes);
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await actualFs.open(...args),
      close = file.close.bind(file);
    vi.spyOn(file, "writeFile").mockRejectedValueOnce(
      new Error("primary write failure"),
    );
    vi.spyOn(file, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("secondary close failure");
    });
    return file;
  });
  await assert.rejects(
    store.publish(id, bytes, signal()),
    /primary write failure/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("a cleanup error after otherwise successful publication is reported", async () => {
  const { store } = await fixture();
  const bytes = Buffer.from("post-publication cleanup"),
    id = sha(bytes);
  vi.mocked(fs.unlink)
    .mockImplementationOnce(actualFs.unlink)
    .mockRejectedValueOnce(
      Object.assign(new Error("late cleanup failure"), { code: "EACCES" }),
    );
  await assert.rejects(
    store.publish(id, bytes, signal()),
    /late cleanup failure/,
  );
});

test("a restored FIFO cannot block content admission", async () => {
  const { directory } = await fixture();
  const id = "b".repeat(64);
  await promisify(execFile)("mkfifo", [join(directory, `${id}.mgpack`)]);
  const source = `
    import assert from 'node:assert/strict';
    const { createFilesystemArchiveContent } = await import(${JSON.stringify(new URL("../src/archive-content-fs.ts", import.meta.url).href)});
    const store = await createFilesystemArchiveContent({ directory: ${JSON.stringify(directory)}, maxChunkBytes: 1024, maxConcurrentOperations: 1 });
    await assert.rejects(store.get(${JSON.stringify(id)}, new AbortController().signal), /bounds/);
  `;
  await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { timeout: 2000 },
  );
});
