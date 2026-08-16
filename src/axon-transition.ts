// What "a UID lost a reachable axon" means -- in one place (#11394).
//
// ## The drift this closes had already shipped
//
// #11399 widened the removal derivation from a POPULATED axon to a REACHABLE
// one: a miner that moves to RFC 5737 documentation space has stopped serving
// exactly as much as one that cleared the field. The derivation was widened.
// The SQL that decides which slots the derivation ever SEES was not.
//
// src/axon-removals-loader.ts narrows ~936,000 neuron-days down to the slots
// worth pulling, and it narrowed on PRESENCE -- `prev_axon <> '' AND axon IS
// NULL`. A slot that only ever moved routable -> unroutable never matched, so
// it was never fetched, so the widened rule never ran on it.
//
// MEASURED ON NEON 2026-08-16, over the 30 retained days:
//
//   slots with a reachability drop                    1,483
//   slots with a presence drop (all that was fetched) 1,410
//   slots invisible to the loader entirely              103
//
//   confirmed removals                                  224
//     ...delivered to the derivation                    145
//     ...LOST to the narrowing                           79   35%
//   of which moved-unroutable                           130
//     ...LOST to the narrowing                           79   61%
//
// Every one of the 79 was a move, and SN126 is 78 of them: the feed served 50
// removals against 128 confirmed -- 50 is what production returned when this
// was found, which is how the model above was checked rather than assumed. The
// widening shipped and was 61% inert for the case it was built for, and nothing
// said so, because the two rules lived in two files and only one was edited.
//
// ## What is shared here, and what is deliberately NOT
//
// SHARED: the day sequence, the loss predicate, and the mechanism split. Those
// are claims about the chain, and two answers to them is the defect above.
//
// NOT SHARED: the confirmation rule. src/axon-removal-derivation.ts requires a
// later reading of the same hotkey still unreachable, because a one-day absence
// is indistinguishable from a missed poll and an archive must not file one as a
// teardown. The watchdog must NOT adopt it: the watchdog exists to explain a
// count drop observed TODAY, and a rule needing tomorrow's reading would leave
// the triggering day permanently unexplained. Different jobs, honestly
// different rules -- so this module carries the transition and neither
// consumer's verdict.
//
// ## The invariant, and why it is one-directional
//
// The narrowing may be WIDER than the derivation (it over-fetches a slot the
// derivation then discards, which costs rows and nothing else) but it must
// never be NARROWER, because a slot that is not fetched cannot be judged at
// all. tests/axon-transition.test.ts pins that direction on real Postgres.

import { axonAddressSql, ROUTABLE_AXON_SQL } from "./axon-routable.ts";

/**
 * The per-slot day sequence every axon-loss reader starts from.
 *
 * `extraWhere` is appended to the fixed `snapshot_date >= ?` bound and must
 * carry placeholders only -- the one caller that passes it builds a
 * `netuid IN (?, ?, ...)` list from integers it has already filtered, never an
 * interpolated value.
 *
 * `prev_address` rather than `prev_axon` because every consumer wanted the
 * address: taking it here means the port is split ONCE, by the same
 * last-colon rule as `splitAxon`. The watchdog previously did its own
 * `split_part(prev_axon, ':', 1)`, which reads an IPv6 announcement's first hex
 * group as the whole address and merges unrelated hosts into one (#11379).
 */
export function axonSequenceSql(extraWhere = ""): string {
  return (
    "SELECT netuid, uid, snapshot_date, hotkey, axon, " +
    `(${ROUTABLE_AXON_SQL}) AS routable, ` +
    `LAG(${ROUTABLE_AXON_SQL}) OVER w AS prev_routable, ` +
    "LAG(hotkey) OVER w AS prev_hotkey, " +
    `LAG(${axonAddressSql("axon")}) OVER w AS prev_address ` +
    "FROM neuron_daily WHERE snapshot_date >= ?" +
    (extraWhere ? ` AND ${extraWhere}` : "") +
    " WINDOW w AS (PARTITION BY netuid, uid ORDER BY snapshot_date)"
  );
}

/**
 * A reachable axon became unreachable -- whether or not a field was cleared.
 *
 * The first reading of a slot has a NULL `prev_routable`, so this is NULL there
 * rather than true, and three-valued logic drops it from every `FILTER` and
 * `WHERE` for free. That is the wanted answer: we did not observe a transition,
 * we observed a beginning.
 */
export const AXON_LOSS_SQL = "prev_routable AND NOT routable";

/**
 * The slot changed hands, so the loss belongs to the deregistration family.
 *
 * Decided BEFORE the other two: on a reused UID the newcomer's axon says
 * nothing about the miner that left, and counting it here would report one
 * event twice under two names. 93.8% of raw drops are this.
 */
export const AXON_VIA_REUSE_SQL = "hotkey IS DISTINCT FROM prev_hotkey";

/** The same miner is still in the slot, so the loss is about that miner. */
export const AXON_SAME_HOTKEY_SQL = "hotkey = prev_hotkey";

/**
 * Still announcing, just nowhere anyone can reach -- a move, not a withdrawal.
 *
 * Only meaningful alongside `AXON_LOSS_SQL`, which has already established that
 * whatever is announced is unroutable. Kept apart from the loss predicate
 * because it partitions the losses rather than selecting them.
 */
export const AXON_MOVED_SQL = "axon IS NOT NULL AND axon <> ''";
