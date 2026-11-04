import { constants } from "node:fs";
import { lstat, open, link, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArchiveContentStore } from "./archive-native-store.ts";

export interface ArchiveContentOptions {
  directory: string;
  maxConcurrentOperations: number;
  maxChunkBytes: number;
}

export interface ImmutableArchiveContent extends ArchiveContentStore {
  publish(
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
}

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The directory is supplied and owned by the operator. This factory neither
 * mounts storage nor registers a service. No content is overwritten or removed. */
export async function createFilesystemArchiveContent(
  options: ArchiveContentOptions,
): Promise<ImmutableArchiveContent> {
  options = { ...options };
  if (
    !Number.isSafeInteger(options.maxConcurrentOperations) ||
    options.maxConcurrentOperations < 1 ||
    options.maxConcurrentOperations > 64 ||
    !Number.isSafeInteger(options.maxChunkBytes) ||
    options.maxChunkBytes < 1 ||
    options.maxChunkBytes > 512 * 1024
  )
    throw new RangeError("Invalid archive content bounds");
  const root = await realpath(options.directory);
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid!() ||
    (directory.mode & 0o022) !== 0
  )
    throw new Error(
      "Archive content requires an owned, non-writable-by-others directory",
    );
  let active = 0;
  async function admitted<T>(
    sha256: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
      throw new TypeError("Invalid archive content digest");
    signal.throwIfAborted();
    if (active >= options.maxConcurrentOperations)
      throw new Error("Archive content capacity exceeded");
    active++;
    try {
      return await operation();
    } finally {
      active--;
    }
  }
  async function read(sha256: string, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const file = await open(
      join(root, `${sha256}.mgpack`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > options.maxChunkBytes)
        throw new Error("Archive content file exceeds its bounds");
      // A file growing after stat must not turn this read into an unbounded allocation.
      const bounded = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bounded.length) {
        signal.throwIfAborted();
        const result = await file.read(
          bounded,
          length,
          bounded.length - length,
          length,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const bytes = bounded.subarray(0, length);
      signal.throwIfAborted();
      if (bytes.length !== stat.size || digest(bytes) !== sha256)
        throw new Error("Archive content checksum differs");
      return bytes;
    } finally {
      await file.close();
    }
  }
  return {
    get: (sha256, signal) =>
      admitted(sha256, signal, async () => {
        const bytes = await read(sha256, signal);
        return new Response(bytes, {
          headers: {
            "content-length": String(bytes.length),
            "content-encoding": "identity",
          },
        });
      }),
    publish: (sha256, input, signal) =>
      admitted(sha256, signal, async () => {
        if (
          !(input instanceof Uint8Array) ||
          input.length < 1 ||
          input.length > options.maxChunkBytes
        )
          throw new RangeError("Archive content write exceeds its bounds");
        const bytes = Buffer.from(input);
        if (digest(bytes) !== sha256)
          throw new Error("Archive content checksum differs");
        const temporary = join(root, `.${randomUUID()}.tmp`);
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        let closed = false;
        let failure: { error: unknown } | undefined;
        try {
          await file.writeFile(bytes, { signal });
          signal.throwIfAborted();
          await file.chmod(0o444);
          await file.sync();
          await file.close();
          closed = true;
          signal.throwIfAborted();
          try {
            await link(temporary, join(root, `${sha256}.mgpack`));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await read(sha256, signal);
          }
          await unlink(temporary);
          const parent = await open(
            root,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          signal.throwIfAborted();
        } catch (error) {
          failure = { error };
        } finally {
          try {
            if (!closed) await file.close();
          } catch (error) {
            failure ??= { error };
          }
          try {
            await unlink(temporary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              failure ??= { error };
          }
        }
        if (failure) throw failure.error;
      }),
  };
}
