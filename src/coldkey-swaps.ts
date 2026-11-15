// The coldkey-swap serving builders (#13166) -- shared by the REST handlers,
// the GraphQL resolvers and the MCP tool, so the surfaces cannot drift. Pure
// + exported for tests; callers resolve the store (the native seam in
// coldkey-swaps-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The v2 swap state's writers -- the
// engine's SubtensorModule.ColdkeySwapAnnouncements / ColdkeySwapDisputes /
// ColdkeySwapReservedDestination / ColdkeySwapV2PolicySnapshots decode and
// the HotkeySuccessor / HotkeyRoot / ColdkeySuccessor / ColdkeyRoot lineage
// decode -- land separately (#13166 defers them), so an empty result is not
// "no swap is pending": it is "the swap capture has not run", and
// `swap_count: null` with an empty `swaps` (or a null `announcement` and
// `policy`) is how the artifacts say so.
import { selectedColdkeySwapsStore } from "./coldkey-swaps-store.ts";

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

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const H256_PATTERN = /^0x[0-9a-f]{64}$/;

function announcementHash(value: unknown): string | null {
  return typeof value === "string" && H256_PATTERN.test(value) ? value : null;
}

export function formatColdkeySwapAnnouncement(row: Row): Row | null {
  const coldkey = typeof row?.coldkey === "string" ? row.coldkey : "";
  // A row without its announcing account names no announcement the chain
  // stores; drop it rather than serve a swap that cannot be attributed.
  if (coldkey === "") return null;
  return {
    coldkey,
    new_coldkey: textOrNull(row?.new_coldkey),
    announcement_hash: announcementHash(row?.announcement_hash),
    announced_at: nonNegativeInt(row?.announced_at),
    execute_at: nonNegativeInt(row?.execute_at),
    disputed: boolOrNull(row?.disputed),
    disputed_at: nonNegativeInt(row?.disputed_at),
    policy_snapshot: boolOrNull(row?.policy_snapshot),
    status: textOrNull(row?.status),
    captured_at: toIso(row?.captured_at),
  };
}

function formatPolicy(row: Row | null | undefined): Row | null {
  if (!row || typeof row !== "object") return null;
  const announcement_delay = nonNegativeInt(row.announcement_delay);
  const reannouncement_delay = nonNegativeInt(row.reannouncement_delay);
  const captured_at = toIso(row.captured_at);
  // A capture carrying neither delay and no stamp says nothing; decline it.
  if (
    announcement_delay === null &&
    reannouncement_delay === null &&
    captured_at === null
  )
    return null;
  return { announcement_delay, reannouncement_delay, captured_at };
}

function newestStamp(rows: readonly Row[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    const stamp = row.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return newest;
}

export interface PendingColdkeySwapRows {
  announcements: Row[];
  policy: Row[];
}

export function buildPendingColdkeySwaps(
  rows: PendingColdkeySwapRows | null,
): Row {
  const swaps = (rows?.announcements ?? [])
    .map((row) => formatColdkeySwapAnnouncement(row))
    .filter((row): row is Row => row !== null);
  const policy = formatPolicy(rows?.policy?.[0] ?? null);
  return {
    schema_version: 1,
    swap_count: swaps.length > 0 ? swaps.length : null,
    captured_at: newestStamp(swaps),
    policy,
    swaps,
  };
}

/**
 * Every in-flight announcement plus the newest delay capture through the
 * native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling account routes never have.
 */
export async function loadPendingColdkeySwaps(
  env: unknown,
): Promise<PendingColdkeySwapRows | null> {
  const store = selectedColdkeySwapsStore(env);
  if (!store) return null;
  try {
    return {
      announcements: await store.pending(),
      policy: await store.policy(),
    };
  } catch (error) {
    console.error("coldkey swaps store read failed:", error);
    return null;
  }
}

export interface AccountColdkeySwapRows {
  announcement: Row[];
  lineage: Row[];
}

function formatColdkeyLineage(row: Row | undefined): Row | null {
  if (!row) return null;
  const successor = textOrNull(row.successor);
  const root = textOrNull(row.root);
  // Neither side of the lineage names anything the chain stores; decline.
  if (successor === null && root === null) return null;
  return { successor, root, captured_at: toIso(row.captured_at) };
}

function formatHotkeyLineage(row: Row): Row | null {
  const netuid = nonNegativeInt(row.netuid);
  const successor = textOrNull(row.successor);
  const root = textOrNull(row.root);
  if (netuid === null || netuid > 65535) return null;
  if (successor === null && root === null) return null;
  return { netuid, successor, root, captured_at: toIso(row.captured_at) };
}

export function buildAccountColdkeySwap(
  rows: AccountColdkeySwapRows | null,
  ss58: unknown,
): Row {
  const announcement = rows?.announcement?.[0]
    ? formatColdkeySwapAnnouncement(rows.announcement[0])
    : null;
  const lineageRows = rows?.lineage ?? [];
  const coldkeyLineage = formatColdkeyLineage(
    lineageRows.find((row) => row.kind === "coldkey"),
  );
  const hotkeyLineage = lineageRows
    .filter((row) => row.kind === "hotkey")
    .map((row) => formatHotkeyLineage(row))
    .filter((row): row is Row => row !== null);
  const stamps = [
    ...(announcement ? [announcement] : []),
    ...(coldkeyLineage ? [coldkeyLineage] : []),
    ...hotkeyLineage,
  ];
  return {
    schema_version: 1,
    ss58,
    announcement,
    lineage: {
      coldkey: coldkeyLineage,
      hotkey: hotkeyLineage,
      hotkey_count: hotkeyLineage.length > 0 ? hotkeyLineage.length : null,
    },
    captured_at: newestStamp(stamps),
  };
}

/** One account's announcement row and lineage rows through the native seam,
 * or null -- same decline contract as loadPendingColdkeySwaps above. */
export async function loadAccountColdkeySwap(
  env: unknown,
  ss58: string,
): Promise<AccountColdkeySwapRows | null> {
  const store = selectedColdkeySwapsStore(env);
  if (!store) return null;
  try {
    return {
      announcement: await store.announcement(ss58),
      lineage: await store.lineage(ss58),
    };
  } catch (error) {
    console.error("coldkey swaps store read failed:", error);
    return null;
  }
}
