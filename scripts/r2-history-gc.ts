import { pathToFileURL } from "node:url";
import { CHAIN_FIREHOSE_TOPICS } from "../src/chain-firehose-topics.ts";
import { HistorySelectionSchema } from "../schemas-src/artifacts/history-selection.ts";
import {
  RuntimeAccountCurationPointerSchema,
  RuntimeAccountCurationSchema,
} from "../schemas-src/artifacts/runtime-account-curation.ts";
import { r2ApiBaseUrl, requireCloudflareCredentials } from "./r2-rest.ts";
import type { RegistryObject } from "./r2-registry-gc.ts";

export interface HistoryGcStore {
  list(
    prefix: string,
    delimiter?: string,
  ): Promise<{ objects: RegistryObject[]; prefixes: string[] }>;
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
const ROOT = "metagraph/indexed-history/v1/";
export const HISTORY_GC_CHECKPOINT = "metagraph/maintenance/history-gc/v1.json";
const NETWORKS = ["mainnet", "testnet"] as const;
const TABLES = CHAIN_FIREHOSE_TOPICS;
const OBJECT_GRACE = 24 * 60 * 60 * 1000;
const OBSERVATION_GRACE = 60 * 60 * 1000;
const MAX_OBJECTS = 50000;
const MAX_GENERATIONS = 256;
interface Observation {
  since: number;
  checked: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid history maintenance metadata");
  return value as Record<string, unknown>;
}
function identity(objects: RegistryObject[]): string {
  return JSON.stringify(
    objects
      .map((o) => [o.key, o.etag, o.size, Date.parse(o.last_modified)])
      .sort(),
  );
}
function observations(
  value: unknown,
  now: number,
): Record<string, Observation> {
  if (value === null) return {};
  const checkpoint = record(value);
  if (checkpoint.version !== 1)
    throw new Error("Unknown history checkpoint version");
  const entries = record(checkpoint.observations);
  const result: Record<string, Observation> = {};
  for (const [key, item] of Object.entries(entries)) {
    const observation = record(item);
    if (
      !/^metagraph\/indexed-history\/v1\/(mainnet|testnet)\/(blocks|extrinsics|chain_events|account_events)\/generations\/[a-f0-9]{64}\/$/.test(
        key,
      ) ||
      !Number.isSafeInteger(observation.since) ||
      !Number.isSafeInteger(observation.checked) ||
      (observation.since as number) < 0 ||
      (observation.since as number) > now ||
      (observation.checked as number) < 0 ||
      (observation.checked as number) > now
    )
      throw new Error("Invalid history checkpoint observation");
    result[key] = {
      since: observation.since as number,
      checked: observation.checked as number,
    };
  }
  return result;
}
async function roots(
  store: HistoryGcStore,
  network: (typeof NETWORKS)[number],
  table: (typeof TABLES)[number],
) {
  const raw = await store.read(`${ROOT}${network}/${table}/current.json`);
  const selection = HistorySelectionSchema.parse(raw);
  if (selection.network !== network || selection.table !== table)
    throw new Error("History selection scope mismatch");
  const segments = selection.version === 1 ? [selection] : selection.segments;
  const selected = new Set<string>();
  for (const [i, segment] of segments.entries()) {
    const prefix = `${ROOT}${network}/${table}/generations/${segment.generation}/`;
    if (
      segment.network !== network ||
      segment.table !== table ||
      selected.has(segment.generation) ||
      segment.firstBlock > segment.lastBlock ||
      (i > 0 && segment.firstBlock !== segments[i - 1].lastBlock + 1) ||
      segment.blockManifest.key !== prefix + "block-manifest.json" ||
      (segment.hashManifest &&
        segment.hashManifest.key !== prefix + "manifest.json")
    )
      throw new Error("History selection coverage mismatch");
    selected.add(segment.generation);
  }
  // Correction generations are independently selected. Missing or malformed
  // roots stop collection rather than treating a failed read as no references.
  const correctionRoot = `metagraph/runtime-account-curation/v1/${network}/`;
  const pointer = RuntimeAccountCurationPointerSchema.parse(
    await store.read(correctionRoot + "current.json"),
  );
  if (
    pointer.network !== network ||
    !new RegExp(`^${correctionRoot}[a-f0-9]{64}/manifest\\.json$`).test(
      pointer.manifest.key,
    )
  )
    throw new Error("Correction pointer scope mismatch");
  const correction = RuntimeAccountCurationSchema.parse(
    await store.read(pointer.manifest.key),
  );
  if (
    correction.network !== network ||
    correction.selection.network !== network ||
    pointer.manifest.key !==
      `${correctionRoot}${correction.selection.generation}/manifest.json`
  )
    throw new Error("Correction manifest scope mismatch");
  if (table === "account_events") selected.add(correction.selection.generation);
  return {
    identity: JSON.stringify([selection, pointer, correction]),
    selected,
    segments,
  };
}

/** The ordinary publisher only extends coverage or compacts tails. Never run
 * alongside a manual rollback/rebuild operator. Sources outside generations/
 * and the frozen serving base are deliberately beyond this collector's scope. */
export async function collectHistoryGenerations(
  store: HistoryGcStore,
  { write = false, now = Date.now() }: { write?: boolean; now?: number } = {},
) {
  const prior = observations(await store.read(HISTORY_GC_CHECKPOINT), now);
  const next: Record<string, Observation> = {};
  const scopes = [];
  for (const network of NETWORKS)
    for (const table of TABLES) {
      const pinned = await roots(store, network, table);
      const prefix = `${ROOT}${network}/${table}/generations/`;
      const listing = await store.list(prefix, "/");
      if (
        listing.objects.length ||
        listing.prefixes.length > 2048 ||
        new Set(listing.prefixes).size !== listing.prefixes.length
      )
        throw new Error("Invalid generation inventory");
      const unselected = [];
      for (const key of listing.prefixes) {
        const generation = key.slice(prefix.length, -1);
        if (
          key !== prefix + generation + "/" ||
          !/^[a-f0-9]{64}$/.test(generation)
        )
          throw new Error("Generation crosses scope");
        if (pinned.selected.has(generation)) continue;
        next[key] = prior[key] || { since: now, checked: 0 };
        unselected.push(key);
      }
      scopes.push({ network, table, pinned, unselected });
    }
  // Persist the first observation even if a later exact-identity fence fails.
  // A dry run never advances the collector's grace period.
  if (write)
    await store.write(HISTORY_GC_CHECKPOINT, {
      version: 1,
      observations: next,
    });
  let inspected = 0,
    candidates = 0,
    deleted = 0,
    deletedBytes = 0;
  const eligible = scopes
    .flatMap((scope) => scope.unselected.map((prefix) => ({ scope, prefix })))
    .filter(({ prefix }) => now - next[prefix].since >= OBSERVATION_GRACE)
    .sort(
      (a, b) =>
        next[a.prefix].checked - next[b.prefix].checked ||
        a.prefix.localeCompare(b.prefix),
    );
  for (const { scope, prefix } of eligible.slice(0, MAX_GENERATIONS)) {
    inspected++;
    next[prefix].checked = now;
    const listed = (await store.list(prefix)).objects;
    if (
      !listed.length ||
      listed.length > MAX_OBJECTS ||
      new Set(listed.map((o) => o.key)).size !== listed.length ||
      listed.some(
        (o) =>
          !o.key.startsWith(prefix) ||
          !o.etag ||
          !Number.isSafeInteger(o.size) ||
          o.size < 0 ||
          !Number.isFinite(Date.parse(o.last_modified)) ||
          Date.parse(o.last_modified) >= now - OBJECT_GRACE,
      )
    )
      continue;
    const proofs = listed.filter((o) =>
      /^publication-proof-[a-f0-9]{40}\.json$/.test(o.key.slice(prefix.length)),
    );
    if (!proofs.length) continue;
    const proof = record(await store.read(proofs[0].key));
    const block = record(proof.blockManifest);
    const manifest = listed.find(
      (o) => o.key === prefix + "block-manifest.json",
    );
    const generation = prefix.split("/").at(-2);
    const first = proof.firstBlock,
      last = proof.lastBlock;
    if (
      proof.version !== 1 ||
      proof.generation !== generation ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      (first as number) <= scope.pinned.segments[0].lastBlock ||
      (first as number) > (last as number) ||
      (last as number) > scope.pinned.segments.at(-1)!.lastBlock ||
      block.key !== manifest?.key ||
      block.etag !== manifest?.etag ||
      block.bytes !== manifest?.size
    )
      continue;
    candidates += listed.length;
    if (!write || deleted + listed.length > MAX_OBJECTS) continue;
    const refreshed = (await store.list(prefix)).objects;
    if (identity(listed) !== identity(refreshed))
      throw new Error("History candidate identity changed");
    // Keep the proof and its block manifest until the final batch so an
    // interrupted deletion can be qualified again from its surviving proof.
    const guards = new Set([manifest!.key, ...proofs.map((o) => o.key)]);
    const ordered = [
      ...listed.filter((o) => !guards.has(o.key)),
      ...listed.filter((o) => guards.has(o.key)),
    ];
    for (let offset = 0; offset < ordered.length; offset += 100) {
      if (
        (await roots(store, scope.network, scope.table)).identity !==
        scope.pinned.identity
      )
        throw new Error("History selection changed during collection");
      const batch = ordered.slice(offset, offset + 100);
      await store.remove(batch.map((o) => o.key));
      deleted += batch.length;
      deletedBytes += batch.reduce((sum, o) => sum + o.size, 0);
    }
    if ((await store.list(prefix)).objects.length)
      throw new Error("History deletion readback failed");
    if (
      (await roots(store, scope.network, scope.table)).identity !==
      scope.pinned.identity
    )
      throw new Error("History selection changed during collection");
    delete next[prefix];
  }
  if (write)
    await store.write(HISTORY_GC_CHECKPOINT, {
      version: 1,
      observations: next,
    });
  return {
    write,
    observed: Object.keys(next).length,
    inspected,
    candidates,
    deleted,
    deletedBytes,
  };
}

export function cloudflareHistoryGcStore(
  accountId: string,
  apiToken: string,
): HistoryGcStore {
  const base = `${r2ApiBaseUrl()}/accounts/${accountId}/r2/buckets/metagraphed-artifacts/objects`;
  let nextRequest = 0;
  async function request(
    url: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown | null> {
    const wait = Math.max(0, nextRequest - Date.now());
    nextRequest = Date.now() + wait + 400;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `History maintenance ${method} returned HTTP ${response.status}`,
      );
    if (Number(response.headers.get("content-length")) > 16 * 1024 * 1024)
      throw new Error("History metadata exceeds read bound");
    return response.json();
  }
  const objectUrl = (key: string) =>
    `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async list(prefix, delimiter) {
      const objects: RegistryObject[] = [],
        prefixes: string[] = [],
        seen = new Set<string>();
      let cursor = "";
      do {
        const query = new URLSearchParams({
          prefix,
          per_page: "1000",
          ...(delimiter ? { delimiter } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const result = record(await request(`${base}?${query}`));
        if (result.success !== true || !Array.isArray(result.result))
          throw new Error("History listing failed");
        for (const item of result.result) {
          const o = record(item);
          if (
            typeof o.key !== "string" ||
            !o.key.startsWith(prefix) ||
            typeof o.etag !== "string" ||
            typeof o.size !== "number" ||
            typeof o.last_modified !== "string"
          )
            throw new Error("Invalid history object");
          objects.push({
            key: o.key,
            etag: o.etag,
            size: o.size,
            last_modified: o.last_modified,
          });
        }
        const info = record(result.result_info);
        if (
          (typeof info.is_truncated !== "boolean" &&
            !(
              info.is_truncated === undefined &&
              info.cursor === undefined &&
              delimiter &&
              Array.isArray(info.delimited) &&
              result.result.length + info.delimited.length < 1000
            )) ||
          (info.delimited !== undefined &&
            (!Array.isArray(info.delimited) ||
              info.delimited.some((p) => typeof p !== "string")))
        )
          throw new Error("Invalid history pagination");
        prefixes.push(...((info.delimited as string[] | undefined) || []));
        cursor =
          info.is_truncated && typeof info.cursor === "string"
            ? info.cursor
            : "";
        if (
          (info.is_truncated && !cursor) ||
          (cursor && seen.has(cursor)) ||
          seen.size >= 50
        )
          throw new Error("History inventory exceeds pagination bound");
        seen.add(cursor);
      } while (cursor);
      return { objects, prefixes };
    },
    read: (key) => request(objectUrl(key)),
    async write(key, value) {
      if (key !== HISTORY_GC_CHECKPOINT)
        throw new Error("Invalid history checkpoint key");
      const result = record(await request(objectUrl(key), "PUT", value));
      if (result.success !== true)
        throw new Error("History checkpoint write failed");
    },
    async remove(keys) {
      if (
        !keys.length ||
        keys.length > 100 ||
        new Set(keys).size !== keys.length ||
        keys.some(
          (k) =>
            !/^metagraph\/indexed-history\/v1\/(mainnet|testnet)\/(blocks|extrinsics|chain_events|account_events)\/generations\/[a-f0-9]{64}\/[^\r\n]+$/.test(
              k,
            ),
        )
      )
        throw new Error("Invalid history delete scope");
      const result = record(await request(base, "DELETE", keys));
      if (
        result.success !== true ||
        !Array.isArray(result.result) ||
        JSON.stringify(result.result.map((o) => record(o).key).sort()) !==
          JSON.stringify([...keys].sort())
      )
        throw new Error("History delete receipt mismatch");
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const write = process.argv.includes("--write");
  if (write && process.env.METAGRAPH_R2_GC_PUBLISH_LOCK !== "1")
    throw new Error("History collection requires the publish concurrency lock");
  const { accountId, apiToken } = requireCloudflareCredentials();
  console.log(
    JSON.stringify(
      await collectHistoryGenerations(
        cloudflareHistoryGcStore(accountId, apiToken),
        { write },
      ),
    ),
  );
}
