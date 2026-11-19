import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { RAW_LIMITS, PUBLIC_LIMITS } from "./receipt-policy.ts";

export function boundedFile(file: string, maximum: number): Buffer {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > 16 * 1024 * 1024
  )
    throw new Error("Invalid file budget");
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      throw new Error("Invalid qualification receipt file");
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maximum)
      throw new Error("Qualification receipt grew beyond limit");
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}

export function validateReceiptDirectory(root: string): void {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("Invalid receipt directory");
  const real = realpathSync(root);
  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Receipt symlink refused");
      if (entry.isDirectory()) {
        if (relative !== "coverage")
          throw new Error("Unexpected receipt directory");
        walk(target, "coverage/");
      } else {
        if (!entry.isFile()) throw new Error("Receipt must be a regular file");
        if (!Object.hasOwn(RAW_LIMITS, relative))
          throw new Error("Unexpected receipt file");
        if (!realpathSync(target).startsWith(real + path.sep))
          throw new Error("Receipt escaped root");
        boundedFile(target, RAW_LIMITS[relative as keyof typeof RAW_LIMITS]);
      }
    }
  }
  walk(root, "");
}

export function validatePublicationDirectory(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid publication root");
  const entries = readdirSync(root, { withFileTypes: true });
  if (!entries.some((entry) => entry.name === "qualification-summary.json"))
    throw new Error("Missing public summary");
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !Object.hasOwn(PUBLIC_LIMITS, entry.name)
    )
      throw new Error("Unexpected publication file");
    boundedFile(
      path.join(root, entry.name),
      PUBLIC_LIMITS[entry.name as keyof typeof PUBLIC_LIMITS],
    );
  }
}

/** Pure accounting; caller writes only accepted bytes and terminates on overflow. */
export function appendBudget(
  used: number,
  incoming: Uint8Array,
  maximum: number,
) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    used > maximum
  )
    throw new Error("Invalid output budget");
  const available = maximum - used;
  const accepted = incoming.subarray(0, available);
  return {
    accepted,
    used: used + accepted.byteLength,
    exceeded: incoming.byteLength > available,
  };
}
