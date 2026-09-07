import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { CARD_VERSION } from "../src/og-card-version.ts";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { CARD_FONT_FACES } from "../src/og-card-fonts.ts";
import { hashJson, sha256Hex, repoRoot } from "../scripts/lib.ts";
import { resolveArtifactKey } from "../workers/storage.ts";
import { mockEnv } from "./row-type.ts";
import {
  assertReleaseOwner,
  bootstrapReleaseJournal,
  commitArtifactRelease,
  jsonBytes,
  jsonObject,
  readReleaseJournal,
  releaseJournalActive,
  resumeArtifactRelease,
  settleReleaseBeforePrepare,
  RELEASE_JOURNAL_KEY,
  RELEASE_ACTIVATION_KEY,
  ensureReleaseObject,
  type ReleasePointer,
  type ReleaseStore,
  type ReleaseObject,
} from "../scripts/artifact-release-commit.ts";
import {
  IMAGE_PATHS,
  planImageRelease,
  verifyPng,
  verifyImageSource,
  type ImageRenderReceipt,
  type ImageSource,
} from "../scripts/og-image-release-plan.ts";
import { reconcileDataReleaseImages } from "../scripts/og-image-carry-forward.ts";
import {
  captureImageSource,
  readImageSource,
  writeImageSource,
  readImageRender,
} from "../scripts/og-image-release-files.ts";
import {
  currentImageDigest,
  observeImageResponse,
} from "../scripts/verify-og-image-release.ts";

const png = readFileSync(
  new URL("../public/brand/og-fallback.png", import.meta.url),
);
function fixture() {
  const summary = jsonBytes({
    subnet_count: 128,
    counts: { endpoints: 2400, providers: 31 },
    coverage: { average_score: 87 },
  });
  const entry = {
    path: "/metagraph/registry-summary.json",
    key: `by-hash/${sha256Hex(summary)}`,
    latest_key: "latest/registry-summary.json",
    sha256: sha256Hex(summary),
    size_bytes: summary.length,
    storage_tier: "r2",
    content_type: "application/json",
    future_field: { retained: true },
  };
  const full = {
    schema_version: 1,
    contract_version: "1",
    run_prefix: "runs/base/",
    latest_prefix: "latest/",
    generated_at: "1970-01-01",
    artifact_count: 1,
    artifact_size_bytes: summary.length,
    artifacts: [entry],
    future_control: 7,
  };
  const compact = {
    ...full,
    manifest_kind: "compact",
    full_manifest_key: "latest/r2-manifest.json",
    full_manifest_run_key: "runs/base/r2-manifest.json",
    full_artifact_count: 1,
    full_artifact_size_bytes: summary.length,
    artifact_count: 0,
    artifact_size_bytes: 0,
    artifacts: [],
    storage_tier_counts: { r2: 1 },
    storage_tier_size_bytes: { r2: summary.length },
  };
  const pointer = {
    contract_version: "1",
    run_prefix: "runs/base/",
    full_manifest_run_key: "runs/base/r2-manifest.json",
    latest_prefix: "latest/",
    generated_at: "1970-01-01",
    published_at: "2026-08-01T01:02:03Z",
    artifact_count: 0,
    manifest_hash: hashJson(compact),
    native_snapshot_captured_at: "2026-07-31T00:00:00Z",
    health_surface_count: 123,
    future_pointer: { retained: true },
  };
  const source: ImageSource = {
    pointer,
    full: jsonBytes(full),
    compact: jsonBytes(compact),
    buildSummary: jsonBytes({ published_at: pointer.published_at }),
    summary,
  };
  const receipt: ImageRenderReceipt = {
    status: "rendered",
    renderer_version: CARD_VERSION,
    renderer_revision: "a".repeat(40),
    source_sha256: sha256Hex(summary),
    fonts: CARD_FONT_FACES.map((font) => ({
      ...font,
      sha256: "f".repeat(64),
      size_bytes: 1000,
    })),
    artifacts: IMAGE_PATHS.map((imagePath) => ({
      path: imagePath,
      sha256: sha256Hex(png),
      size_bytes: png.length,
      content_type: "image/png",
      width: 1200,
      height: 630,
    })),
  };
  const pngs = Object.fromEntries(
    IMAGE_PATHS.map((imagePath) => [imagePath, png]),
  );
  return { source, receipt, pngs, entry, full, compact };
}

class MemoryStore implements ReleaseStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  writes: string[] = [];
  pointer: ReleasePointer;
  visible: ReleasePointer | null = null;
  losePointerAck = false;
  failPointer = false;
  loseObjectAck: string | null = null;
  constructor(pointer: ReleasePointer) {
    this.pointer = structuredClone(pointer);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(object: ReleaseObject) {
    this.writes.push(object.key);
    this.objects.set(object.key, {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
    });
    if (this.loseObjectAck === object.key)
      throw new Error("accepted then connection lost");
  }
  async getPointer() {
    return this.visible ?? this.pointer;
  }
  async putPointer(pointer: ReleasePointer) {
    this.writes.push("KV");
    if (this.failPointer) throw new Error("not accepted");
    this.pointer = structuredClone(pointer);
    if (this.losePointerAck) throw new Error("accepted then connection lost");
  }
}
async function storeFixture() {
  const f = fixture();
  const store = new MemoryStore(f.source.pointer);
  for (const object of [
    {
      key: "runs/base/r2-manifest.json",
      bytes: f.source.full,
      contentType: "application/json",
    },
    {
      key: "runs/base/r2-manifest.compact.json",
      bytes: f.source.compact,
      contentType: "application/json",
    },
    {
      key: "runs/base/build-summary.json",
      bytes: f.source.buildSummary,
      contentType: "application/json",
    },
    {
      key: f.entry.key,
      bytes: f.source.summary,
      contentType: "application/json",
    },
  ])
    await store.put(object);
  await bootstrapReleaseJournal(store, hashJson(f.source.pointer));
  store.writes = [];
  return { ...f, store };
}

test("pure image overlay preserves all non-image bindings, unknown fields and data freshness", () => {
  const { source, receipt, pngs, entry } = fixture();
  const before = hashJson(source);
  const plan = planImageRelease(source, receipt, pngs);
  const full = JSON.parse(
    Buffer.from(
      plan.objects.find((o) => o.key.endsWith("/r2-manifest.json"))!.bytes,
    ).toString(),
  );
  const compact = JSON.parse(
    Buffer.from(
      plan.objects.find((o) => o.key.endsWith("/r2-manifest.compact.json"))!
        .bytes,
    ).toString(),
  );
  assert.deepEqual(
    full.artifacts.find((a: { path: string }) => a.path === entry.path),
    entry,
  );
  assert.equal(full.future_control, 7);
  assert.equal(compact.artifact_count, 0);
  assert.deepEqual(compact.artifacts, []);
  assert.equal(compact.full_artifact_count, 3);
  const changed = new Set([
    "run_prefix",
    "full_manifest_run_key",
    "manifest_hash",
  ]);
  for (const [key, value] of Object.entries(source.pointer))
    if (!changed.has(key)) assert.deepEqual(plan.target[key], value);
  assert.deepEqual(
    plan.objects.find((o) => o.key.endsWith("/build-summary.json"))!.bytes,
    source.buildSummary,
  );
  assert.equal(
    plan.objects.filter((o) => o.key.startsWith("by-hash/")).length,
    1,
  );
  assert.ok(plan.objects.every((o) => !o.key.startsWith("latest/")));
  assert.equal(planImageRelease(source, receipt, pngs).id, plan.id);
  assert.equal(hashJson(source), before);
});

test("invalid source, renderer, path or PNG can never produce an image plan", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.source.pointer.manifest_hash = "wrong";
    },
    (f) => {
      f.source.summary = jsonBytes({ subnet_count: -1 });
    },
    (f) => {
      f.source.full = jsonBytes({ ...f.full, artifacts: [f.entry, f.entry] });
    },
    (f) => {
      f.source.pointer.run_prefix = "runs/../latest/";
    },
    (f) => {
      f.receipt.renderer_version = "old";
    },
    (f) => {
      f.receipt.source_sha256 = "f".repeat(64);
    },
    (f) => {
      f.receipt.renderer_revision = "main";
    },
    (f) => {
      f.receipt.fonts[0].name = "Other";
    },
    (f) => {
      f.receipt.fonts[0].size_bytes = 2 * 1024 * 1024;
    },
    (f) => {
      f.receipt.artifacts[0].path = "/metagraph/nested/og-image.png";
    },
    (f) => {
      f.receipt.artifacts[0].path = f.receipt.artifacts[1].path;
    },
    (f) => {
      f.pngs["/metagraph/extra.png"] = png;
    },
    (f) => {
      delete f.pngs[IMAGE_PATHS[0]];
    },
    (f) => {
      f.pngs[IMAGE_PATHS[0]] = png.subarray(0, 33);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => planImageRelease(f.source, f.receipt, f.pngs));
  }
  assert.throws(() => verifyPng(png.subarray(0, 33)), /Incomplete/);
  const corrupt = Buffer.from(png);
  corrupt[40] ^= 1;
  assert.throws(() => verifyPng(corrupt), /Corrupt/);
});

test("source schema rejects invalid bound counts and scores instead of inventing facts", () => {
  for (const summary of [
    { subnet_count: -1 },
    { subnet_count: 3, counts: { endpoints: 1.5 } },
    { subnet_count: 3, coverage: { average_score: 101 } },
    {},
  ]) {
    const f = fixture();
    f.source.summary = jsonBytes(summary);
    f.entry.sha256 = sha256Hex(f.source.summary);
    f.entry.key = `by-hash/${f.entry.sha256}`;
    f.entry.size_bytes = f.source.summary.length;
    f.source.full = jsonBytes(f.full);
    assert.throws(() => verifyImageSource(f.source));
  }
});

test("journal migration is explicit, resumable, and cannot fall back after activation", async () => {
  const f = fixture();
  const store = new MemoryStore(f.source.pointer);
  assert.equal(await releaseJournalActive(store, true), false);
  await assert.rejects(releaseJournalActive(store, false), /activation/);
  await assert.rejects(
    bootstrapReleaseJournal(store, "a".repeat(64)),
    /differs/,
  );
  await bootstrapReleaseJournal(store, hashJson(f.source.pointer));
  await bootstrapReleaseJournal(store, hashJson(f.source.pointer));
  assert.equal(await releaseJournalActive(store, true), true);
  store.objects.delete(RELEASE_JOURNAL_KEY);
  await assert.rejects(releaseJournalActive(store, true), /missing/);
  await assert.rejects(
    bootstrapReleaseJournal(store, hashJson(f.source.pointer)),
    /never rebootstrap/,
  );
});

test("all pointer write paths require the same main workflow owner and both write guards", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF:
      "owner/repo/.github/workflows/publish-cloudflare.yml@refs/heads/main",
    METAGRAPH_RELEASE_OWNER: "publish-cloudflare",
    METAGRAPH_ALLOW_R2_UPLOAD: "1",
    METAGRAPH_ALLOW_KV_WRITE: "1",
  };
  assert.doesNotThrow(() => assertReleaseOwner(env));
  for (const key of Object.keys(env))
    assert.throws(() => assertReleaseOwner({ ...env, [key]: "wrong" }));
});

test("accepted-but-timed-out immutable uploads are reconciled without overwrite", async () => {
  const { store } = await storeFixture();
  const object = jsonObject("runs/immutable/control.json", { stable: true });
  store.loseObjectAck = object.key;
  await ensureReleaseObject(store, object);
  await ensureReleaseObject(store, object);
  assert.equal(store.writes.filter((key) => key === object.key).length, 1);
  await assert.rejects(
    ensureReleaseObject(store, jsonObject(object.key, { changed: true })),
    /collision/,
  );
});

test("image commit, exact replay and a later full publish retain artwork and every newer data binding", async () => {
  const { source, receipt, pngs, store } = await storeFixture();
  const plan = planImageRelease(source, receipt, pngs);
  assert.equal(
    (await commitArtifactRelease(store, plan)).status,
    "release-bound",
  );
  const writes = store.writes.length;
  assert.equal(
    (await commitArtifactRelease(store, plan)).status,
    "release-bound",
  );
  assert.equal(store.writes.length, writes);
  const carried = await reconcileDataReleaseImages(store, null);
  assert.equal(carried.status, "carried-forward");
  assert.deepEqual(Object.keys(carried.pngs).sort(), [...IMAGE_PATHS].sort());
  for (const imagePath of IMAGE_PATHS) {
    assert.deepEqual(carried.pngs[imagePath], png);
    assert.equal(
      carried.provenance[imagePath].artwork_receipt_key,
      `${plan.target.run_prefix}og-image-release.json`,
    );
  }
  const newer = {
    ...plan.target,
    run_prefix: "runs/newer-data/",
    full_manifest_run_key: "runs/newer-data/r2-manifest.json",
    published_at: "2026-09-06T00:00:00Z",
  };
  const data = {
    id: "d".repeat(64),
    kind: "data" as const,
    base: plan.target,
    target: newer,
    objects: [],
  };
  assert.equal(
    (await commitArtifactRelease(store, data)).status,
    "release-bound",
  );
  assert.equal((await commitArtifactRelease(store, plan)).status, "superseded");
  assert.deepEqual(store.pointer, newer);
});

test("another data release before image commit rejects the stale image plan", async () => {
  const { source, receipt, pngs, store } = await storeFixture();
  const image = planImageRelease(source, receipt, pngs);
  const target = { ...source.pointer, run_prefix: "runs/newer/" };
  await commitArtifactRelease(store, {
    id: "c".repeat(64),
    kind: "data",
    base: source.pointer,
    target,
    objects: [],
  });
  await assert.rejects(commitArtifactRelease(store, image), /base conflict/);
  assert.deepEqual(store.pointer, target);
});

test("lost pointer acknowledgement leaves durable intent and replays without local artifacts", async () => {
  const { source, receipt, pngs, store } = await storeFixture();
  const operation = planImageRelease(source, receipt, pngs);
  store.losePointerAck = true;
  store.visible = source.pointer;
  assert.equal(
    (await commitArtifactRelease(store, operation)).status,
    "pointer-pending",
  );
  assert.equal((await readReleaseJournal(store)).state, "pointer-pending");
  await assert.rejects(
    commitArtifactRelease(store, { ...operation, id: "b".repeat(64) }),
    /unresolved/,
  );
  await assert.rejects(reconcileDataReleaseImages(store, null), /unresolved/);
  store.visible = null;
  assert.equal((await resumeArtifactRelease(store)).status, "release-bound");
  assert.equal(store.writes.filter((key) => key === "KV").length, 1);
  assert.equal((await readReleaseJournal(store)).state, "committed");
});

test("normal preparation settles a now-visible pending release before selecting new data", async () => {
  const f = await storeFixture();
  const operation = planImageRelease(f.source, f.receipt, f.pngs);
  f.store.visible = f.source.pointer;
  assert.equal(
    (await commitArtifactRelease(f.store, operation)).status,
    "pointer-pending",
  );
  f.store.visible = null;
  const writes = f.store.writes.filter((key) => key === "KV").length;
  await settleReleaseBeforePrepare(f.store);
  assert.deepEqual((await readReleaseJournal(f.store)).head, operation.target);
  assert.equal(
    f.store.writes.filter((key) => key === "KV").length,
    writes,
    "an already visible target is not written again",
  );
  assert.equal(
    (await reconcileDataReleaseImages(f.store, null)).status,
    "carried-forward",
  );
});

test("still-stale pending preparation cannot publish a new data target or overwrite its expected base", async () => {
  const f = await storeFixture();
  const operation = planImageRelease(f.source, f.receipt, f.pngs);
  f.store.visible = f.source.pointer;
  await commitArtifactRelease(f.store, operation);
  const objectsBefore = new Set(f.store.objects.keys());
  let newDataSelected = false;
  await assert.rejects(async () => {
    await settleReleaseBeforePrepare(f.store);
    newDataSelected = true;
  }, /no new data upload/);
  assert.equal(newDataSelected, false);
  assert.deepEqual(new Set(f.store.objects.keys()), objectsBefore);
  const journal = await readReleaseJournal(f.store);
  assert.equal(journal.state, "pointer-pending");
  assert.deepEqual(journal.head, f.source.pointer);
  assert.deepEqual(journal.operation?.target, operation.target);
  assert.deepEqual(
    f.store.pointer,
    operation.target,
    "only the original target can be retried",
  );
});

test("corrupt immutable prerequisite or journal prevents any pointer write", async () => {
  const { source, receipt, pngs, store } = await storeFixture();
  const operation = planImageRelease(source, receipt, pngs);
  store.objects.set(operation.objects[0].key, {
    bytes: Buffer.from("wrong"),
    contentType: "image/png",
  });
  await assert.rejects(commitArtifactRelease(store, operation), /collision/);
  assert.ok(!store.writes.includes("KV"));
  store.objects.delete(operation.objects[0].key);
  store.objects.set(RELEASE_JOURNAL_KEY, {
    bytes: jsonBytes({ schema_version: 2 }),
    contentType: "application/json",
  });
  await assert.rejects(
    commitArtifactRelease(store, operation),
    /Invalid release journal/,
  );
  assert.ok(!store.writes.includes("KV"));
});

test("source capture checks immutable controls and refuses a stale visible KV head", async () => {
  const f = await storeFixture();
  assert.deepEqual(await captureImageSource(f.store), f.source);
  f.store.visible = { ...f.source.pointer, published_at: "stale" };
  await assert.rejects(captureImageSource(f.store), /settled journal/);
});

test("bundle replay is offline and rejects changed source bytes, nested files and symlinks", async () => {
  const f = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "og-image-release-"));
  const directory = path.join(root, "bundle");
  try {
    await writeImageSource(directory, f.source);
    assert.deepEqual(await readImageSource(directory), f.source);
    for (const [imagePath, bytes] of Object.entries(f.pngs))
      await writeFile(path.join(directory, path.basename(imagePath)), bytes);
    await writeFile(path.join(directory, "render.json"), jsonBytes(f.receipt));
    assert.deepEqual((await readImageRender(directory)).receipt, f.receipt);
    await writeFile(path.join(directory, "extra.png"), png);
    await assert.rejects(readImageRender(directory), /Unexpected/);
    await rm(path.join(directory, "extra.png"));
    await symlink(
      path.join(directory, "source.json"),
      path.join(directory, "linked.json"),
    );
    await assert.rejects(readImageRender(directory), /symlink/);
    await writeFile(path.join(directory, "registry-summary.json"), "{}");
    await assert.rejects(readImageSource(directory), /digest mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary GET verification distinguishes exact bytes, fallback, MIME and corrupt bodies", async () => {
  const response = (body = png, mime = "image/png") =>
    new Response(body, {
      headers: { "content-type": mime, "cache-control": "max-age=3600" },
    });
  assert.equal(
    (await observeImageResponse(response(), sha256Hex(png), "other")).status,
    "served",
  );
  assert.equal(
    (await observeImageResponse(response(), "different", sha256Hex(png)))
      .reason,
    "fallback",
  );
  assert.equal(
    (await observeImageResponse(response(), "different", "other")).reason,
    "different-bytes",
  );
  assert.equal(
    (
      await observeImageResponse(
        response(png, "text/html"),
        sha256Hex(png),
        "other",
      )
    ).status,
    "serving-pending",
  );
  assert.equal(
    (
      await observeImageResponse(
        response(png.subarray(0, 33)),
        sha256Hex(png),
        "other",
      )
    ).reason,
    "invalid-or-incomplete-png",
  );
});

test("serving verification selects the current version by path regardless of receipt order", () => {
  const { receipt } = fixture();
  receipt.artifacts[0].sha256 = "legacy";
  receipt.artifacts[1].sha256 = "current";
  assert.equal(currentImageDigest(receipt), "current");
  receipt.artifacts.reverse();
  assert.equal(currentImageDigest(receipt), "current");
  receipt.artifacts = [];
  assert.throws(() => currentImageDigest(receipt), /Current image path/);
});

test("current render replaces carried artwork; a stale renderer cannot drop newer image paths", async () => {
  const f = await storeFixture();
  assert.equal(
    (
      await reconcileDataReleaseImages(f.store, {
        receipt: f.receipt,
        pngs: f.pngs,
        summary: f.source.summary,
      })
    ).status,
    "rendered",
  );
  const full = {
    ...f.full,
    artifacts: [
      ...f.full.artifacts,
      {
        ...f.entry,
        path: `/metagraph/og-image-v${Number(CARD_VERSION) + 1}.png`,
      },
    ],
  };
  f.store.objects.set("runs/base/r2-manifest.json", {
    bytes: jsonBytes(full),
    contentType: "application/json",
  });
  await assert.rejects(
    reconcileDataReleaseImages(f.store, null),
    /Stale renderer/,
  );
  assert.ok(f.store.objects.has(RELEASE_ACTIVATION_KEY));
});

test("actual Worker resolves an image overlay without changing catalog or stable-latest keys", async () => {
  const { source, receipt, pngs, store, entry } = await storeFixture();
  const operation = planImageRelease(source, receipt, pngs);
  await commitArtifactRelease(store, operation);
  const env = mockEnv({
    METAGRAPH_CONTROL: { get: async () => store.pointer },
    METAGRAPH_ARCHIVE: {
      get: async (key: string) => {
        const object = await store.get(key);
        return object
          ? {
              json: async () =>
                JSON.parse(Buffer.from(object.bytes).toString()),
            }
          : null;
      },
    },
  });
  for (const imagePath of IMAGE_PATHS)
    assert.deepEqual(await resolveArtifactKey(imagePath, env), {
      key: `by-hash/${sha256Hex(png)}`,
      resolution: "manifest",
    });
  assert.deepEqual(await resolveArtifactKey(entry.path, env), {
    key: entry.key,
    resolution: "manifest",
  });
  assert.deepEqual(
    await resolveArtifactKey("/metagraph/health/history/2026-09-06.json", env),
    { key: "latest/health/history/2026-09-06.json", resolution: "prefix" },
  );
});

test("the actual next data manifest carries image bytes and original provenance after a skipped render", async () => {
  const f = await storeFixture();
  const operation = planImageRelease(f.source, f.receipt, f.pngs);
  await commitArtifactRelease(f.store, operation);
  const carried = await reconcileDataReleaseImages(f.store, null);
  const root = await mkdtemp(path.join(tmpdir(), "og-data-carry-"));
  try {
    await mkdir(path.join(root, "public/metagraph"), { recursive: true });
    const stage = path.join(root, R2_STAGING_RELATIVE_ROOT);
    await mkdir(stage, { recursive: true });
    await writeFile(
      path.join(stage, "registry-summary.json"),
      jsonBytes({ subnet_count: 129 }),
    );
    for (const [imagePath, bytes] of Object.entries(carried.pngs))
      await writeFile(path.join(stage, path.basename(imagePath)), bytes);
    await writeFile(
      path.join(root, "dist/og-image-provenance.json"),
      jsonBytes(carried.provenance),
    );
    execFileSync(process.execPath, ["scripts/r2-manifest.ts", "--write"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        METAGRAPH_REPO_ROOT: root,
        METAGRAPH_BUILD_TIMESTAMP: "2026-09-06T00:00:00Z",
      },
      stdio: "pipe",
    });
    const full = JSON.parse(
      readFileSync(path.join(stage, "r2-manifest.json"), "utf8"),
    );
    for (const imagePath of IMAGE_PATHS) {
      const image = full.artifacts.find(
        (entry: { path: string }) => entry.path === imagePath,
      );
      assert.equal(image.key, `by-hash/${sha256Hex(png)}`);
      assert.equal(
        image.artwork_receipt_key,
        `${operation.target.run_prefix}og-image-release.json`,
      );
    }
    assert.notEqual(
      full.artifacts.find(
        (entry: { path: string }) => entry.path === f.entry.path,
      ).key,
      f.entry.key,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
