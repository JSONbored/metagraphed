// The stored child-key detail beside the live delegation graph (#13166) --
// shared by the /accounts/{ss58}/children and /parents REST handlers and
// their GraphQL mirrors, so the surfaces cannot drift. Pure + exported for
// tests; callers resolve the store (the native seam in child-keys-store.ts)
// and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The detail's writers -- the engine's
// SubtensorModule.ChildkeyTake / PendingChildKeys / ChildkeyThresholdChecks /
// ChildkeyThresholdSuspended / ChildKeys decode -- land separately (#13166
// defers them), so an unbound or unfilled store serves child_key_detail:
// null, and a bound store serves NULL counts over empty lists rather than
// fabricated zeros. Mainnet-only: the tables carry no network column, so a
// testnet-addressed read declines outright.
import { selectedChildKeysStore } from "./child-keys-store.ts";
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

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// u64 proportion text (0..u64::MAX represents 0..100%) -> a 0..1 float, the
// same split-in-BigInt-space precision discipline as
// child-hotkey-delegation.ts's proportionToFraction, over the store's
// decimal-text crossing instead of a decoded bigint.
const U64_SCALE = 2n ** 64n;
function proportionFraction(text: string): number {
  const raw = BigInt(text);
  return Number(raw / U64_SCALE) + Number(raw % U64_SCALE) / Number(U64_SCALE);
}

/** PerU16 parts of 65535 -> a 0..1 float. */
const PER_U16_SCALE = 65535;

function formatTake(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  const take = nonNegativeInt(row?.take);
  if (netuid === null || netuid > 65535 || take === null || take > 65535)
    return null;
  return {
    netuid,
    take,
    take_fraction: take / PER_U16_SCALE,
    captured_at: toIso(row?.captured_at),
  };
}

function formatPending(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  const child = typeof row?.child === "string" ? row.child : "";
  const proportion = u64TextOrNull(row?.proportion);
  if (netuid === null || netuid > 65535 || child === "" || proportion === null)
    return null;
  return {
    netuid,
    child,
    proportion,
    proportion_fraction: proportionFraction(proportion),
    cool_down_block: nonNegativeInt(row?.cool_down_block),
    captured_at: toIso(row?.captured_at),
  };
}

function formatThreshold(row: Row | undefined): Row | null {
  if (!row || typeof row !== "object") return null;
  const pending_check = boolOrNull(row.pending_check);
  const suspended = boolOrNull(row.suspended);
  const captured_at = toIso(row.captured_at);
  // A row carrying no answer from either map and no stamp says nothing.
  if (pending_check === null && suspended === null && captured_at === null)
    return null;
  return { pending_check, suspended, captured_at };
}

function formatHistory(row: Row): Row | null {
  const netuid = nonNegativeInt(row?.netuid);
  const parent = typeof row?.parent === "string" ? row.parent : "";
  const child = typeof row?.child === "string" ? row.child : "";
  const proportion = u64TextOrNull(row?.proportion);
  if (
    netuid === null ||
    netuid > 65535 ||
    parent === "" ||
    child === "" ||
    proportion === null
  )
    return null;
  return {
    netuid,
    parent,
    child,
    proportion,
    proportion_fraction: proportionFraction(proportion),
    captured_at: toIso(row?.captured_at),
  };
}

export interface ChildKeyDetailRows {
  takes: Row[];
  pending: Row[] | null;
  threshold: Row[] | null;
  history: Row[];
}

/**
 * The stored detail block for the children view (ss58 is the parent): its
 * own per-subnet take rows (as a child hotkey elsewhere), the pending
 * relation queue it scheduled, its threshold bookkeeping, and its ChildKeys
 * capture history.
 */
export function buildChildKeyDetail(
  rows: ChildKeyDetailRows | null,
): Row | null {
  if (rows === null) return null;
  const takes = rows.takes
    .map((row) => formatTake(row))
    .filter((row): row is Row => row !== null);
  const pending = (rows.pending ?? [])
    .map((row) => formatPending(row))
    .filter((row): row is Row => row !== null);
  const history = rows.history
    .map((row) => formatHistory(row))
    .filter((row): row is Row => row !== null);
  return {
    takes,
    take_count: takes.length > 0 ? takes.length : null,
    pending,
    pending_count: pending.length > 0 ? pending.length : null,
    threshold: formatThreshold(rows.threshold?.[0]),
    history,
    history_count: history.length > 0 ? history.length : null,
  };
}

/**
 * The stored detail block for the parents view (ss58 is the child): its own
 * per-subnet take rows and the child-keyed capture history. The pending
 * queue and the threshold bookkeeping are parent-keyed state and live on the
 * children view.
 */
export function buildParentKeyDetail(
  rows: ChildKeyDetailRows | null,
): Row | null {
  if (rows === null) return null;
  const takes = rows.takes
    .map((row) => formatTake(row))
    .filter((row): row is Row => row !== null);
  const history = rows.history
    .map((row) => formatHistory(row))
    .filter((row): row is Row => row !== null);
  return {
    takes,
    take_count: takes.length > 0 ? takes.length : null,
    history,
    history_count: history.length > 0 ? history.length : null,
  };
}

/**
 * One account's stored child-key detail rows through the native seam, or
 * null.
 *
 * Null for "no store bound" (today's deployed Workers), for a store read
 * that failed, AND for a testnet-addressed read (the tables carry no network
 * column) -- all render as the same schema-stable child_key_detail: null,
 * because a caller cannot act differently on the three and an error body
 * would turn a degraded tier into a hard failure the routes never have.
 */
export async function loadChildKeyDetail(
  env: unknown,
  ss58: string,
  view: "children" | "parents",
  mainnet: boolean,
): Promise<ChildKeyDetailRows | null> {
  if (!mainnet) return null;
  const store = selectedChildKeysStore(env);
  if (!store) return null;
  try {
    if (view === "children") {
      return {
        takes: await store.takes(ss58),
        pending: await store.pending(ss58),
        threshold: await store.threshold(ss58),
        history: await store.historyByParent(ss58),
      };
    }
    return {
      takes: await store.takes(ss58),
      pending: null,
      threshold: null,
      history: await store.historyByChild(ss58),
    };
  } catch (error) {
    console.error("child keys store read failed:", error);
    return null;
  }
}
