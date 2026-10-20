import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ownerOverlayFiles,
  materializeOwnerOverlay,
  verifyOwnerOverlay,
} from "./owner-overlay.ts";
function fixture(action: (root: string, scratch: string) => void) {
  const scratch = mkdtempSync(path.join(tmpdir(), "owner-overlay-pure-")),
    root = path.join(scratch, "candidate");
  mkdirSync(root);
  try {
    action(root, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
test("exact bounded fixture list copies and verifies only validation paths", () =>
  fixture((root) => {
    materializeOwnerOverlay(root);
    assert.equal(verifyOwnerOverlay(root).size, ownerOverlayFiles().length);
    assert.ok(
      ownerOverlayFiles().every((row) =>
        row.path.startsWith("tests/qualification/strict-gzip/"),
      ),
    );
  }));
test("refuses changed fixture bytes", () =>
  fixture((root) => {
    materializeOwnerOverlay(root);
    const f = path.join(root, ownerOverlayFiles()[0]!.path),
      bytes = readFileSync(f);
    bytes[0] ^= 1;
    writeFileSync(f, bytes);
    assert.throws(() => verifyOwnerOverlay(root));
  }));
test("refuses missing declared file", () =>
  fixture((root) => {
    materializeOwnerOverlay(root);
    rmSync(path.join(root, ownerOverlayFiles()[0]!.path));
    assert.throws(() => verifyOwnerOverlay(root));
  }));
test("refuses symlinked declared leaf", () =>
  fixture((root) => {
    materializeOwnerOverlay(root);
    const f = path.join(root, ownerOverlayFiles()[0]!.path);
    renameSync(f, f + ".saved");
    symlinkSync(f + ".saved", f);
    assert.throws(() => verifyOwnerOverlay(root));
  }));
test("refuses parent symlink escaping candidate", () =>
  fixture((root, scratch) => {
    materializeOwnerOverlay(root);
    const source = path.join(root, "tests"),
      outside = path.join(scratch, "outside");
    renameSync(source, outside);
    symlinkSync(outside, source);
    assert.throws(() => verifyOwnerOverlay(root));
  }));
test("refuses overwriting pre-existing overlay directory", () =>
  fixture((root) => {
    const dir = path.join(root, "tests/qualification/strict-gzip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "foreign"), "x");
    assert.throws(() => materializeOwnerOverlay(root));
  }));
test("refuses materializing through escaping parent", () =>
  fixture((root, scratch) => {
    const outside = path.join(scratch, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "tests"));
    assert.throws(() => materializeOwnerOverlay(root));
    assert.deepEqual(readdirSync(outside), []);
  }));
