import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  chmod,
  symlink,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { createNativeStaticAssets } from "../src/native-static-assets.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(
  files: Record<string, string | Uint8Array> = {
    "entry.json": '{"answer":42}\n',
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "metagraphed-static-"));
  directories.push(directory);
  for (const [name, value] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode: 0o600 });
  }
  return {
    directory,
    maxFiles: 100,
    maxAssetBytes: 1024,
    maxTotalBytes: 4096,
    maxConcurrent: 2,
    executionTimeoutMillis: 1000,
    drainTimeoutMillis: 1000,
  };
}
const request = (path = "/entry.json", init?: RequestInit) =>
  new Request("https://assets.example" + path, init);
async function readStatus(
  store: Awaited<ReturnType<typeof createNativeStaticAssets>>,
  input: Request,
) {
  const response = await store.fetch(input);
  await response.arrayBuffer();
  return response.status;
}

test("snapshots exact API asset bytes with HEAD and conditional reads", async () => {
  const options = await fixture({
    "entry.json": '{"answer":42}\n',
    ".well-known/discovery.json": "{}",
    "raw.bin": new Uint8Array([0, 255, 42]),
    "empty.txt": "",
    "unicode-雪.md": "snow",
    ".secret": "never served",
    ".DS_Store": "never served",
    "nested/Thumbs.db": "never served",
    ".assetsignore": ".DS_Store\n**/.DS_Store\nThumbs.db\ndesktop.ini\n",
  });
  const store = await createNativeStaticAssets(options);
  assert.equal(store.state, "ready");
  const response = await store.fetch(request("/entry.json?query=ignored"));
  assert.equal(await response.text(), '{"answer":42}\n');
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("content-length"), "14");
  const etag = response.headers.get("etag")!;
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  for (const tag of [etag, "W/" + etag, "*", '"other", ' + etag])
    assert.equal(
      (
        await store.fetch(
          request("/entry.json", { headers: { "if-none-match": tag } }),
        )
      ).status,
      304,
    );
  assert.equal(
    await readStatus(
      store,
      request("/entry.json", { headers: { "if-none-match": '"other"' } }),
    ),
    200,
  );
  const head = await store.fetch(request("/entry.json", { method: "HEAD" }));
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), "14");
  assert.deepEqual(
    new Uint8Array(
      await (await store.fetch(request("/raw.bin"))).arrayBuffer(),
    ),
    new Uint8Array([0, 255, 42]),
  );
  const raw = await store.fetch(request("/raw.bin"));
  assert.equal(raw.headers.get("content-type"), "application/octet-stream");
  await raw.arrayBuffer();
  assert.equal(await (await store.fetch(request("/empty.txt"))).text(), "");
  assert.equal(
    await (await store.fetch(request("/unicode-%E9%9B%AA.md"))).text(),
    "snow",
  );
  assert.equal(
    await readStatus(store, request("/.well-known/discovery.json")),
    200,
  );
  assert.equal((await store.fetch(request("/.secret"))).status, 404);
  await writeFile(join(options.directory, "entry.json"), "changed");
  assert.equal(await (await store.fetch(request())).text(), '{"answer":42}\n');
  assert.equal(store.stats().files, 5);
  await store.close();
  assert.equal(store.state, "closed");
  assert.deepEqual(store.stats(), { files: 0, bytes: 0 });
  await assert.rejects(store.fetch(request()), /closed/);
});

test("rejects methods, malformed paths and aborted requests with bounded admission", async () => {
  const store = await createNativeStaticAssets({
    ...(await fixture()),
    maxConcurrent: 1,
  });
  const first = store.fetch(request());
  assert.equal((await store.fetch(request())).status, 503);
  await (await first).text();
  assert.equal(
    (await store.fetch(request("/entry.json", { method: "POST" }))).status,
    405,
  );
  for (const path of ["/%FF", "/%5Csecret", "/%00secret", "/%2e%2e%2fsecret"])
    assert.equal((await store.fetch(request(path))).status, 400);
  assert.equal((await store.fetch(request("/missing"))).status, 404);
  assert.equal(
    await (await store.fetch(request("/missing", { method: "HEAD" }))).text(),
    "",
  );
  const aborted = new AbortController();
  aborted.abort(new Error("fixture cancellation"));
  await assert.rejects(
    store.fetch(request("/entry.json", { signal: aborted.signal })),
    /fixture cancellation/,
  );
  await store.close();
});

test("holds admission for unread bodies and copies chunks without exposing the snapshot", async () => {
  const original = new Uint8Array(131072).fill(42);
  const store = await createNativeStaticAssets({
    ...(await fixture({ "data.bin": original })),
    maxAssetBytes: original.length,
    maxTotalBytes: original.length,
    maxConcurrent: 1,
  });
  const held = await store.fetch(request("/data.bin"));
  for (let index = 0; index < 10; index++)
    assert.equal(await readStatus(store, request("/data.bin")), 503);
  const reader = held.body!.getReader();
  const chunk = await reader.read();
  assert.equal(chunk.value!.length, 65536);
  chunk.value![0] = 0;
  assert.equal(await readStatus(store, request("/data.bin")), 503);
  await reader.cancel();
  await nextTurn();
  assert.deepEqual(
    new Uint8Array(
      await (await store.fetch(request("/data.bin"))).arrayBuffer(),
    ),
    original,
  );
  await store.close();
});

test("cancellation, deadline and close terminate unread body admission", async () => {
  const store = await createNativeStaticAssets({
    ...(await fixture()),
    maxConcurrent: 1,
    executionTimeoutMillis: 50,
  });
  const controller = new AbortController();
  const aborted = await store.fetch(
    request("/entry.json", { signal: controller.signal }),
  );
  controller.abort(new Error("reader disconnected"));
  await assert.rejects(aborted.text(), /reader disconnected/);
  await nextTurn();
  const expired = await store.fetch(request());
  await new Promise((resolve) => setTimeout(resolve, 75));
  await assert.rejects(expired.text(), /execution deadline/);
  const closing = await store.fetch(request());
  await store.close();
  await assert.rejects(closing.text(), /closing/);
  const early = await createNativeStaticAssets(await fixture());
  const pending = early.fetch(request());
  const closed = early.close();
  await assert.rejects((await pending).text(), /closing/);
  await closed;
  const racing = await createNativeStaticAssets(await fixture());
  const abort = new AbortController();
  const input = request("/entry.json", { signal: abort.signal });
  const headers = input.headers;
  let draining!: Promise<void>;
  Object.defineProperty(input, "headers", {
    get() {
      abort.abort(new Error("cancelled during headers"));
      draining = racing.close();
      return headers;
    },
  });
  await assert.rejects(
    (await racing.fetch(input)).text(),
    /cancelled during headers/,
  );
  await draining;
});

test("requires explicit file, memory and concurrency budgets", async () => {
  const options = await fixture();
  for (const bounds of [
    { maxFiles: 0 },
    { maxFiles: 10001 },
    { maxAssetBytes: 1.1 },
    { maxAssetBytes: 33554433 },
    { maxTotalBytes: 0 },
    { maxTotalBytes: 134217729 },
    { maxConcurrent: NaN },
    { maxConcurrent: 101 },
  ])
    await assert.rejects(
      createNativeStaticAssets({ ...options, ...bounds }),
      /Invalid native static/,
    );
  await assert.rejects(
    createNativeStaticAssets({ ...options, maxTotalBytes: 512 }),
    /response buffers/,
  );
  await assert.rejects(
    createNativeStaticAssets({
      ...options,
      maxAssetBytes: 1048576,
      maxTotalBytes: 1048576,
      maxConcurrent: 100,
    }),
    /response buffers/,
  );
  await assert.rejects(
    createNativeStaticAssets({
      ...options,
      directory: join(options.directory, "absent"),
    }),
    /ENOENT/,
  );
  await assert.rejects(
    createNativeStaticAssets({
      ...options,
      directory: join(options.directory, "entry.json"),
    }),
    /protected directory/,
  );
  await chmod(options.directory, 0o777);
  await assert.rejects(
    createNativeStaticAssets(options),
    /protected directory/,
  );
  await chmod(options.directory, 0o700);
  const rootStat = await actual.lstat(options.directory);
  rootStat.uid += 1;
  vi.mocked(fs.lstat).mockResolvedValueOnce(rootStat);
  await assert.rejects(
    createNativeStaticAssets(options),
    /protected directory/,
  );
});

test("fails on unsupported policy and oversized or empty snapshots", async () => {
  for (const name of ["_headers", "_redirects"])
    await assert.rejects(
      createNativeStaticAssets(await fixture({ [name]: "policy" })),
      /policy files/,
    );
  await assert.rejects(
    createNativeStaticAssets(await fixture({ ".assetsignore": "*.json" })),
    /ignore policy/,
  );
  const ignored = await fixture({ ".assetsignore": "x".repeat(4097) });
  await assert.rejects(createNativeStaticAssets(ignored), /budget/);
  await assert.rejects(createNativeStaticAssets(await fixture({})), /empty/);
  await assert.rejects(
    createNativeStaticAssets({
      ...(await fixture({ a: "a", b: "b" })),
      maxFiles: 1,
    }),
    /entry count/,
  );
  await assert.rejects(
    createNativeStaticAssets({ ...(await fixture()), maxAssetBytes: 1 }),
    /budget/,
  );
  await assert.rejects(
    createNativeStaticAssets({
      ...(await fixture({ a: "aaa", b: "bbb" })),
      maxAssetBytes: 4,
      maxTotalBytes: 4,
    }),
    /budget/,
  );
  const deep = Array.from({ length: 17 }, () => "a").join("/") + "/file";
  await assert.rejects(
    createNativeStaticAssets(await fixture({ [deep]: "data" })),
    /depth/,
  );
});

test("refuses linked, writable or non-regular source files", async () => {
  const options = await fixture();
  const path = join(options.directory, "entry.json");
  await chmod(path, 0o666);
  await assert.rejects(createNativeStaticAssets(options), /unprotected/);
  await chmod(path, 0o600);
  await rm(path);
  await symlink("absent", path);
  await assert.rejects(createNativeStaticAssets(options), /linked/);
  await rm(path);
  await promisify(execFile)("mkfifo", [path]);
  await assert.rejects(createNativeStaticAssets(options), /regular file/);
});

test("refuses files that change identity, size or timestamps while snapshotted", async () => {
  const options = await fixture();
  for (const change of [
    "type",
    "inode",
    "size",
    "truncated",
    "finished-size",
    "mtime",
    "ctime",
  ]) {
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      let calls = 0;
      Object.defineProperty(handle, "stat", {
        value: async () => {
          const value = await stat();
          calls++;
          if (calls === 1) {
            if (change === "type")
              Object.defineProperty(value, "isFile", { value: () => false });
            if (change === "inode") value.ino++;
            if (change === "size") value.size++;
          } else {
            if (change === "finished-size") value.size++;
            if (change === "mtime") value.mtimeMs++;
            if (change === "ctime") value.ctimeMs++;
          }
          return value;
        },
      });
      if (change === "truncated")
        Object.defineProperty(handle, "read", {
          value: async () => ({ bytesRead: 0 }),
        });
      return handle;
    });
    await assert.rejects(
      createNativeStaticAssets(options),
      /changed during snapshot/,
    );
  }
});
