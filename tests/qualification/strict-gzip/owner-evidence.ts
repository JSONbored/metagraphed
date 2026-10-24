import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import assert from "node:assert/strict";
import { validateServiceReceipt } from "./owner-service.ts";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "./receipt-files.ts";
import { RAW_LIMITS } from "./receipt-policy.ts";
import {
  boundedBuildFile,
  OWNER_BUILD_LIMITS,
  runnerRuntimeIdentity,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
import {
  publicOwnerProof,
  type Owner,
  type OwnerProof,
} from "./owner-resource-policy.ts";
export const OWNER_FILES = {
  raw: "owner-raw.json",
  queue: "owner-queue.json",
} as const;
/** A separate private inventory, never a broader upload allowlist. */
export function validateOwnerReceiptDirectory(root: string) {
  const stat = lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const canonical = realpathSync(root);
  function ordinary(file: string, limit: number) {
    const info = lstatSync(file);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.ok(realpathSync(file).startsWith(canonical + path.sep));
    boundedBuildFile(file, limit);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    assert.ok(!entry.isSymbolicLink());
    if (entry.name === "owner-builds") {
      assert.ok(entry.isDirectory());
      const owners = readdirSync(target, { withFileTypes: true });
      assert.ok(owners.length <= 2);
      for (const owner of owners) {
        assert.ok(
          ["raw", "queue"].includes(owner.name) &&
            owner.isDirectory() &&
            !owner.isSymbolicLink(),
        );
        const directory = path.join(target, owner.name);
        const files = readdirSync(directory, { withFileTypes: true });
        assert.ok(files.length <= OWNER_BUILD_LIMITS.files);
        let total = 0;
        for (const file of files) {
          assert.ok(file.isFile() && !file.isSymbolicLink());
          assert.ok(
            file.name === "manifest.json" ||
              file.name === "association.bin" ||
              /^module-\d{3}\.bin$/.test(file.name),
          );
          const limit =
            file.name === "manifest.json"
              ? OWNER_BUILD_LIMITS.manifestBytes
              : file.name === "association.bin"
                ? OWNER_BUILD_LIMITS.associationBytes
                : OWNER_BUILD_LIMITS.moduleBytes;
          const full = path.join(directory, file.name);
          ordinary(full, limit);
          total += lstatSync(full).size;
          assert.ok(
            total <=
              OWNER_BUILD_LIMITS.totalBytes + OWNER_BUILD_LIMITS.manifestBytes,
          );
        }
      }
    } else if (entry.name === "coverage") {
      assert.ok(entry.isDirectory());
      for (const child of readdirSync(target, { withFileTypes: true })) {
        const key = `coverage/${child.name}`;
        assert.ok(Object.hasOwn(RAW_LIMITS, key));
        ordinary(
          path.join(target, child.name),
          RAW_LIMITS[key as keyof typeof RAW_LIMITS],
        );
      }
    } else {
      const ownerFile =
        entry.name === "owner-service.json" ||
        (Object.values(OWNER_FILES) as string[]).includes(entry.name);
      assert.ok(ownerFile || Object.hasOwn(RAW_LIMITS, entry.name));
      ordinary(
        target,
        ownerFile ? 65536 : RAW_LIMITS[entry.name as keyof typeof RAW_LIMITS],
      );
    }
  }
}
export async function validateOwnerReceipts(run: string, root: string) {
  validateOwnerReceiptDirectory(run);
  validateServiceReceipt(
    JSON.parse(
      boundedFile(path.join(run, "owner-service.json"), 65536).toString(),
    ),
  );
  const runtime = runnerRuntimeIdentity(run, root);
  const result = [];
  for (const owner of ["raw", "queue"] as Owner[]) {
    const identity = await validateOwnerBuild(
      path.join(run, "owner-builds", owner),
      owner,
      root,
      runtime,
    );
    const proof = JSON.parse(
      boundedFile(path.join(run, OWNER_FILES[owner]), 65536).toString(),
    ) as OwnerProof;
    assert.equal(proof.owner, owner);
    const lifecycle = readOwnerNativeEvidence(run, proof.observations);
    result.push({
      ...publicOwnerProof(proof, identity),
      nativeLifecycle: lifecycle,
    });
  }
  return result;
}
