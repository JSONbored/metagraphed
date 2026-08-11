// #9540/#10320: every RESOLVER, REST HANDLER and MCP TOOL whose tier flag is
// RETIRED must reach a cold-tier/artifact loader, or it can only ever answer
// zero.
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
// ── Why it scans three surfaces and not one (#10320) ───────────────────────
//
// "REST and MCP served real rows for every one" was true of #9540's sample and
// was never a property of the codebase. Prometheus was the counterexample: all
// three surfaces were missing the rung, for the same reason -- each card's twin
// got wired and the card did not.
//
// Widening it immediately found one more, on the surface the old scope could
// not see: `get_subnet_snapshot` embeds a recent-events card whose ladder fell
// straight from the retired tier to `buildSubnetEvents([])`, while the
// standalone `get_subnet_events` reached `answerSubnetEvents`. Verified live on
// SN64, 2026-08-09 -- the snapshot answered `event_count: 0` in the same minute
// its own twin answered ten rows.
//
// EACH SURFACE NEEDS ITS OWN SLICER, and this is the part that has to be right.
// A naive "stop at the next `;`" scan over the same files reports 45 rung-less
// ladders of 126, and probing six of them found four false positives -- a
// ladder split across statements reads as broken. The three slicers below each
// end at the construct's OWN closing line, which is what turns that into the
// nine real findings enumerated at the bottom.
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
const MCP_SRC = path.join(process.cwd(), "src/mcp-server.ts");
const REST_DIR = path.join(process.cwd(), "workers/request-handlers");
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
    // WAS `/tryPostgresTier\(/ && a retired flag` (#10190). That predicate
    // stopped selecting anything the moment the sweep deleted the last dead
    // call: the population went to zero and the gate could no longer fail,
    // which is the exact way #10250 says a gate blinds itself during the
    // sweep it guards.
    //
    // The question is unchanged -- "this ladder's tier was retired, so does it
    // still have a rung?" -- so it now keys on the marker the sweep leaves at
    // every site it emptied. That set is fixed and cannot silently drain: a
    // deleted note is a deleted ladder, and a new dead tier read gets a new
    // note. `retired` still gates it so a note naming a LIVE flag (there are
    // none today, and there should never be) is not counted.
    usesRetiredTier:
      /NO TIER READ \(#10190\)/.test(body) &&
      [...retired].some((flag) => body.includes(flag)),
    // The rung: any shared cold-tier / artifact reader, OR a composer that owns
    // the whole ladder on the resolver's behalf.
    //
    // Both prefixes are needed. `load*` covers the readers, but several routes
    // reach their tier through an `answer*` composer instead --
    // answerSubnetEvents owns the tier order and empty floor for REST, MCP and
    // GraphQL alike, and answerBlockDetail routes a ref across the seam. Matching
    // only `load` reported subnet_events as missing a rung it already had, which
    // would have sent someone to "fix" a correct resolver.
    //
    // Suffix matching is not an option either: loadChainActivity and friends do
    // not follow the ColdTier/FromArtifact convention. Comments count as body
    // text, which is why the brace-accurate slice above matters.
    hasLoader: /\b(?:load|answer)[A-Z][A-Za-z]*\s*\(/.test(body),
  };
}

/**
 * REST handlers, sliced to their OWN column-0 closing brace.
 *
 * `export function handleX(` ... `}` at column zero, which prettier guarantees
 * for a top-level function. Stopping at the next `export function` instead
 * would absorb the gap between two handlers -- the same mistake the resolver
 * slicer documents, and the reason its comment exists.
 */
function restHandlers(retired: Set<string>): Resolver[] {
  const out: Resolver[] = [];
  for (const file of fs.readdirSync(REST_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const lines = fs
      .readFileSync(path.join(REST_DIR, file), "utf8")
      .split("\n");
    for (const [start, line] of lines.entries()) {
      const match = /^export (?:async )?function ([a-zA-Z0-9_]+)\(/.exec(line);
      if (!match) continue;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^\}$/.test(lines[i])) {
          end = i + 1;
          break;
        }
      }
      out.push(
        buildResolver(match[1], lines.slice(start, end).join("\n"), retired),
      );
    }
  }
  return out;
}

/**
 * MCP tools, sliced from their `name:` line to the entry's own `  },`.
 *
 * A tool is an object member of the MCP_TOOLS array, so its closing line is at
 * two-space indent exactly like a GraphQL resolver's -- the same delimiter for
 * the same prettier reason. Keyed on `name:` rather than on `handler(` because
 * the ladder is often built in a helper above the handler, inside the same
 * entry.
 */
function mcpTools(retired: Set<string>): Resolver[] {
  const lines = fs.readFileSync(MCP_SRC, "utf8").split("\n");
  const out: Resolver[] = [];
  for (const [start, line] of lines.entries()) {
    const match = /^ {4}name: "([a-z0-9_]+)",$/.exec(line);
    if (!match) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}\},?$/.test(lines[i])) {
        end = i + 1;
        break;
      }
    }
    out.push(
      buildResolver(match[1], lines.slice(start, end).join("\n"), retired),
    );
  }
  return out;
}

/** Every ladder on every surface, which is the set the assertions run over. */
function ladders(): Resolver[] {
  const retired = retiredFlags();
  return [...resolvers(), ...restHandlers(retired), ...mcpTools(retired)];
}

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
const PENDING_WIRING = new Set<string>([
  // Empty, and kept so the next gap has an obvious home: a resolver found
  // broken goes here with its issue, and the staleness check below forces it
  // back out the moment it is fixed.
]);

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
const NO_TIER_ANYWHERE: Record<string, string> = {
  // ── AXON REMOVALS. `AxonInfoRemoved` has never been emitted -- zero
  // occurrences in the complete decoded stream -- so there is nothing for a
  // cold tier to hold. An empty answer here is the correct answer, and the
  // question of whether the event will ever fire belongs to the lane, not to
  // wiring on any of these three surfaces.
  chain_axon_removals:
    "get_chain_axon_removals falls to buildChainAxonRemovals([]) on MCP too -- no lane exists for it",
  account_axon_removals:
    "get_account_axon_removals falls to buildAccountAxonRemovals([]) on MCP too -- no lane exists for it",
  subnet_axon_removals:
    "get_subnet_axon_removals falls to buildSubnetAxonRemovals(null) on MCP too -- no lane exists for it",
  handleChainAxonRemovals:
    "the REST twin of chain_axon_removals -- same absent lane, same correct empty",
  handleSubnetAxonRemovals:
    "the REST twin of subnet_axon_removals -- same absent lane, same correct empty",
  get_chain_axon_removals:
    "the MCP twin the GraphQL entry above cites as evidence; naming it here keeps the claim checkable from either side",
  get_account_axon_removals:
    "the MCP twin of account_axon_removals -- same absent lane",
  get_subnet_axon_removals:
    "the MCP twin of subnet_axon_removals -- same absent lane",

  // ── PROMETHEUS is no longer here (#10322). The entries said all surfaces
  // "agree, which is what makes this a lane question rather than a wiring
  // bug" -- and that was false: /api/v1/chain/prometheus read the same
  // PrometheusServed stream through CHAIN_PROMETHEUS_ROLLUP and reported
  // netuid 112 with 1 exporter over 30d, while the per-subnet, per-account and
  // GraphQL cards all answered 0 for it. They agreed with each other and
  // disagreed with the chain card. All four now take the same cold rung.
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

test("nothing on a retired tier is left with no loader to fall back to", () => {
  const broken = ladders()
    .filter((r) => r.usesRetiredTier && !r.hasLoader)
    .map((r) => r.name);
  const unexpected = [...new Set(broken)].filter(
    (name) => !(name in NO_TIER_ANYWHERE) && !PENDING_WIRING.has(name),
  );
  assert.deepEqual(
    unexpected,
    [],
    `these read a retired tier and have no loader, so they can only answer zero:\n  ${unexpected.join("\n  ")}\n` +
      "Wire each to the loader its twin on another surface already uses, or " +
      "add it to NO_TIER_ANYWHERE with the evidence that no tier exists for " +
      "it either.",
  );
});

test("neither exemption list carries a stale entry", () => {
  const broken = new Set(
    ladders()
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
