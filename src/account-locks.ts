// The account-locks serving builders (#13163) -- shared by the REST handler,
// the GraphQL resolver and the MCP tool, so the three surfaces cannot drift.
// Pure + exported for tests; callers resolve the store (the native seam in
// account-locks-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The lock state's writers -- the engine's
// SubtensorModule.Lock / HotkeyLock / DecayingLock / OwnerLock decode --
// land separately (#13163 defers them), so an empty result is not "this
// account holds no locks": it is "the lock capture has not run", and
// `lock_count: null` with an empty `locks` is how the artifact says so.
import { selectedAccountLocksStore } from "./account-locks-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formatLock(row: Row): Row | null {
  const hotkey = typeof row?.hotkey === "string" ? row.hotkey : "";
  const kind = typeof row?.kind === "string" ? row.kind : "";
  const netuid = nonNegativeInt(row?.netuid);
  const amount = u64TextOrNull(row?.amount);
  // A row missing any of its key parts or its amount names no lock the chain
  // defines; drop it rather than serve a lock that cannot be acted on.
  if (hotkey === "" || kind === "" || netuid === null || amount === null)
    return null;
  return {
    hotkey,
    netuid,
    kind,
    amount,
    maturity_block: nonNegativeInt(row?.maturity_block),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildAccountLocks(
  rows: readonly Row[] | null,
  ss58: unknown,
): Row {
  const locks = (rows ?? [])
    .map((row) => formatLock(row))
    .filter((row): row is Row => row !== null);
  // Newest stamp across the rows: the state is written per lock, so one
  // capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const lock of locks) {
    const stamp = lock.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    ss58,
    lock_count: locks.length > 0 ? locks.length : null,
    captured_at: newest,
    locks,
  };
}

/**
 * One account's lock rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling account routes never have.
 */
export async function loadAccountLocks(
  env: unknown,
  ss58: string,
): Promise<Row[] | null> {
  const store = selectedAccountLocksStore(env);
  if (!store) return null;
  try {
    return await store.rows(ss58);
  } catch (error) {
    console.error("account locks store read failed:", error);
    return null;
  }
}
