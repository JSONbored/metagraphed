// The ONE composer for the two SubnetIdentitiesV3 timelines --
// /api/v1/subnets/{netuid}/identity-history and /api/v1/chain/identity-history.
// REST, MCP and GraphQL all reach both payloads through this module.
//
// WHY A COMPOSER AND NOT SIX CASCADES. #9153 added the lakehouse leg to
// workers/request-handlers/entities.ts alone. METAGRAPH_SUBNET_IDENTITY_SOURCE
// has no reader (#10190 deleted the call sites; #10893 keeps the config at
// "retired" until a reader exists), so the tier declined unconditionally and
// the other two surfaces fell straight to the empty builder: REST served the frozen verified
// timeline while get_subnet_identity_history / get_chain_identity_history and
// their GraphQL twins reported entry_count 0 and count 0.
//
// get_chain_identity_history's own comment claimed this tool and the REST route
// "never diverge on which tier answered". That sentence was false the moment the
// cold tier landed on one surface only; this module is what makes it true again,
// by leaving no per-surface copy that CAN diverge.
//
// Same shape src/subnet-ownership-answer.ts and src/rpc-usage-answer.ts already
// established, and the rule tests/subnet-ownership-surface-parity.test.ts
// enforces: a surface may not import a tier reader directly.
//
// THE TIER PROBE STAYS WITH THE SURFACE -- tryPostgresTier needs a Request and
// each surface builds its own. The surface probes and hands the RESULT here.
//
// A DECLINE IS NOT AN EMPTY: the schema-stable empty timeline applies only
// after every store has declined, and it is applied here so no surface can
// reach it early.

import {
  loadChainIdentityHistoryColdTier,
  loadSubnetIdentityHistoryColdTier,
} from "./subnet-identity-cold-tier.ts";
import {
  buildSubnetIdentityHistory,
  loadSubnetIdentityHistory,
} from "./subnet-identity-history.ts";
import {
  buildChainIdentityHistory,
  loadChainIdentityHistory,
} from "./chain-identity-history.ts";
import { SUBNET_IDENTITY_HISTORY_TABLES } from "./read-store-tables.ts";
import { readStore } from "./read-store.ts";
import { d1All } from "./analytics-live.ts";

type Row = Record<string, unknown>;

/**
 * The LIVE leg, and why it lives in the composer rather than at the surfaces
 * (#10773).
 *
 * `subnet_identity_history` had no writer from the D1 cutover until
 * 2026-08-11: `syncSubnetIdentityToPostgres` was named as its sole writer in
 * four places and was never written. #10190 removed the tier read on exactly
 * that ground -- it "resolved to null on every request" -- and the frozen
 * lakehouse export became the only leg. The writer landed the same day
 * (#10740 / #10762 and metagraphed-infra#444) and nothing repointed the read:
 * the lane wrote 248 rows at 13:15Z while REST, MCP and GraphQL all still
 * served 2026-07-31, which is 11 days of identity changes that exist and are
 * not served.
 *
 * Put HERE, beside the cold tier, for the reason this module exists at all: a
 * live leg added at one surface is exactly the divergence #9153 created and
 * this composer was written to end. Five call sites pass `null` for
 * `tierResult`; one of them growing a Neon read would leave the other four on
 * the frozen export with nothing to catch it.
 *
 * ORDER: caller-supplied tier, then live, then frozen, then the empty shape.
 * The live store goes AHEAD of the export because the export is a one-time
 * 2026-08-02 seed that never advances -- preferring it would mean the newest
 * identity change is permanently 2026-07-31 no matter what the chain does.
 * And a live-store MISS still falls through, so the frozen history stays
 * readable for the range that predates the writer.
 */
async function liveStore(env: unknown): Promise<D1Runner | null> {
  const db = readStore(env as never, SUBNET_IDENTITY_HISTORY_TABLES);
  return db ? (sql, params) => d1All(db as never, sql, params) : null;
}

type D1Runner = (
  sql: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

/** A live read that throws is a MISS, not an outage. The frozen leg and the
 * schema-stable empty shape are both still ahead, and a cold Hyperdrive or an
 * unmigrated table must not turn a readable timeline into a 500. */
async function tryLive<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** An empty live read is a MISS, not an answer.
 *
 * The distinction matters only while the table is filling: the writer landed
 * on 2026-08-11 and the frozen export holds everything before it, so a netuid
 * whose identity last changed in July has zero live rows and a real frozen
 * timeline. Treating the empty read as authoritative would publish "this
 * subnet has never changed its identity" for most of the network. */
function nonEmpty(result: Row | null, key: "entries" | "changes"): Row | null {
  const rows = result?.[key];
  return Array.isArray(rows) && rows.length > 0 ? result : null;
}

export interface AnswerSubnetIdentityHistoryOptions {
  coldTier?: typeof loadSubnetIdentityHistoryColdTier;
  /** Injectable so a test can drive the live leg without a store. */
  live?: (env: unknown) => Promise<D1Runner | null>;
}

export interface AnswerChainIdentityHistoryOptions {
  coldTier?: typeof loadChainIdentityHistoryColdTier;
  live?: (env: unknown) => Promise<D1Runner | null>;
}

/** One subnet's identity timeline from whichever store can answer. */
export async function answerSubnetIdentityHistory(
  env: unknown,
  netuid: number,
  tierResult: Row | null | undefined,
  query: { limit: number; offset?: number | null; cursor?: unknown },
  {
    coldTier = loadSubnetIdentityHistoryColdTier,
    live = liveStore,
  }: AnswerSubnetIdentityHistoryOptions = {},
): Promise<Row> {
  const db = tierResult ? null : await tryLive(() => live(env));
  const fresh = db
    ? nonEmpty(
        await tryLive(
          async () =>
            (await loadSubnetIdentityHistory(db, netuid, {
              limit: query.limit,
              offset: query.offset ?? null,
              cursor: query.cursor ?? null,
            })) as Row,
        ),
        "entries",
      )
    : null;
  return (
    tierResult ??
    fresh ??
    ((await coldTier(env as never, netuid, {
      limit: query.limit,
      offset: query.offset ?? null,
      cursor: query.cursor ?? null,
    })) as Row | null) ??
    (buildSubnetIdentityHistory([], netuid, {
      limit: query.limit,
      offset: query.offset ?? null,
      nextCursor: null,
    }) as unknown as Row)
  );
}

/** The network-wide identity feed from whichever store can answer. */
export async function answerChainIdentityHistory(
  env: unknown,
  tierResult: Row | null | undefined,
  query: { limit?: unknown } = {},
  {
    coldTier = loadChainIdentityHistoryColdTier,
    live = liveStore,
  }: AnswerChainIdentityHistoryOptions = {},
): Promise<Row> {
  const db = tierResult ? null : await tryLive(() => live(env));
  const fresh = db
    ? nonEmpty(
        await tryLive(
          async () =>
            (await loadChainIdentityHistory(db, {
              limit: query.limit as number | null,
            })) as unknown as Row,
        ),
        "changes",
      )
    : null;
  return (
    tierResult ??
    fresh ??
    ((await coldTier(env as never, { limit: query.limit })) as Row | null) ??
    (buildChainIdentityHistory([], {
      limit: query.limit,
    }) as unknown as Row)
  );
}
