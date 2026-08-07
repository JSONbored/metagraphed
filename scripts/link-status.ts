// Build-side reader for the link-rot store the daily cron writes
// (src/link-status-sync.ts). Mirrors scripts/github-signals.ts exactly: R2
// store first (the cron's fresh copy), committed seed second, empty last.
//
// The seed materialization is not an optimization. The publish build holds the
// R2 credentials and reads the store; the publish job's later `npm run
// validate` step runs CREDENTIAL-LESS against the restored registry/ tree. Both
// must see the same snapshot or the validation gates would judge artifacts
// built from data they cannot read. Writing the store back to the seed path is
// what carries it across — the same travel-with-the-artifacts design the native
// snapshot, candidate inputs and github-signals already use.

import path from "node:path";
import {
  isConfirmedDeadLink,
  LINK_STATUS_R2_KEY,
  type LinkStatusRecord,
} from "../src/link-status-core.ts";
import { readGeneratedStoreJson } from "./r2-rest.ts";
import { readJson, repoRoot, stableStringify, writeJson } from "./lib.ts";

type Row = Record<string, unknown>;

export const linkStatusPath = path.join(
  repoRoot,
  "registry/generated/link-status.json",
);

export async function readLinkStatusStore(): Promise<Row | null> {
  const doc = await readGeneratedStoreJson(LINK_STATUS_R2_KEY);
  return doc && Array.isArray(doc.links) ? (doc as Row) : null;
}

export async function loadLinkStatusRecords(): Promise<LinkStatusRecord[]> {
  const storeDoc = await readLinkStatusStore();
  if (storeDoc) {
    const seeded: Row | null = await readJson(linkStatusPath).catch(() => null);
    if (stableStringify(seeded) !== stableStringify(storeDoc)) {
      await writeJson(linkStatusPath, storeDoc).catch(() => undefined);
    }
  }
  const doc: Row | null =
    storeDoc ?? (await readJson(linkStatusPath).catch(() => null));
  return Array.isArray(doc?.links) ? (doc.links as LinkStatusRecord[]) : [];
}

/**
 * The URLs the lane has confirmed dead — LINK_DEAD_STRIKES consecutive
 * failures, not one bad night.
 *
 * A cold or never-run store yields an EMPTY set, which demotes nothing. That is
 * the correct degraded mode: "we have no link verdicts" must never be read as
 * "no link is dead" in one direction or "everything is dead" in the other, and
 * an empty set is the only one of those that cannot cause harm.
 */
export function deadLinkUrls(records: LinkStatusRecord[]): Set<string> {
  return new Set(
    records
      .filter((record) => isConfirmedDeadLink(record))
      .map((record) => record.url),
  );
}
