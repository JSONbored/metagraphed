// #10835: read-only local files. No RPC, database, bucket, producer or network.
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { AlphaEventSpike } from "./lib/alpha-event-spike.ts";

function openRegular(path: string, maxBytes: number) {
  const fd = openSync(path, "r");
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > maxBytes) {
    closeSync(fd);
    throw new Error(
      "Pinned analysis input exceeds its regular-file byte budget",
    );
  }
  return fd;
}
function readManifest(path: string) {
  const max = 8 * 1024 * 1024,
    fd = openRegular(path, max);
  try {
    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, bytes, total, bytes.length - total, null);
      if (!read) break;
      total += read;
      if (total > max) throw new Error("Manifest grew beyond its byte budget");
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, total),
      ),
    );
  } finally {
    closeSync(fd);
  }
}

export async function analyzeAlphaEventFiles(
  manifestPath: string,
  sourcePath: string,
) {
  const analysis = new AlphaEventSpike(readManifest(manifestPath));
  const max = 256 * 1024 * 1024;
  const stream = createReadStream(sourcePath, {
    fd: openRegular(sourcePath, max),
    autoClose: true,
  });
  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    lineBytes = 0;
  let parts: Buffer[] = [];
  const append = (part: Buffer) => {
    lineBytes += part.length;
    if (lineBytes > 16 * 1024 * 1024)
      throw new Error("Block line exceeds its byte budget");
    parts.push(part);
  };
  const accept = () => {
    analysis.accept(
      JSON.parse(decoder.decode(Buffer.concat(parts, lineBytes))),
    );
    parts = [];
    lineBytes = 0;
  };
  try {
    for await (const chunk of stream) {
      const part = chunk as Buffer;
      bytes += part.length;
      if (bytes > max)
        throw new Error("Source grew beyond its admitted byte budget");
      digest.update(part);
      let from = 0;
      for (;;) {
        const newline = part.indexOf(10, from);
        if (newline < 0) {
          if (from < part.length) append(part.subarray(from));
          break;
        }
        append(part.subarray(from, newline));
        accept();
        from = newline + 1;
      }
    }
    if (lineBytes) accept();
    return analysis.finish(digest.digest("hex"));
  } finally {
    stream.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [manifest, source, ...extra] = process.argv.slice(2);
  if (!manifest || !source || extra.length)
    throw new Error(
      "Usage: node scripts/analyze-alpha-event-window.ts MANIFEST.json BLOCKS.ndjson",
    );
  console.log(JSON.stringify(await analyzeAlphaEventFiles(manifest, source)));
}
