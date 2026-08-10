// The ONE composer for /api/v1/accounts/{ss58}/entities. REST, MCP and GraphQL
// all reach the ownership half of the payload through this module and none of
// them decides the tier order itself.
//
// WHY A COMPOSER AND NOT THREE CASCADES. The lakehouse leg was wired into the
// REST handler alone. METAGRAPH_SUBNET_OWNERSHIP_SOURCE is retired, so
// tryPostgresTier declines unconditionally, and MCP and GraphQL fell straight
// to `buildAccountEntities(coldkey, { entities: [] })`: for a coldkey that HAS
// won or lost a subnet they published `ownership_ties: []`, which
// get_account_entities' own description reads as "this coldkey has never
// transferred a subnet". The community-label half is identical on all three
// surfaces, so the response looked fully populated while the on-chain half was
// silently missing.
//
// This is the same shape src/subnet-ownership-answer.ts and
// src/rpc-usage-answer.ts already fixed for their routes, and
// tests/subnet-ownership-surface-parity.test.ts enforces the rule those
// established: a surface may not import a tier reader directly, because
// "which store answers, and what an absence means" is one decision, not three.
//
// THE TIER PROBE STAYS WITH THE SURFACE, deliberately. tryPostgresTier needs a
// Request, and each surface has a different one -- REST forwards the caller's,
// MCP and GraphQL synthesize theirs. So the surface performs its own probe and
// hands the RESULT here; this module owns everything after it, which is the
// part that drifted.
//
// A DECLINE IS NOT AN EMPTY. A cold-tier null means the lakehouse could not be
// read; only after it declines does the schema-stable empty apply. Callers must
// not turn a decline into `[]` themselves -- that is the bug this module exists
// to make unrepresentable.

import { loadAccountEntitiesColdTier } from "./subnet-ownership-cold-tier.ts";
import {
  buildAccountEntities,
  subnetOwnersFromEconomics,
  type SubnetOwnerSnapshot,
} from "./entity-labels.ts";
import { readArtifact } from "../workers/storage.ts";

type Row = Record<string, unknown>;

/** The economics blob, which carries `owner_coldkey` per subnet (#9313). */
const ECONOMICS_ARTIFACT = "/metagraph/economics.json";

export interface AnswerAccountEntitiesOptions {
  coldTier?: typeof loadAccountEntitiesColdTier;
  /** Injected in tests; production reads the economics artifact. */
  owners?: () => Promise<SubnetOwnerSnapshot | null>;
}

/**
 * One coldkey's entity payload, with the ownership ties resolved from whichever
 * store can answer.
 *
 * `tierResult` is the surface's own tryPostgresTier outcome: a payload when the
 * tier answered, null when it declined or is retired.
 *
 * Never returns null -- the empty payload is the documented floor once every
 * store has declined, and it is applied HERE so all three surfaces reach it by
 * the same route.
 */
export async function answerAccountEntities(
  env: unknown,
  coldkey: string,
  tierResult: Row | null | undefined,
  {
    coldTier = loadAccountEntitiesColdTier,
    owners = () => readSubnetOwners(env),
  }: AnswerAccountEntitiesOptions = {},
): Promise<Row> {
  // CURRENT OWNERSHIP IS RESOLVED HERE, not per tier (#9313).
  //
  // The transfer stream can only answer who has TRADED a subnet, and exactly
  // one such event exists chain-wide -- so every store above answered
  // `ownership_ties: []` for coldkeys that plainly own one. The economics blob
  // carries `owner_coldkey` per subnet and is readable whether or not the
  // lakehouse is, which is why the read sits in the composer: the ownership
  // half must not disappear just because the transfer half declined.
  const ownerSnapshot = await owners();

  const answered =
    tierResult ?? ((await coldTier(env as never, coldkey)) as Row | null);

  // A tier that answered already shaped its payload from the transfer stream.
  // Its ties are merged with the owned ones rather than rebuilt, so the tier
  // keeps owning what it is authoritative for and this only adds what it never
  // had access to.
  if (answered) return withOwnedTies(answered, coldkey, ownerSnapshot);

  return buildAccountEntities(coldkey, {
    entities: [],
    owners: ownerSnapshot,
  }) as unknown as Row;
}

/**
 * Fold current-ownership ties into a payload a tier already built.
 *
 * Rebuilt through buildAccountEntities so the ORDER and shape are decided in
 * one place -- a second assembly here would be the "subtly different decoder
 * for the same facts" the cold tier's own note warns against.
 */
function withOwnedTies(
  answered: Row,
  coldkey: string,
  owners: SubnetOwnerSnapshot | null,
): Row {
  if (!owners) return { ...answered, owners_observed_at: null };
  const owned = buildAccountEntities(coldkey, { owners });
  const existing = Array.isArray(answered.ownership_ties)
    ? answered.ownership_ties
    : [];
  const ties = [...owned.ownership_ties, ...existing];
  return {
    ...answered,
    ownership_ties: ties,
    ownership_tie_count: ties.length,
    owners_observed_at: owned.owners_observed_at,
  };
}

/**
 * The owner snapshot, or null when the artifact cannot be read.
 *
 * Null rather than an empty snapshot, so "we could not read who owns what" and
 * "this coldkey owns nothing" stay different answers -- the distinction
 * `owners_observed_at` publishes.
 */
async function readSubnetOwners(
  env: unknown,
): Promise<SubnetOwnerSnapshot | null> {
  // BOTH guards, because they catch different failures. readArtifact reports
  // `{ ok: false }` for a miss or a timeout -- but it THROWS when the binding
  // it reaches for is not there at all (`Cannot read properties of null`), and
  // this route has a documented schema-stable floor that a rejection would turn
  // into a 500. Every one of those outcomes means the same thing to a caller:
  // we could not read who owns what, which `owners_observed_at: null` says.
  try {
    const artifact = await readArtifact(env as never, ECONOMICS_ARTIFACT);
    return artifact.ok ? subnetOwnersFromEconomics(artifact.data) : null;
  } catch {
    return null;
  }
}
