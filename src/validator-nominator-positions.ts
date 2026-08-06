// The POSITIONS basis for /validators/{hotkey}/nominators (#9617).
//
// The default basis is FLOW: src/validator-nominators.ts derives the nominator
// list from StakeAdded/StakeRemoved over a 7d/30d/90d window. That answers "who
// staked to this validator recently" and, by construction, cannot see anyone
// who staked before the window and has not touched it since -- a dormant
// delegator is invisible, and a long-standing one shows as smaller than they
// are because only their in-window movement is counted.
//
// That is the same defect #9557 fixed one level up: /subnets/{netuid}/holders
// exists because the per-subnet view was reading `neurons` and missing everyone
// not registered there. Here the flow window is what does the missing.
//
// The position ledger holds the standing answer. `nominator_positions` is keyed
// (coldkey, hotkey, netuid), so filtering by HOTKEY -- the one direction no
// route reads it in -- gives every coldkey currently delegating to this
// validator and how much, whenever they staked. `idx_nominator_positions_hotkey_netuid`
// was added by #9558 for the sink's own EXISTS check and is used by no route;
// this is the read it was shaped for.
//
// ## THE TWO BASES ARE DIFFERENT QUESTIONS, NOT TWO QUALITIES OF ONE ANSWER
//
// Flow is TAO moved in a window. Positions are ALPHA held right now, per
// subnet, valued against a proven pool pass. They are different units over
// different time semantics, so this does not "improve" the flow numbers or
// replace them -- `?basis=` selects which question is being asked, and the
// response says which one it answered. Silently switching the default would
// change what every existing caller's numbers mean.
//
// Gated on the same completeness proof as its siblings: a partial `hotkey_alpha`
// underprices a nominator rather than dropping them, so a ranking built on it
// is plausible and wrong.

import {
  latestCompleteHotkeyAlphaPass,
  mayPriceHotkeyAlpha,
} from "./hotkey-alpha-completeness.ts";

type Row = Record<string, unknown>;

/** The two questions this route can answer. */
export const NOMINATOR_BASES = ["flow", "positions"] as const;
export const DEFAULT_NOMINATOR_BASIS = "flow";

export interface NominatorPositionsDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
      first?(): Promise<unknown>;
    };
    first?(): Promise<unknown>;
  };
}

export type NominatorPositionsDecline = "pool_totals_unproven" | "unavailable";

export interface NominatorPositionsRead {
  rows: Row[];
  capturedAt: number | null;
  decline: NominatorPositionsDecline | null;
}

/**
 * Every coldkey currently delegating to one hotkey, with the alpha each holds
 * per subnet folded into a per-coldkey total.
 *
 * Alpha is summed PER SUBNET into `subnets[]` and never across them: each
 * subnet's alpha is a different token, and #8803 is what a cross-subnet alpha
 * sum produced last time. The per-coldkey ordering key is therefore the number
 * of subnets and then the largest single-subnet holding, not a total.
 */
export function nominatorPositionsSql(alphaCapturedAt: number): string {
  return (
    "SELECT np.coldkey AS coldkey, np.netuid AS netuid," +
    " SUM(np.share_fraction * ha.total_alpha) AS alpha," +
    " MAX(np.captured_at) AS positions_captured_at" +
    " FROM nominator_positions np" +
    " JOIN hotkey_alpha ha ON ha.hotkey = np.hotkey" +
    " AND ha.netuid = np.netuid" +
    ` AND ha.captured_at = ${alphaCapturedAt}` +
    " WHERE np.hotkey = ?" +
    " GROUP BY np.coldkey, np.netuid" +
    " ORDER BY alpha DESC"
  );
}

/** One validator's current delegators, or a decline. Never throws. */
export async function loadNominatorPositions(
  db: NominatorPositionsDb | null | undefined,
  hotkey: string,
): Promise<NominatorPositionsRead> {
  const declined = (
    decline: NominatorPositionsDecline,
  ): NominatorPositionsRead => ({ rows: [], capturedAt: null, decline });
  if (!db?.prepare) return declined("unavailable");

  const alpha = await latestCompleteHotkeyAlphaPass(
    db as unknown as Parameters<typeof latestCompleteHotkeyAlphaPass>[0],
  );
  if (!mayPriceHotkeyAlpha(alpha)) {
    return declined(
      alpha.reason === "unavailable" ? "unavailable" : "pool_totals_unproven",
    );
  }
  try {
    const res = await db
      .prepare(nominatorPositionsSql(alpha.capturedAt))
      .bind(hotkey)
      .all?.();
    if (!Array.isArray(res?.results)) throw new Error("positions: no rows");
    return {
      rows: res.results as Row[],
      capturedAt: alpha.capturedAt,
      decline: null,
    };
  } catch {
    return declined("unavailable");
  }
}

/**
 * Shape the positions-basis card. Pure.
 *
 * The row set arrives one row per (coldkey, netuid); this folds it into one
 * entry per coldkey carrying a per-subnet breakdown, because the coldkey is the
 * nominator and the subnet split is what makes the alpha figures readable at
 * all. A `total_alpha` across those subnets is deliberately NOT computed.
 */
export function buildNominatorPositions(
  read: NominatorPositionsRead,
  hotkey: unknown,
  { limit, offset = 0 }: { limit?: number; offset?: number } = {},
): Row {
  const base = {
    schema_version: 1,
    hotkey,
    basis: "positions",
    limit: limit ?? null,
    offset,
  };
  if (read.decline) {
    return {
      ...base,
      nominator_count: null,
      captured_at: null,
      positions_captured_at: null,
      nominators: [],
      degraded: { reason: read.decline },
    };
  }

  const byColdkey = new Map<string, { netuid: number; alpha: number }[]>();
  let positionsCapturedAt: number | null = null;
  for (const r of read.rows) {
    const coldkey = typeof r?.coldkey === "string" ? r.coldkey : null;
    const netuid = intOrNull(r?.netuid);
    const alpha = nonNegativeOrNull(r?.alpha);
    const at = positiveOrNull(r?.positions_captured_at);
    if (
      at !== null &&
      (positionsCapturedAt === null || at > positionsCapturedAt)
    ) {
      positionsCapturedAt = at;
    }
    if (coldkey === null || netuid === null || alpha === null) continue;
    const list = byColdkey.get(coldkey) ?? [];
    list.push({ netuid, alpha: round(alpha) });
    byColdkey.set(coldkey, list);
  }

  const nominators = [...byColdkey.entries()]
    .map(([coldkey, subnets]) => {
      const sorted = [...subnets].sort((a, b) => b.alpha - a.alpha);
      return {
        coldkey,
        subnet_count: sorted.length,
        // The single largest holding, which IS comparable across nominators
        // only when they hold the same subnet -- so the netuid rides with it
        // rather than the number being published bare.
        //
        // Not guarded on `sorted.length`: a coldkey only enters the map when a
        // row survived validation, so the list is non-empty by construction and
        // a guard here would be unreachable code pretending to be caution.
        largest_position: { netuid: sorted[0].netuid, alpha: sorted[0].alpha },
        subnets: sorted,
      };
    })
    // Ranked by breadth, then by the largest single holding. NOT by a summed
    // alpha: adding netuid 4's alpha to netuid 64's is the #8803 bug.
    .sort(
      (a, b) =>
        b.subnet_count - a.subnet_count ||
        b.largest_position.alpha - a.largest_position.alpha ||
        a.coldkey.localeCompare(b.coldkey),
    );

  return {
    ...base,
    // The whole delegator set, never bounded by the page.
    nominator_count: nominators.length,
    captured_at: toIsoOrNull(read.capturedAt),
    positions_captured_at: toIsoOrNull(positionsCapturedAt),
    nominators:
      limit == null
        ? nominators.slice(offset)
        : nominators.slice(offset, offset + limit),
  };
}

function nonNegativeOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIsoOrNull(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
