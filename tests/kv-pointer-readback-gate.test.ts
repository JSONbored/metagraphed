import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "vitest";
import {
  publishRegistryKv,
  registryDigest,
} from "../scripts/registry-kv-store.ts";
import { registryObjectKey } from "../src/registry-kv.ts";

type Store = Parameters<typeof publishRegistryKv>[0];
const execFileAsync = promisify(execFile);

// The old twelve-HEAD sample could miss a partially populated publication.
// Every new or reused object must now pass byte readback before pointer selection.
function publication(missingIndex: number | null) {
  const before = Buffer.from('{"published_at":"old"}');
  const values = new Map<string, Uint8Array>([["metagraph:latest", before]]);
  const payloads = Array.from({ length: 24 }, (_, index) =>
    Buffer.from(JSON.stringify({ index })),
  );
  const artifacts = payloads.map((bytes, index) => ({
    path: `/metagraph/subnets/${index}.json`,
    sha256: registryDigest(bytes),
    size_bytes: bytes.length,
  }));
  const writes: string[] = [];
  const missingKey =
    missingIndex === null
      ? null
      : registryObjectKey(artifacts[missingIndex]!.sha256);
  const store: Store = {
    async read(key) {
      return values.get(key) ?? null;
    },
    async readText(keys) {
      return Object.fromEntries(
        keys.map((key) => [
          key,
          values.has(key)
            ? Buffer.from(values.get(key)!).toString("utf8")
            : null,
        ]),
      );
    },
    async write(items) {
      for (const item of items) {
        writes.push(item.key);
        if (item.key !== missingKey) values.set(item.key, item.bytes);
      }
    },
    async list() {
      return [];
    },
    async remove() {
      throw new Error("Publication must not remove source data");
    },
  };
  const input = {
    artifacts,
    bootstrapStable: [],
    pointer: { published_at: "new" },
    load: async (entry: (typeof artifacts)[number]) =>
      payloads[Number(entry.path.match(/(\d+)\.json$/)![1])]!,
  };
  return { before, values, writes, store, input };
}

test.each([0, 13, 23])(
  "refuses pointer selection if artifact %i is missing after upload",
  async (missing) => {
    const state = publication(missing);
    await assert.rejects(
      publishRegistryKv(state.store, state.input),
      /readback failed/,
    );
    assert.deepEqual(state.values.get("metagraph:latest"), state.before);
    assert.ok(!state.writes.includes("metagraph:latest"));
  },
);

test("selects the publication only after all artifacts and its manifest read back", async () => {
  const state = publication(null);
  await publishRegistryKv(state.store, state.input);
  assert.equal(state.writes.at(-1), "metagraph:latest");
  const pointer = JSON.parse(
    Buffer.from(state.values.get("metagraph:latest")!).toString("utf8"),
  );
  assert.equal(pointer.published_at, "new");
  assert.match(pointer.registry_manifest_sha256, /^[a-f0-9]{64}$/);
});

test("dry-run performs no remote reads or writes", async () => {
  const denyNetwork =
    "data:text/javascript," +
    encodeURIComponent(
      "globalThis.fetch = () => { throw new Error('Unexpected remote operation'); };",
    );
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", denyNetwork, "scripts/kv-publish-pointer.ts", "--dry-run"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.match(stdout, /"mode": "dry-run"/);
  assert.match(stdout, /"remote_writes": 0/);
});
