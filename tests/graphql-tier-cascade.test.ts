// #9540: every GraphQL resolver whose tier flag is RETIRED must reach a
// cold-tier/artifact loader, or it can only ever answer zero.
//
// Eight tier flags read "retired" in wrangler.jsonc, and tryPostgresTier
// returns null for all of them. A resolver whose ladder is
// `tryPostgresTier(...) ?? build...([])` is therefore structurally empty in
// production -- and it answers with a schema-valid zero and an empty `errors`
// array, so a consumer cannot tell it apart from "the chain has no data".
// Measured live before the fix: blocks, extrinsics, sudo,
// governance_config_changes, chain_calls, chain_signers, chain_stake_flow,
// chain_transfer_pairs, account_events, chain_transfers and chain_alpha_volume
// ALL returned 0 while REST and MCP served real rows for every one.
//
// This is a SOURCE-STRUCTURE test on purpose. The defect is "a rung is
// missing", which is a property of how the ladder is written, and a runtime
// test would need a hand-built fixture per resolver -- 100+ of them -- which is
// exactly the maintenance burden that let the rungs drift apart in the first
// place. The repo already gates on source structure this way
// (validate:no-hand-written-mjs, the contract-drift checks).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";

const GRAPHQL_SRC = path.join(process.cwd(), "src/graphql.ts");
const WRANGLER = path.join(process.cwd(), "wrangler.jsonc");

/** A resolver reaching one of these can never get rows from that tier. Read
 * from wrangler.jsonc rather than hardcoded, so flipping a flag back to a live
 * value automatically narrows what this test polices. */
function retiredFlags(): Set<string> {
  const text = fs.readFileSync(WRANGLER, "utf8");
  const flags = new Set<string>();
  for (const match of text.matchAll(
    /"(METAGRAPH_[A-Z_]*SOURCE)"\s*:\s*"([a-z]+)"/g,
  )) {
    if (match[2] === "retired") flags.add(match[1]);
  }
  return flags;
}

interface Resolver {
  name: string;
  body: string;
  usesRetiredTier: boolean;
  hasLoader: boolean;
}

/**
 * Resolver bodies, each ending at ITS OWN closing brace rather than at the next
 * resolver's opening line.
 *
 * Delimiting on "the next `  name(`" looks equivalent and is not: the gap
 * between two resolvers holds the NEXT one's doc comment, so a body would
 * absorb it. That is not hypothetical -- it made this very test miss
 * `extrinsics`, whose successor's comment mentions `loadChainEventsFeed`, so
 * the resolver read as having a rung it does not have. A guard that
 * under-reports is worse than no guard, so the scan tracks brace depth from the
 * resolver's own opening line instead.
 */
function resolvers(): Resolver[] {
  const lines = fs.readFileSync(GRAPHQL_SRC, "utf8").split("\n");
  const retired = retiredFlags();
  const out: Resolver[] = [];
  for (const [start, line] of lines.entries()) {
    if (!/^ {2}(?:async )?[a-z_0-9]+\(/.test(line)) continue;
    const name = line.match(/^ {2}(?:async )?([a-z_0-9]+)\(/)![1];
    // End at the member's OWN closing line -- `  },` at two-space indent, which
    // prettier guarantees for every member of this object. Brace counting is
    // the obvious alternative and gets this wrong: a destructured parameter
    // list (`{ window, limit }: Args,`) opens and closes on one line, so depth
    // returns to zero before the body has even started and the slice stops two
    // lines in.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}\},?$/.test(lines[i])) {
        end = i + 1;
        break;
      }
    }
    out.push(buildResolver(name, lines.slice(start, end).join("\n"), retired));
  }
  return out;
}

function buildResolver(
  name: string,
  body: string,
  retired: Set<string>,
): Resolver {
  return {
    name,
    body,
    usesRetiredTier:
      /tryPostgresTier\(/.test(body) &&
      [...retired].some((flag) => body.includes(flag)),
    // The rung: any shared cold-tier / artifact reader. `loadChainActivity` and
    // friends do not follow the ColdTier/FromArtifact suffix convention, so
    // match the loader prefix rather than the suffix. Comments count as body
    // text, which is why the brace-accurate slice above matters.
    hasLoader: /\bload[A-Z][A-Za-z]*\s*\(/.test(body),
  };
}

/**
 * Resolvers on a retired tier with no loader, that are NOT defects.
 *
 * A name belongs here only when the tier genuinely does not exist for anyone --
 * verified by the MCP twin ALSO bottoming out in an empty builder. GraphQL
 * matching MCP's empty is correct in that case; the missing data is a separate
 * question about the lane, not a wiring bug on this surface.
 *
 * Every entry needs a reason. The list must SHRINK: an entry that no longer
 * matches a broken resolver fails the test below, so a fix cannot silently
 * leave a stale exemption behind.
 */
/**
 * Resolvers still to be wired, tracked against #9540.
 *
 * These ARE defects -- each has a loader its REST/MCP twin already calls, and
 * each currently answers a confident zero in production. They are enumerated
 * here rather than described in prose so the remaining work is enforced: the
 * staleness check below fails once a name no longer belongs, so this list can
 * only ever SHRINK, and the test above still fails for any resolver that is in
 * neither map. A newly-broken resolver cannot hide among them.
 */
const PENDING_WIRING = new Set([
  "subnet_axon_removals",
  "subnet_events",
  "subnet_prometheus",
  "extrinsic",
  "blocks",
  "block",
  "block_extrinsics",
  "block_events",
  "account_prometheus",
  "account_stake_flow",
  "account_registrations",
  "account_serving",
  "account_axon_removals",
  "account_stake_moves",
  "account_weight_setters",
  "account_counterparties",
  "account_transfers",
  "account_extrinsics",
  "account_events",
  "chain_activity",
]);

const NO_TIER_ANYWHERE: Record<string, string> = {
  chain_axon_removals:
    "get_chain_axon_removals falls to buildChainAxonRemovals([]) on MCP too -- no artifact lane exists for it",
  chain_prometheus:
    "get_chain_prometheus falls to buildChainPrometheus([]) on MCP too -- no artifact lane exists for it",
  account:
    "get_account composes from sibling readers rather than one tier loader; not a single missing rung",
  account_entities:
    "get_account_entities composes from sibling readers rather than one tier loader",
  chain_identity_history:
    "no identity-history cold tier exists on any surface; MCP's own ladder ends at the same empty",
  subnet_identity_history:
    "same identity-history lane as chain_identity_history",
};

// Positive control. A pure "nothing is broken" assertion passes just as well
// when the detector matches nothing at all, so pin that it really does classify
// a known-good resolver as having its rung -- chain_weights is the shape the
// broken ones are being fixed toward (src/graphql.ts, tryPostgresTier ->
// loadChainWeightsColdTier -> buildChainWeights([])).
test("the detector recognises a resolver that DOES reach its loader", () => {
  const all = resolvers();
  assert.ok(
    all.length > 50,
    `expected the resolver map to parse, got ${all.length}`,
  );
  const good = all.find((r) => r.name === "chain_weights");
  assert.ok(good, "chain_weights resolver not found -- the parser has drifted");
  assert.equal(
    good.usesRetiredTier,
    true,
    "chain_weights reads a retired tier",
  );
  assert.equal(
    good.hasLoader,
    true,
    "chain_weights reaches loadChainWeightsColdTier",
  );
});

test("no resolver on a retired tier is left with no loader to fall back to", () => {
  const broken = resolvers()
    .filter((r) => r.usesRetiredTier && !r.hasLoader)
    .map((r) => r.name);
  const unexpected = [...new Set(broken)].filter(
    (name) => !(name in NO_TIER_ANYWHERE) && !PENDING_WIRING.has(name),
  );
  assert.deepEqual(
    unexpected,
    [],
    `these resolvers read a retired tier and have no loader, so they can only answer zero:\n  ${unexpected.join("\n  ")}\n` +
      "Wire each to the loader its REST/MCP twin already uses, or add it to " +
      "NO_TIER_ANYWHERE with the evidence that no tier exists for it either.",
  );
});

test("neither exemption list carries a stale entry", () => {
  const broken = new Set(
    resolvers()
      .filter((r) => r.usesRetiredTier && !r.hasLoader)
      .map((r) => r.name),
  );
  const stale = [...Object.keys(NO_TIER_ANYWHERE), ...PENDING_WIRING].filter(
    (name) => !broken.has(name),
  );
  assert.deepEqual(
    stale,
    [],
    `these are exempted but no longer broken -- drop them from NO_TIER_ANYWHERE / PENDING_WIRING: ${stale.join(", ")}`,
  );
});
