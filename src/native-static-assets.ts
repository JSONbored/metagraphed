import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { createNativeWorkGroup } from "./native-work-group.ts";

export interface NativeStaticAssetOptions {
  directory: string;
  maxFiles: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxConcurrent: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
}

const types: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};
const omitted = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
type Asset = { bytes: Uint8Array; etag: string; type: string };

/** Snapshot the explicitly supplied API asset directory within fixed memory
 * bounds. No network, listener, global cache or mutable filesystem fallback. */
export async function createNativeStaticAssets(
  requested: NativeStaticAssetOptions,
) {
  const options = { ...requested };
  for (const [name, maximum] of [
    ["maxFiles", 10000],
    ["maxAssetBytes", 32 * 1024 * 1024],
    ["maxTotalBytes", 128 * 1024 * 1024],
    ["maxConcurrent", 100],
  ] as const)
    if (
      !Number.isSafeInteger(options[name]) ||
      options[name] < 1 ||
      options[name] > maximum
    )
      throw new RangeError(`Invalid native static ${name}`);
  if (
    options.maxAssetBytes > options.maxTotalBytes ||
    options.maxAssetBytes * options.maxConcurrent > 64 * 1024 * 1024
  )
    throw new RangeError("Native static response buffers exceed their budget");
  const root = await realpath(options.directory);
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.uid !== process.getuid!() ||
    rootStat.mode & 0o022
  )
    throw new Error(
      "Native static assets require an owned, protected directory",
    );
  const assets = new Map<string, Asset>();
  let totalBytes = 0;
  let entries = 0;
  async function readSnapshot(
    path: string,
    stat: Stats,
    limit: number,
  ): Promise<Buffer> {
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      stat.mode & 0o022 ||
      stat.isSymbolicLink()
    )
      throw new Error("Native static asset is not a protected regular file");
    if (stat.size > limit)
      throw new RangeError("Native static snapshot exceeds its budget");
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.size !== stat.size
      )
        throw new Error("Native static file changed during snapshot");
      const bounded = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bounded.length) {
        const result = await file.read(
          bounded,
          length,
          bounded.length - length,
          length,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== stat.size)
        throw new Error("Native static file changed during snapshot");
      const finished = await file.stat();
      if (
        finished.size !== opened.size ||
        finished.mtimeMs !== opened.mtimeMs ||
        finished.ctimeMs !== opened.ctimeMs
      )
        throw new Error("Native static file changed during snapshot");
      return bounded.subarray(0, length);
    } finally {
      await file.close();
    }
  }
  async function visit(directory: string, parts: string[]) {
    if (parts.length > 16)
      throw new RangeError("Native static directory depth exceeds its budget");
    for await (const entry of await opendir(directory)) {
      if (++entries > options.maxFiles)
        throw new RangeError("Native static entry count exceeds its budget");
      if (entry.name === "_headers" || entry.name === "_redirects")
        throw new Error("Native static policy files require explicit support");
      if (entry.name === ".assetsignore") {
        const path = join(directory, entry.name);
        const body = await readSnapshot(path, await lstat(path), 4096);
        const patterns = body
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"));
        if (
          patterns.some(
            (pattern) => !omitted.has(pattern) && pattern !== "**/.DS_Store",
          )
        )
          throw new Error("Native static ignore policy is unsupported");
        continue;
      }
      if (
        omitted.has(entry.name) ||
        (entry.name.startsWith(".") &&
          !(parts.length === 0 && entry.name === ".well-known"))
      )
        continue;
      const path = join(directory, entry.name);
      const next = [...parts, entry.name];
      const stat = await lstat(path);
      if (
        stat.uid !== process.getuid!() ||
        stat.mode & 0o022 ||
        stat.isSymbolicLink()
      )
        throw new Error(
          "Native static assets contain an unprotected or linked entry",
        );
      if (stat.isDirectory()) {
        await visit(path, next);
        continue;
      }
      if (totalBytes + stat.size > options.maxTotalBytes)
        throw new RangeError("Native static snapshot exceeds its budget");
      const bytes = await readSnapshot(path, stat, options.maxAssetBytes);
      totalBytes += bytes.length;
      assets.set("/" + next.join("/"), {
        bytes,
        etag: '"' + createHash("sha256").update(bytes).digest("hex") + '"',
        type: types[extname(entry.name)] ?? "application/octet-stream",
      });
    }
  }
  await visit(root, []);
  if (!assets.size) throw new Error("Native static snapshot is empty");
  const work = createNativeWorkGroup({
    name: "Native static assets",
    ...options,
  });
  const bodies = new Set<(reason: unknown) => void>();
  let stopping = false;
  return {
    get state() {
      return work.state;
    },
    stats() {
      return { files: assets.size, bytes: totalBytes };
    },
    fetch(request: Request): Promise<Response> {
      let deliver!: (response: Response) => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<Response>((resolve, fail) => {
        deliver = resolve;
        reject = fail;
      });
      const operation = work.run<Response | void>(
        "fetch",
        options.maxConcurrent,
        () => new Response("Service Unavailable", { status: 503 }),
        (scope) =>
          scope.invoke(async (signal) => {
            signal.throwIfAborted();
            request.signal.throwIfAborted();
            if (request.method !== "GET" && request.method !== "HEAD")
              return new Response(null, {
                status: 405,
                headers: { allow: "GET, HEAD" },
              });
            let path: string;
            try {
              path = decodeURIComponent(new URL(request.url).pathname);
            } catch {
              return new Response(null, { status: 400 });
            }
            if (
              path.includes("\\") ||
              path.includes("\0") ||
              path.split("/").some((part) => part === "." || part === "..")
            )
              return new Response(null, { status: 400 });
            const asset = assets.get(path);
            if (!asset)
              return new Response(
                request.method === "HEAD" ? null : "Not Found",
                { status: 404 },
              );
            const headers = new Headers({
              "content-type": asset.type,
              etag: asset.etag,
              "cache-control": "public, max-age=0, must-revalidate",
            });
            const tags = request.headers
              .get("if-none-match")
              ?.split(",")
              .map((value) => value.trim().replace(/^W\//, ""));
            if (tags?.includes("*") || tags?.includes(asset.etag))
              return new Response(null, { status: 304, headers });
            headers.set("content-length", String(asset.bytes.length));
            if (request.method === "HEAD")
              return new Response(null, { headers });
            const bodySignal = AbortSignal.any([request.signal, signal]);
            let finish!: () => void;
            const consumed = new Promise<void>((resolve) => {
              finish = resolve;
            });
            let settled = false;
            let offset = 0;
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const complete = () => {
              settled = true;
              bodySignal.removeEventListener("abort", aborted);
              bodies.delete(cancel);
              finish();
            };
            const cancel = (reason: unknown) => {
              if (settled) return;
              controller.error(reason);
              complete();
            };
            const aborted = () => cancel(bodySignal.reason);
            const stream = new ReadableStream<Uint8Array>(
              {
                start(value) {
                  controller = value;
                },
                pull(value) {
                  if (offset === asset.bytes.length) {
                    value.close();
                    complete();
                  } else {
                    const end = Math.min(offset + 65536, asset.bytes.length);
                    value.enqueue(
                      new Uint8Array(asset.bytes.subarray(offset, end)),
                    );
                    offset = end;
                  }
                },
                cancel: complete,
              },
              { highWaterMark: 0 },
            );
            bodies.add(cancel);
            bodySignal.addEventListener("abort", aborted, { once: true });
            if (bodySignal.aborted) aborted();
            if (stopping) cancel(new Error("Native static assets are closing"));
            deliver(new Response(stream, { headers }));
            await consumed;
          }),
      );
      void operation.then((response) => {
        if (response) deliver(response);
      }, reject);
      return ready;
    },
    async close() {
      stopping = true;
      const closing = work.close();
      for (const cancel of [...bodies])
        cancel(new Error("Native static assets are closing"));
      await closing;
      assets.clear();
      totalBytes = 0;
    },
  };
}
