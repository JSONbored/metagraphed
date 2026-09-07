// All repository pointer writers use this journal under the same workflow
// concurrency owner. R2 readback is not a distributed lock or KV compare-and-swap.
import { hashJson, sha256Hex, stableStringify } from "./lib.ts";

export type ReleasePointer = Record<string, unknown>;
export interface ReleaseObject {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}
export interface ReleaseStore {
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  put(object: ReleaseObject): Promise<void>;
  getPointer(): Promise<ReleasePointer>;
  putPointer(pointer: ReleasePointer): Promise<void>;
}
export interface ReleaseOperation {
  id: string;
  kind: "data" | "image";
  base: ReleasePointer;
  target: ReleasePointer;
  objects: ReleaseObject[];
}
export interface ReleaseJournal {
  schema_version: 1;
  state: "committed" | "prepared" | "pointer-pending";
  head: ReleasePointer;
  head_hash: string;
  operation?: Omit<ReleaseOperation, "objects">;
}
export const RELEASE_JOURNAL_KEY = "release-control/journal.json";
export const RELEASE_ACTIVATION_KEY = "release-control/activated.json";
export const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(stableStringify(value) + "\n");
export const jsonObject = (key: string, value: unknown): ReleaseObject => ({
  key,
  bytes: jsonBytes(value),
  contentType: "application/json; charset=utf-8",
});

export function assertReleaseOwner(
  env: Record<string, string | undefined>,
): void {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !env.GITHUB_WORKFLOW_REF?.endsWith(
      "/.github/workflows/publish-cloudflare.yml@refs/heads/main",
    ) ||
    env.METAGRAPH_RELEASE_OWNER !== "publish-cloudflare" ||
    env.METAGRAPH_ALLOW_R2_UPLOAD !== "1" ||
    env.METAGRAPH_ALLOW_KV_WRITE !== "1"
  )
    throw new Error(
      "Release writes require the governed main workflow owner and R2/KV write guards.",
    );
}

export async function readReleaseJournal(
  store: ReleaseStore,
): Promise<ReleaseJournal> {
  const object = await store.get(RELEASE_JOURNAL_KEY);
  if (!object)
    throw new Error(
      "Release journal missing; explicit settled-pointer bootstrap is required.",
    );
  const journal = JSON.parse(
    Buffer.from(object.bytes).toString(),
  ) as ReleaseJournal;
  if (
    journal.schema_version !== 1 ||
    !["committed", "prepared", "pointer-pending"].includes(journal.state) ||
    hashJson(journal.head) !== journal.head_hash ||
    (journal.state !== "committed" &&
      (!journal.operation ||
        !/^[a-f0-9]{64}$/.test(journal.operation.id) ||
        !["data", "image"].includes(journal.operation.kind) ||
        hashJson(journal.operation.base) !== journal.head_hash))
  )
    throw new Error("Invalid release journal; no pointer write is permitted.");
  return journal;
}

async function writeJournal(
  store: ReleaseStore,
  journal: ReleaseJournal,
): Promise<void> {
  const object = jsonObject(RELEASE_JOURNAL_KEY, journal);
  let failure: unknown;
  try {
    await store.put(object);
  } catch (error) {
    failure = error;
  }
  const actual = await store.get(object.key);
  if (!actual || sha256Hex(actual.bytes) !== sha256Hex(object.bytes))
    throw new Error(
      `Release journal readback unresolved${failure ? " after uncertain write" : ""}.`,
    );
}

/** Explicit operator assertion of a settled base; never invoked implicitly. */
export async function bootstrapReleaseJournal(
  store: ReleaseStore,
  expectedHash: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error("Expected settled pointer digest required.");
  const existing = await store.get(RELEASE_JOURNAL_KEY);
  if (existing) {
    const journal = await readReleaseJournal(store);
    if (journal.state !== "committed" || journal.head_hash !== expectedHash)
      throw new Error(
        "Existing journal does not match the expected bootstrap release.",
      );
    await ensureReleaseObject(
      store,
      jsonObject(RELEASE_ACTIVATION_KEY, {
        schema_version: 1,
        bootstrap_pointer_hash: expectedHash,
      }),
    );
    return;
  }
  if (await store.get(RELEASE_ACTIVATION_KEY))
    throw new Error(
      "Activated release journal is missing; restore the identified journal, never rebootstrap.",
    );
  const head = await store.getPointer();
  if (hashJson(head) !== expectedHash)
    throw new Error(
      "Bootstrap pointer differs from the expected settled release.",
    );
  await writeJournal(store, {
    schema_version: 1,
    state: "committed",
    head,
    head_hash: expectedHash,
  });
  await ensureReleaseObject(
    store,
    jsonObject(RELEASE_ACTIVATION_KEY, {
      schema_version: 1,
      bootstrap_pointer_hash: expectedHash,
    }),
  );
}

/** Explicit migration window only. A journal or marker always enables enforcement. */
export async function releaseJournalActive(
  store: ReleaseStore,
  allowMigration: boolean,
): Promise<boolean> {
  const marker = await store.get(RELEASE_ACTIVATION_KEY);
  const journal = await store.get(RELEASE_JOURNAL_KEY);
  if (marker && !journal)
    throw new Error("Activated release journal is missing.");
  if (!marker && !allowMigration)
    throw new Error("Release journal activation required.");
  if (journal) {
    await readReleaseJournal(store);
    return true;
  }
  if (!allowMigration) throw new Error("Release journal activation required.");
  return false;
}

/** Immutable keys are never overwritten, including retries after lost ACKs. */
export async function ensureReleaseObject(
  store: ReleaseStore,
  object: ReleaseObject,
): Promise<void> {
  const expected = sha256Hex(object.bytes);
  const matches = (actual: { bytes: Uint8Array; contentType: string }) =>
    sha256Hex(actual.bytes) === expected &&
    actual.contentType.split(";")[0].trim() ===
      object.contentType.split(";")[0].trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await store.get(object.key);
    if (existing) {
      if (!matches(existing))
        throw new Error(`Immutable object collision: ${object.key}`);
      return;
    }
    try {
      await store.put(object);
    } catch {
      /* Reconcile possible acceptance before retrying. */
    }
    const actual = await store.get(object.key);
    if (actual) {
      if (!matches(actual))
        throw new Error(`Immutable object readback mismatch: ${object.key}`);
      return;
    }
  }
  throw new Error(`Immutable object remains unresolved: ${object.key}`);
}

function operationReceipt(operation: ReleaseOperation) {
  return {
    id: operation.id,
    kind: operation.kind,
    base: operation.base,
    target: operation.target,
    objects: operation.objects.map(({ key, bytes, contentType }) => ({
      key,
      sha256: sha256Hex(bytes),
      size_bytes: bytes.length,
      content_type: contentType,
    })),
  };
}

export async function commitArtifactRelease(
  store: ReleaseStore,
  operation: ReleaseOperation,
): Promise<{
  status: "release-bound" | "pointer-pending" | "superseded";
  id: string;
}> {
  if (!/^[a-f0-9]{64}$/.test(operation.id))
    throw new Error("Invalid release operation identity.");
  const baseHash = hashJson(operation.base);
  const targetHash = hashJson(operation.target);
  const receipt = jsonObject(
    `release-control/operations/${operation.id}.json`,
    operationReceipt(operation),
  );
  const completionKey = `release-control/completed/${operation.id}.json`;
  const completed = await store.get(completionKey);
  const completedRecord = completed
    ? (JSON.parse(Buffer.from(completed.bytes).toString()) as Record<
        string,
        unknown
      >)
    : null;
  if (
    completedRecord &&
    (completedRecord.id !== operation.id ||
      completedRecord.target_hash !== targetHash)
  )
    throw new Error("Conflicting release completion receipt.");
  const journal = await readReleaseJournal(store);
  if (journal.state === "committed") {
    if (journal.head_hash === targetHash)
      return { status: "release-bound", id: operation.id };
    if (journal.head_hash !== baseHash) {
      if (completedRecord) return { status: "superseded", id: operation.id };
      throw new Error(
        "Release base conflict; capture and render against the current committed release.",
      );
    }
  } else if (
    hashJson(journal.operation) !==
    hashJson({
      id: operation.id,
      kind: operation.kind,
      base: operation.base,
      target: operation.target,
    })
  ) {
    throw new Error(
      "Another release intent is unresolved; replay that exact operation first.",
    );
  }
  // Prepare all durable bytes before claiming a pending intent. A restarted
  // job can reconstruct this exact operation without the original local tree.
  for (const object of operation.objects)
    await ensureReleaseObject(store, object);
  await ensureReleaseObject(store, receipt);
  const intent: ReleaseJournal = {
    ...journal,
    state: "prepared",
    operation: {
      id: operation.id,
      kind: operation.kind,
      base: operation.base,
      target: operation.target,
    },
  };
  if (journal.state === "committed") await writeJournal(store, intent);
  await writeJournal(store, { ...intent, state: "pointer-pending" });
  // A prior ambiguous write may already be bound. KV reads can be stale, so
  // only this exact pending target can be retried, never another release.
  const visible = await store.getPointer();
  if (hashJson(visible) !== targetHash) {
    if (hashJson(visible) !== baseHash)
      throw new Error(
        "Pointer conflicts with the pending intent; retain the journal for reconciliation.",
      );
    try {
      await store.putPointer(operation.target);
    } catch {
      /* Keep durable pending intent. */
    }
  }
  if (hashJson(await store.getPointer()) !== targetHash)
    return { status: "pointer-pending", id: operation.id };
  const completion = completed
    ? { key: completionKey, ...completed }
    : jsonObject(completionKey, {
        id: operation.id,
        target_hash: targetHash,
        release_bound_at: new Date().toISOString(),
      });
  await ensureReleaseObject(store, completion);
  await writeJournal(store, {
    schema_version: 1,
    state: "committed",
    head: operation.target,
    head_hash: targetHash,
  });
  return { status: "release-bound", id: operation.id };
}

export async function resumeArtifactRelease(store: ReleaseStore) {
  const journal = await readReleaseJournal(store);
  if (journal.state === "committed")
    return { status: "release-bound", id: null };
  const operation = journal.operation!;
  const record = await store.get(
    `release-control/operations/${operation.id}.json`,
  );
  if (!record) throw new Error("Pending operation receipt is missing.");
  const receipt = JSON.parse(
    Buffer.from(record.bytes).toString(),
  ) as ReturnType<typeof operationReceipt>;
  if (
    hashJson({
      id: receipt.id,
      kind: receipt.kind,
      base: receipt.base,
      target: receipt.target,
    }) !== hashJson(operation)
  )
    throw new Error("Pending operation receipt identity mismatch.");
  const objects: ReleaseObject[] = [];
  for (const entry of receipt.objects) {
    if (
      !/^(?:by-hash\/[a-f0-9]{64}|runs\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+)$/.test(
        entry.key,
      )
    )
      throw new Error("Unsafe pending prerequisite key.");
    const object = await store.get(entry.key);
    if (
      !object ||
      sha256Hex(object.bytes) !== entry.sha256 ||
      object.bytes.length !== entry.size_bytes
    )
      throw new Error(`Pending prerequisite missing or changed: ${entry.key}`);
    objects.push({
      key: entry.key,
      bytes: object.bytes,
      contentType: entry.content_type,
    });
  }
  return commitArtifactRelease(store, { ...operation, objects });
}

/** The next data run may settle an earlier exact intent, never replace it. */
export async function settleReleaseBeforePrepare(
  store: ReleaseStore,
): Promise<void> {
  const journal = await readReleaseJournal(store);
  if (journal.state === "committed") return;
  const result = await resumeArtifactRelease(store);
  if (result.status !== "release-bound")
    throw new Error(
      "Prior release remains pointer-pending; no new data upload is permitted.",
    );
}
