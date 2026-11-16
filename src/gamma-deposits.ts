// The gamma-deposits serving builders (#13164) -- shared by the REST handler,
// the GraphQL resolver and the MCP tool, so the three surfaces cannot drift.
// Pure + exported for tests; callers resolve the store (the native seam in
// gamma-deposits-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The deposit state's writers -- the
// engine's SubtensorModule.GammaDeposits decode -- land separately (#13164
// defers them), so an empty result is not "no Gamma deposits exist": it is
// "the deposit capture has not run", and `deposit_count: null` with an empty
// `deposits` is how the artifact says so. Balances are u64 atomic units as
// decimal strings; a missing cap stays null rather than claiming a measured
// zero ceiling.
import { selectedGammaDepositsStore } from "./gamma-deposits-store.ts";
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

function formatDeposit(row: Row): Row | null {
  const coldkey = typeof row?.coldkey === "string" ? row.coldkey : "";
  const hotkey = typeof row?.hotkey === "string" ? row.hotkey : "";
  const netuid = nonNegativeInt(row?.netuid);
  const balance = u64TextOrNull(row?.balance);
  // A row missing any of its key parts or its balance names no deposit the
  // chain defines; drop it rather than serve a deposit that cannot be acted
  // on.
  if (
    coldkey === "" ||
    hotkey === "" ||
    netuid === null ||
    netuid > 65535 ||
    balance === null
  )
    return null;
  return {
    coldkey,
    hotkey,
    netuid,
    balance,
    spender:
      typeof row?.spender === "string" && row.spender !== ""
        ? row.spender
        : null,
    daily_cap: u64TextOrNull(row?.daily_cap),
    closed_at: nonNegativeInt(row?.closed_at),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildGammaDeposits(rows: readonly Row[] | null): Row {
  const deposits = (rows ?? [])
    .map((row) => formatDeposit(row))
    .filter((row): row is Row => row !== null);
  // Newest stamp across the rows: the state is written per deposit, so one
  // capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const deposit of deposits) {
    const stamp = deposit.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    deposit_count: deposits.length > 0 ? deposits.length : null,
    captured_at: newest,
    deposits,
  };
}

/**
 * The chain's deposit rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling chain routes never have.
 */
export async function loadGammaDeposits(env: unknown): Promise<Row[] | null> {
  const store = selectedGammaDepositsStore(env);
  if (!store) return null;
  try {
    return await store.rows();
  } catch (error) {
    console.error("gamma deposits store read failed:", error);
    return null;
  }
}
