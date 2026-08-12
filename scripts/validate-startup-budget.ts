// The Worker-startup budget gate (#10900).
//
// Worker startup CPU is capped at 400ms by the platform, and it is spent
// evaluating every module the entry reaches STATICALLY. On 2026-08-12 that
// spend had quietly grown to ~403ms — one static edge (discovery.ts →
// agent-tool-specs.ts → mcp-server.ts → graphql.ts) had re-pinned both
// mega-modules to startup — and every `wrangler versions upload` became a
// coin flip that failed with code 10021, which read as "Workers Builds is
// stalled" for days before anyone opened a build log.
//
// This gate measures what the platform actually charges for: the wall-clock
// cost of evaluating the entry's static graph, here in Node. Node wall time
// is not workerd CPU time, but the two move together for this workload (the
// cost is JS module evaluation, not I/O): the broken graph measured ~737ms in
// Node against ~403ms of workerd CPU; the fixed graph ~423ms against a
// comfortably passing upload. The threshold sits between those states — a
// re-pinned mega-module blows straight past it, while normal growth does not
// have to be re-litigated per commit.
//
// A regression here is ALWAYS one of two things, and both have one fix:
//   1. a new static import chain from the entry to src/mcp-server.ts or
//      src/graphql.ts — find it (the BFS in #10900 shows how) and make the
//      importing call site lazy, like workers/api.ts's /mcp and /graphql
//      routes and workers/chain-firehose-hub.ts's schema already are;
//   2. genuinely new module-scope work — move it behind first use.
import { pathToFileURL } from "node:url";

// A GROSS backstop, not the primary signal — wall time varies with the
// hardware running it (the fixed graph measured 321ms on an M-series laptop
// and 607ms on a CI runner in the same hour; the broken graph ~737ms locally,
// so ~1.4s on that runner). The hardware-independent signal is the deferred
// check below: whether the heavy module was already evaluated does not depend
// on how fast the machine evaluated it. This threshold exists only to catch
// a regression so large the lazy check alone might not name it (a NEW heavy
// module that never had a deferral to assert).
const BUDGET_MS = 1500;

const startedAt = Date.now();
await import(pathToFileURL("workers/api.ts").href);
const elapsedMs = Date.now() - startedAt;

// The two modules that must never ride the static graph: if either is already
// evaluated, importing it again is ~free — so a measurable second cost is the
// PROOF they stayed lazy, independent of the wall-clock threshold above.
const graphqlStartedAt = Date.now();
await import(pathToFileURL("src/graphql.ts").href);
const graphqlMs = Date.now() - graphqlStartedAt;

if (elapsedMs > BUDGET_MS) {
  console.error(
    `startup budget: FAIL — evaluating workers/api.ts's static graph took ` +
      `${elapsedMs}ms against the ${BUDGET_MS}ms budget. The platform caps ` +
      `Worker startup CPU at 400ms and fails every version upload past it ` +
      `(code 10021), which presents as Workers Builds silently not deploying ` +
      `(#10900). Find the new static edge to a heavy module and defer it at ` +
      `the call site.`,
  );
  process.exit(1);
}

if (graphqlMs < 50) {
  console.error(
    `startup budget: FAIL — src/graphql.ts evaluated in ${graphqlMs}ms after ` +
      `the entry, meaning the entry's STATIC graph already evaluated it. ` +
      `Some import chain from workers/api.ts reaches it statically again ` +
      `(#10900's exact regression); find the edge and defer it.`,
  );
  process.exit(1);
}

console.log(
  `startup budget: OK — entry static graph ${elapsedMs}ms (budget ` +
    `${BUDGET_MS}ms); graphql module stayed lazy (${graphqlMs}ms deferred).`,
);
