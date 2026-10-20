import { boundedFile } from "./receipt-files.ts";
// Exact validation-only fixture overlay. Never changes a production path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const prefix = "tests/qualification/strict-gzip/";
export interface OwnerOverlayFile {
  path: string;
  sha256: string;
  bytes: number;
}
export function ownerOverlayFiles(): OwnerOverlayFile[] {
  const manifest = JSON.parse(
    boundedFile(path.join(here, "owner-overlay.json"), 64 * 1024).toString(),
  );
  assert.equal(manifest.baseCommit, "6b8422966b1411dff6d7c486f4e9a549acecc761");
  assert.equal(
    manifest.qualificationHead,
    "88b3cededcf01ddf82c86c10ca80c4e5284bb3b3",
  );
  assert.ok(
    Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 64,
  );
  const seen = new Set<string>();
  let bytes = 0;
  for (const row of manifest.files) {
    assert.ok(typeof row.path === "string" && row.path.startsWith(prefix));
    const name = row.path.slice(prefix.length);
    assert.match(name, /^[a-z][a-z0-9.-]*\.(?:ts|json|patch|md)$/);
    assert.ok(!seen.has(row.path));
    seen.add(row.path);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= 512 * 1024,
    );
    bytes += row.bytes;
    assert.ok(bytes <= 2 * 1024 * 1024);
  }
  return manifest.files;
}
export function verifyOwnerOverlay(root: string): Set<string> {
  const files = ownerOverlayFiles();
  const canonicalRoot = realpathSync(root);
  for (const row of files) {
    const file = path.join(root, row.path),
      stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, row.bytes);
    assert.ok(realpathSync(file).startsWith(canonicalRoot + path.sep));
    assert.equal(
      createHash("sha256").update(boundedFile(file, row.bytes)).digest("hex"),
      row.sha256,
    );
  }
  return new Set(files.map((row) => row.path));
}
export function materializeOwnerOverlay(root: string) {
  assert.ok(path.isAbsolute(root));
  const files = ownerOverlayFiles();
  const directory = path.join(root, prefix);
  const canonicalRoot = realpathSync(root);
  const segments = prefix.split("/").filter(Boolean);
  let current = root;
  // Refuse every existing parent before any directory creation.
  for (const segment of segments) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      const info = lstatSync(current);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.ok(realpathSync(current).startsWith(canonicalRoot + path.sep));
    } else break;
  }
  current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const info = lstatSync(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.ok(realpathSync(current).startsWith(canonicalRoot + path.sep));
  }
  assert.equal(readdirSync(directory).length, 0);
  assert.ok(realpathSync(directory).startsWith(canonicalRoot + path.sep));
  for (const row of files) {
    const source = path.join(here, row.path.slice(prefix.length));
    assert.ok(
      lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(),
    );
    const bytes = boundedFile(source, row.bytes);
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    copyFileSync(source, path.join(root, row.path));
  }
  verifyOwnerOverlay(root);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(process.argv.length, 3);
  materializeOwnerOverlay(process.argv[2]!);
}
