// The composition behind `/api/v1/accounts/{ss58}` -- and the reason it is a
// module rather than three copies of the same six lines (#9263).
//
// THE DEFECT. Measured 2026-08-03 against the chain's top extrinsic signer:
// `/accounts/{ss58}/events` returned 100 events and `/accounts/{ss58}/subnets`
// returned a registration on netuid 46 with 54,085 TAO staked, while
// `/accounts/{ss58}` -- the FIRST page anyone opens for an address -- answered
// `recent_events: 0`, `event_kinds: 0`, `registrations: 0`, and reported
// `meta.source: "chain-events"` while doing it. Not a degraded answer, a wrong
// one: the data was right there, and this route's own siblings were serving it.
//
// TWO LEGS, TWO STORES, ONE CARD. buildAccountSummary composes three sources
// and is null-safe per field, which is exactly what let the card zero itself
// one leg at a time without anything noticing:
//
//   event history (event_count/kinds/recent/first-last)  chain.account_events
//   current registrations                                D1 `neurons`
//   signing activity                                     the extrinsics tier
//
// #9257 gave the first leg its lakehouse reader. This module adds the second
// (the D1 `neurons` read the account's own /subnets route already serves from,
// same SELECT list, same formatRegistration) and, more importantly, makes the
// composition a SINGLE function that REST, MCP and GraphQL all call -- because
// the defect was not any one missing read, it was that three call sites each
// assembled the card themselves and could each be fixed separately, which is
// how one of them ends up a version behind again.
//
// The signing-activity leg stays empty on purpose rather than by omission:
// there is no aggregate reader for it yet (src/extrinsics-cold-tier.ts serves
// the per-account FEED, not the all-time tx_count/fee totals the card wants),
// and inventing one from the feed's first page would publish a `tx_count` that
// is really a page size.
//
// A FAILED READ DECLINES. If a tier that EXISTS cannot answer, this returns
// `gap` and the caller emits a typed 503 -- never a zeroed card. A zeroed card
// is the failure shape this whole issue is about: it says "this account has no
// history" in the same words it would use if that were true.

import {
  buildAccountSummary,
  type AccountSummaryResult,
} from "./account-events.ts";
import { loadAccountSummaryColdTier } from "./account-feeds-cold-tier.ts";
import { isR2SqlConfigured } from "./r2-sql.ts";

/** The D1 surface this module needs -- structural, so tests can hand it a
 * plain object (the same pattern as src/blocks-cold-tier.ts). */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/**
 * The registration read, character-for-character the one DATA_API's D1 leg
 * runs for `/api/v1/accounts/{ss58}/subnets` (workers/data-api.ts's
 * matchNeuronsD1Route). Same columns, same predicate, same order -- so the
 * summary's `registrations` and the /subnets route's `subnets` are the same
 * rows through the same formatRegistration, and cannot come to disagree about
 * where one hotkey is registered.
 */
export const ACCOUNT_REGISTRATIONS_SQL =
  "SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons " +
  "WHERE hotkey = ? ORDER BY netuid";

/**
 * This hotkey's current registrations from D1 `neurons`.
 *
 * `[]` when there is NO binding, `null` when a bound read fails, and the
 * difference matters: a deployment without D1 has no neuron snapshot to be
 * missing, so an empty list is the honest answer there, while a database that
 * is present and erroring is a fault the card must not paper over.
 */
export async function loadAccountRegistrationsD1(
  env: Env | null | undefined,
  ss58: string,
): Promise<Record<string, unknown>[] | null> {
  const db = (env as { METAGRAPH_HEALTH_DB?: D1Like } | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return [];
  try {
    const res = await db.prepare(ACCOUNT_REGISTRATIONS_SQL).bind(ss58).all?.();
    const rows = res?.results;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  } catch {
    return null;
  }
}

export type AccountSummaryAnswer =
  /** Both legs answered; `data` is the assembled card. */
  | { kind: "answer"; data: AccountSummaryResult }
  /** A tier that exists could not answer -- decline, do not zero the card. */
  | { kind: "gap" }
  /** No tier to ask. The caller keeps its schema-stable empty. */
  | { kind: "miss" };

/** The one message every declining surface emits for this route, so REST, MCP
 * and GraphQL diagnose identically rather than in three dialects. */
export function accountSummaryGapMessage(ss58: string): string {
  return (
    `The event history for ${ss58} could not be read right now, so this ` +
    `summary would report zero events, zero event kinds and no registrations ` +
    `for an account that may have many. This is a tier failure, not an ` +
    `account without activity -- retry shortly, or read ` +
    `/api/v1/accounts/${ss58}/events for the same stream.`
  );
}

/** The typed code that decline carries on every surface. */
export const ACCOUNT_SUMMARY_GAP_CODE = "account_summary_unavailable";

/**
 * Assemble one account's summary card from the tiers that are actually there.
 *
 * `miss` is reserved for a deployment with NO lakehouse configured (a
 * self-hoster, CI): there is no chain history to read, so the caller's
 * schema-stable zero card is the correct answer and always was. Every other
 * failure -- a configured lakehouse that could not answer, a bound D1 that
 * threw -- is a `gap`, because in those deployments the rows exist and a zero
 * card is a lie about them.
 *
 * The two legs are read CONCURRENTLY and the card is only built when both
 * answered. Building from one would publish a card that is half measured and
 * half zero, with nothing in the payload to say which half is which.
 */
export async function answerAccountSummary(
  env: Env | null | undefined,
  ss58: string,
): Promise<AccountSummaryAnswer> {
  const [cold, registrations] = await Promise.all([
    loadAccountSummaryColdTier(env, ss58),
    loadAccountRegistrationsD1(env, ss58),
  ]);
  if (cold && registrations) {
    return {
      kind: "answer",
      data: buildAccountSummary(ss58, { ...cold, registrations }),
    };
  }
  if (registrations === null || isR2SqlConfigured(env)) return { kind: "gap" };
  return { kind: "miss" };
}
