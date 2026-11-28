// metagraphed-data-api must not bundle the main Worker, the MCP server or
// GraphQL (#10238).
//
// ## What this exists to have caught
//
// data-api sits near Cloudflare's ~400 ms Worker STARTUP CPU limit. When it is
// over, deploys fail with:
//
//     ✘ Your Worker failed validation because it exceeded startup limits.
//       - Error: Script startup exceeded CPU time limit.  [code: 10021]
//
// and they fail NON-DETERMINISTICALLY, because startup CPU is judged on
// Cloudflare's validating host: a Worker at the edge passes or fails with that
// host's load. #10355 failed once and passed on a byte-identical retry; #10375
// failed twice. That is what makes this class so expensive to diagnose — it
// reads as flaky CI for as long as you let it.
//
// The cause was two CONSTANT imports:
//
//   workers/data-api.ts  -> src/mcp-server.ts            (one rate-limit number)
//   src/alert-triggers.ts -> workers/chain-firehose-hub.ts (four topic names)
//                         -> src/graphql.ts -> src/mcp-server.ts -> workers/api.ts
//
// For those, data-api bundled the MCP server (697 KiB), GraphQL (388 KiB) and
// workers/api.ts (352 KiB) -- 5.0 MB of first-party source once transitive
// imports are counted, against 3.3 MB after. Cutting both took the Worker from
// 1072 KiB gzip / ~600 ms module init to 377 KiB / ~190 ms.
//
// ## Why the assertion is on the import GRAPH
//
// Not on bundle bytes and not on a timing: bytes are a poor proxy (the earlier
// investigation in #10121 correctly observed the failing bundle was SMALLER
// than main's and concluded size was irrelevant — startup CPU tracks how much
// code RUNS at import, not how much exists), and a timing assertion would be
// flaky in CI for exactly the reason the deploys are.
//
// The graph is the thing that actually changed and the thing a future edit
// would change again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";

const workdir = mkdtempSync(path.join(tmpdir(), "data-api-graph-"));
const metafile = path.join(workdir, "meta.json");

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

/** data-api's real module graph, from esbuild rather than from a grep. */
function inputs(
  entry = "workers/data-api.ts",
  portable = false,
): Record<string, { bytes: number }> {
  execFileSync(
    "npx",
    [
      "esbuild",
      entry,
      "--bundle",
      "--format=esm",
      portable ? "--platform=browser" : "--platform=node",
      `--metafile=${metafile}`,
      "--outfile=/dev/null",
      "--log-level=error",
      "--external:cloudflare:workers",
      ...(portable ? [] : ["--external:node:*"]),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(readFileSync(metafile, "utf8")).inputs;
}

const graph = inputs();

describe("data-api's bundle boundary", () => {
  test("the graph was actually resolved", () => {
    // Without this the assertions below pass on an empty object, which is the
    // usual way a scanning check stops checking.
    assert.ok(
      Object.keys(graph).length > 100,
      `only ${Object.keys(graph).length} inputs resolved -- esbuild failed?`,
    );
    assert.ok(graph["workers/data-api.ts"], "its own entry point is missing");
  });

  for (const forbidden of [
    "src/pg-rpc-usage.ts",
    "src/pg-rpc-usage-reader.ts",
    "src/pg-producer-store.ts",
    "src/pg-raw-capture.ts",
    "src/pg-state-export.ts",
    "scripts/generate-export-projection.ts",
    "src/semantic-index-pg.ts",
    "src/sqlite-document-decoder.ts",
    "src/neuron-document-preparation.ts",
    "src/pg-neuron-snapshot.ts",
    "src/pg-neuron-capture.ts",
    "src/pg-neuron-live.ts",
    "src/pg-neuron-summaries.ts",
    "src/pg-neuron-view.ts",
    "src/pg-validator-enrichment.ts",
    "src/pg-subnet-enrichment.ts",
    "src/pg-validator-history.ts",
    "src/sqlite-metric-value.ts",
    "src/pg-subnet-status-hub.ts",
    "src/pg-rate-limits.ts",
    "src/pg-daily-quota.ts",
    "src/account-block-pg.ts",
    "src/account-identity-pg.ts",
    "src/account-usage-pg.ts",
    "src/account-usage-read-pg.ts",
    "src/native-account-state.ts",
    "src/native-alerter.ts",
    "src/native-alert-outbound.ts",
    "src/native-buffered-response.ts",
    "src/native-request.ts",
    "src/pg-alerter-owner.ts",
    "src/native-auth-controls.ts",
    "src/pg-neuron-history.ts",
    "src/pg-neuron-daily-view.ts",
    "src/pg-neuron-metrics.ts",
    "src/pg-neuron-aggregates.ts",
    "src/archive-catalog-pg.ts",
    "src/archive-content-fs.ts",
    "src/mcp-server.ts",
    "src/projection-write-store.ts",
    "src/root-basket-pg.ts",
    "src/pg-pool.ts",
    "src/pg-store-runtime.ts",
    "src/native-mcp-sessions.ts",
    "src/pg-mcp-session-store.ts",
    "src/native-ai-inference.ts",
    "schemas-src/native-inference-http.ts",
    "src/native-chain-firehose.ts",
    "src/native-chain-head.ts",
    "src/native-chain-websocket.ts",
    "src/pg-chain-firehose-store.ts",
    "src/native-store-export.ts",
    "src/raw-capture-d1.ts",
    "src/raw-capture-sync.ts",
    "src/account-balance.ts",
    "src/chain-burn.ts",
    "src/subnet-burn-history.ts",
    "src/network-parameters.ts",
    "src/chain-rpc.ts",
    "src/chain-rpc-admission.ts",
    "src/graphql.ts",
    "generated/graphql/schema.ts",
    "workers/api.ts",
    "workers/chain-firehose-hub.ts",
  ]) {
    test(`does not bundle ${forbidden}`, () => {
      assert.ok(
        !graph[forbidden],
        `workers/data-api.ts pulls in ${forbidden} ` +
          `(${((graph[forbidden]?.bytes ?? 0) / 1024).toFixed(0)} KiB of source ` +
          `that runs at import). That is what put this Worker over the startup ` +
          `CPU limit in #10238. Find the edge with:\n` +
          `  npx esbuild workers/data-api.ts --bundle --metafile=meta.json ...\n` +
          `and move whatever constant or type is being reached for into a LEAF ` +
          `module -- src/api-tiers.ts and src/chain-firehose-topics.ts are the ` +
          `two that already exist for this reason.`,
      );
    });
  }

  test("first-party source stays well under what broke it", () => {
    // A backstop for an edge nobody thought to name above. MEASURED rather than
    // guessed, because the first draft of this threshold was a guess and it was
    // wrong by a factor of three: the five named modules are ~1.7 MB on their
    // own, but their transitive closure was 5.0 MB.
    //
    //   before the fix   8328 KiB of first-party source
    //   after            3280 KiB
    //
    // The graph measured 4,496 KiB in 2026-08 after ordinary feature growth;
    // Indexed chain windows (#12281) add 16,140 source bytes: the graph is
    // 4,755,632 bytes. Extracting capture-floor constants also removes an
    // eager ingestion dependency, so the compiled bundle grows only 300 bytes
    // (101 gzip bytes) from main. Keep a narrow source-growth backstop; the
    // named checks still reject every module from the original regression.
    // Native account-history folds add the packed-feed reader graph (28,801
    // source bytes versus the qualified module-analytics base). esbuild emits
    // only 1,695 additional bytes / 300 gzip bytes; no router, ingestion cron,
    // GraphQL or MCP module enters this graph. Keep the named boundaries above.
    // The separately owned retained-block reader/receiver adds 12,873 source
    // bytes, 7,852 minified bytes and 2,106 gzip bytes over 3b7c504a1. Its
    // source graph is 4,806,255 bytes; none of the forbidden imports changes.
    // Receipt-guarded usage flushes bring the measured graph to 4,819,172
    // bytes. Their leaf helper adds no router, ingestion, GraphQL or MCP
    // dependency; the named boundaries remain mandatory above.
    // The native neuron receipt adds 5,165 source bytes to that measured
    // graph (4,824,337 total), without adding any forbidden module.
    // Explicit retained-store selection adds 2,647 source bytes (4,826,984
    // total). The PostgreSQL implementation remains outside this Worker graph.
    // Explicit Root basket selection measures 4,830,140 source bytes versus
    // 4,829,554 on main (f6f4b681), with 571 minified / 182 gzip bytes added.
    // Its PostgreSQL adapter and process pool remain outside this Worker.
    // The combined subnet-status, archive-selection and auth-control helpers
    // measure 4,837,225 source bytes on d69e34e2 versus 4,832,833 on 8a8ce69b:
    // +4,392 source / 950 minified / 261 gzip bytes. All forbidden native
    // implementations remain absent. Keep only 4,775 source bytes of margin.
    // Daily history plus native metric selection measures 4,842,603 source
    // bytes: metrics adds 2,610 source / 972 minified / 181 gzip bytes over
    // the qualified daily-history head 4cdeb932. Native decoders and PostgreSQL
    // adapters remain forbidden; keep 2,397 source bytes of margin.
    // Complete account-family selection adds 4,932 source / 1,398 minified /
    // 412 gzip bytes over dbc5eaee, for 4,847,535 source bytes total. Only its
    // selectors enter the Worker; all PostgreSQL implementations stay absent.
    // Keep 465 source bytes of margin for this independently measured change.
    // Native aggregate selection adds 751 source bytes over 4585f5f9, to
    // 4,848,286. The minified size is unchanged and gzip is 2 bytes smaller;
    // the native implementation remains absent. Keep 1,714 source bytes spare.
    // Native capture selection adds 1,803 source / 396 minified / 186 gzip
    // bytes over f5ce2286, for 4,850,089 source bytes. Its PostgreSQL writer
    // and SQLite codec remain absent. Keep 1,911 source bytes of margin.
    // Native live selectors add 1,169 source / 371 minified / 96 gzip bytes
    // on the aggregate-only base. Their codec and adapters stay outside the
    // Worker graph; preserve the existing source cap after composition.
    // Native summary selection adds 1,807 source / 512 minified / 129 gzip
    // bytes over af34dc12, totaling 4,853,065 source bytes. Its PostgreSQL
    // adapter and pinned codec remain absent; keep 1,935 bytes of margin.
    // Native canonical-view selection adds 4,984 source / 2,271 minified /
    // 515 gzip bytes over 728e0f12, for 4,858,423 source bytes. The native
    // PostgreSQL adapter and SQLite decoder remain outside this graph.
    // Native producer selection adds 5,132 source / 1,599 minified / 318 gzip
    // bytes over 4de15dcf, totaling 4,863,555 source bytes. Its PostgreSQL
    // factory and all existing forbidden implementations stay out of this
    // graph; retain 1,445 source bytes of margin for this measured change.
    // Initial native relational qualification added 3,760 source / 1,303 minified /
    // 526 gzip bytes over decb73ba, for 4,867,315 source bytes. The native
    // implementations remain excluded; only the bounded SQL selector joins.
    // Native daily-view dispatch adds 7,542 source / 2,689 minified / 650 gzip
    // bytes over 704ed13a, for 4,875,014 source bytes. PostgreSQL daily view
    // implementation and the SQLite codec remain excluded from this graph.
    // Native enrichment dispatch adds 8,668 source / 2,944 minified / 717 gzip
    // bytes over a1bccf61, for 4,884,654 source bytes. The PostgreSQL
    // enrichment implementation remains outside this graph.
    // Native subnet economics dispatch adds 6,428 source / 2,209 minified /
    // 479 gzip bytes over 1f53f990, for 4,891,082 source bytes. The native
    // joined reader and SQLite decoder remain excluded from this graph.
    // Native validator history selection adds 2,183 source / 825 minified /
    // 151 gzip bytes over d2db7911, for 4,893,265 source bytes. The paged
    // PostgreSQL reader and its scalar codec remain excluded from this graph.
    // Native table-export selection adds 953 source / 386 minified / 63 gzip
    // bytes over 347bc45a, for 4,894,218 source bytes. The PostgreSQL exporter
    // and pinned decoder remain outside the Worker graph.
    // The mechanism (mechid) dimension (#13162) adds 5,628 source bytes over
    // a1263f71, for 4,899,846: the shared scope stamp (mechanism-scope.ts),
    // the subnet-mechanisms builders and store selector, and the grown neuron
    // schema prose. The PostgreSQL mechanisms store (pg-subnet-mechanisms.ts)
    // and every previously forbidden native implementation remain outside this
    // graph; keep 2,154 source bytes of margin for this measured change.
    // The stake-v2 serving slices (#13163) add 4,551 source bytes over
    // 59bff494, for 4,904,397: the subnet-alpha-dividends and account-locks
    // builders and store selectors plus their route/tool prose. The
    // PostgreSQL stores (pg-subnet-alpha-dividends.ts, pg-stake-locks.ts)
    // stay outside the graph; keep 2,603 source bytes of margin.
    // The basket serving slice (#13163) adds 6,091 source bytes over
    // 2c2c18ca, for 4,910,488: the validator-baskets builders and loaders
    // plus their route/tool prose. root-basket-pg.ts stays forbidden above,
    // and the capture-write module (node:crypto) stays out -- the fund cap
    // is restated as a pinned literal for exactly that reason. Keep 2,512
    // source bytes of margin.
    // The root-claim basket-claim era (#13163) adds 1,767 source bytes over
    // 28a9c277, for 4,912,255: the basket_claims block in
    // account-root-claim.ts, the kind-filtered hot-tier read, and the grown
    // route/tool prose. Nothing new enters the graph -- both modules were
    // already in it; keep 2,745 source bytes of margin.
    // The Gamma serving slice (#13164) adds 10,707 source bytes over
    // 4707fa14, for 4,922,962: the subnet-gamma / gamma-deposits /
    // subnet-services builders and store selectors plus their route/tool
    // prose. The PostgreSQL stores (pg-subnet-gamma.ts,
    // pg-gamma-deposits.ts, pg-subnet-services.ts) stay outside the graph;
    // keep 2,538 source bytes of margin.
    // The on-chain TAO/USD oracle (#13164) adds 1,397 source bytes over
    // e635a993, for 4,924,359: the tao-usd-oracle builder and store selector
    // plus the grown tao-usd route/tool prose. pg-tao-usd-oracle.ts stays
    // outside the graph; keep 2,641 source bytes of margin.
    // The Swap/AlphaAssets serving slice (#13165) adds 4,689 source bytes
    // over 803e22b7, for 4,929,048: the subnet-swap / subnet-alpha-assets
    // builders and store selectors plus their route/tool prose. The
    // PostgreSQL stores (pg-subnet-swap.ts, pg-subnet-alpha-assets.ts) stay
    // outside the graph; keep 2,452 source bytes of margin.
    // The LimitOrders serving slice (#13165) adds 2,999 source bytes over
    // 85172bfa, for 4,932,047: the subnet-limit-orders builder and store
    // selector plus their route/tool prose. pg-subnet-limit-orders.ts stays
    // outside the graph; keep 2,453 source bytes of margin.
    // The identity-v2 labelling slice (#13166) adds 1,501 source bytes over
    // c5e4ecc9, for 4,934,674: the storage-version helper and its emission in
    // the identity builders plus the grown identity schema prose. Nothing new
    // enters the graph -- both identity modules were already in it; keep
    // 2,526 source bytes of margin.
    // The coldkey-swap serving slice (#13166) adds 5,677 source bytes over
    // 8c9ad938, for 4,940,351: the coldkey-swaps builders and store selector
    // plus their route/tool prose. The PostgreSQL store (pg-coldkey-swaps.ts)
    // stays outside the graph; keep 2,649 source bytes of margin.
    // The account-plane serving slice (#13166) adds 6,155 source bytes over
    // 91bd43f1, for 4,946,506: the proxies/multisigs/child-key-detail
    // builders and store selectors plus their route/tool prose. The
    // PostgreSQL stores (pg-proxies.ts, pg-multisigs.ts, pg-child-keys.ts)
    // stay outside the graph; keep 2,494 source bytes of margin.
    // The #13040 interim slice adds 2,541 source bytes over 13a6dcd2a, for
    // 4,949,047: the withAccountKeysSql refusal seam and its contract prose,
    // and account-kind scoping on the four cross-kind reads (#11573). Nothing
    // new enters the graph; keep 2,553 source bytes of margin.
    // The #13019 slice-2 consumers add 9,324 source bytes over 7d741a901, for
    // 4,958,709. TWO MODULES ENTER THE GRAPH, which the named checks above
    // confirm are the only ones: src/axon-transition-pg.ts (5,004) and
    // src/axon-transition-store.ts (1,870). Unlike the pg-* stores in the
    // entries above, the axon family's dialect SQL builders are imported
    // DIRECTLY by their consumers rather than reached through a binding --
    // src/axon-transition-d1.ts (3,909) has always been in this graph for the
    // same reason, because the consumers compose the sequence from the shared
    // definition instead of asking a store to answer the question. The
    // remaining 2,450 bytes are the watchdog's and loader's own native arms
    // and prose. Keep 2,491 source bytes of margin.
    // The #9792 anchored-window repair adds 2,580 source bytes over
    // a6b3f7a6c, for 4,961,289: readAnchoredWindow and its reasoning in
    // src/iso-date-window.ts, which FOUR readers now share -- the three that
    // still carried the SQLite-only `date(MAX(snapshot_date), ?)`, plus
    // workers/data-api.ts's neuronDailyWindowBounds, which had reached the
    // same answer by a second copy of the algorithm and now delegates. That
    // delegation is why the net is under half the helper's own size: the
    // worker sheds four hand-spelled statements and the three readers shed
    // their bounds SQL, against which the helper carries one extra branch so a
    // non-ISO anchor keeps the whole range (the parity
    // tests/pg-neuron-daily-view.pg18.ts asserts). Nothing new enters the
    // graph; all five modules were already in it.
    // THE CEILING THEN TIGHTENS, because the next change deletes rather than
    // adds: retiring the four unreachable neuron_daily loaders (#13019 slice
    // 3 -- nothing called them, the api Worker proxies to data-api and says so
    // at workers/request-handlers/entities.ts:3047) takes 6,769 source bytes
    // OUT, for 4,954,520. A ratchet that only ever rises stops measuring
    // anything, so a deletion lowers it: 2,480 source bytes of margin, below
    // where this slice started.
    // The PostgreSQL-untypable text key gains one owner, +1,164 source bytes
    // over e38f3c723, for 4,957,734. Four native read paths each carried their
    // own copy of the detection (`/\0|[\uD800-\uDFFF]/u`, three of them
    // naming the result `exceptional`) and two carried their own copy of the
    // protocol that follows from it -- bind `bytea`, compare through
    // `convert_to(column,'UTF8')`. src/pg-sql.ts now owns both; the four sites
    // shed their copies, which is why the net is under a third of what the
    // helpers and their comment weigh.
    //
    // This one RISES, where #13240's retirement lowered it, and the trade is
    // worth naming: the alternative to the comment is deleting the knowledge
    // to save bytes, which is how four undocumented copies happened. A
    // contract about data PostgreSQL cannot store is the wrong place to
    // economise. Keep 2,512 source bytes of margin.
    // The chain core's shadow write (ADR 0029 phase 1, #13287) rises it again,
    // +1,212 source bytes in src/chain-detail-neon-write.ts, for 4,961,481:
    // the mirror both of the lane's writers come through also writes each
    // stored batch into the typed chain tables. Its writer is a type-only
    // import there (the state bindings build it), so nothing new enters the
    // graph. Same 2,512 bytes of margin.
    // The block-detail hot tier reads the chain core (ADR 0029 phase 1b,
    // #13287): +14,975 source bytes, for 4,976,456 -- every statement in
    // src/chain-detail-hot-tier.ts gains its chain-core twin, kept with its
    // documentation in src/chain-core-read.ts (CHAIN_CORE_DETAIL: the views,
    // the coverage window, the account index's two ordered scans), which holds
    // no dependency of its own and enters the graph with it. Same 2,512 bytes
    // of margin.
    // The block reads route past an unanswerable retained copy (ADR 0029
    // phase 1b): +2,608 source bytes, for 4,979,129 -- resolveReadBlocksSeam
    // and its documentation in src/blocks-seam.ts (+2,444), whose chain-core
    // coverage query is already in the graph through src/chain-core-read.ts,
    // and the hot tier's note that it routes on it (+164). Same 2,512 bytes
    // of margin.
    // The emission split family (MET-7365, runtime spec 497): +4,786 source
    // bytes, for 4,983,915, all of it declarations -- the two routes' and
    // artifacts' contract entries and their mainnet-only listing in
    // src/contracts.ts (+3,446), the no-query listing in
    // schemas-src/route-queries.ts (+397), the path patterns in
    // workers/config.ts (+362), the two computed-tier patterns in
    // src/artifact-storage.ts (+354) and the parts pattern's sample in
    // src/openapi-sample.ts (+227). The store, the builders and the capture
    // stay out of data-api's graph. Same 2,512 bytes of margin.
    // The commitments family (MET-7365, runtime spec 497): +5,112 source
    // bytes, for 4,989,027, all of it declarations -- the two routes' and
    // artifacts' contract entries and their mainnet-only listing in
    // src/contracts.ts (+3,087), the page query and the no-query listing in
    // schemas-src/route-queries.ts (+699), the page bounds in
    // src/route-limits.ts (+508), the path patterns in workers/config.ts
    // (+509) and the two computed-tier patterns in src/artifact-storage.ts
    // (+309). The bounds live in route-limits.ts so the store seam stays out
    // of the graph with the store, the builders and the capture. Same 2,512
    // bytes of margin.
    const firstParty = Object.entries(graph)
      .filter(([k]) => /^(src|workers|schemas-src|generated)\//.test(k))
      .reduce((sum, [, v]) => sum + v.bytes, 0);
    assert.ok(
      firstParty < 4_991_539,
      `first-party source in data-api's bundle is ${firstParty} bytes; ` +
        `something large was re-imported. See the named checks above.`,
    );
  });
});

test("indexed chain windows do not import capture cron wiring or route contracts", () => {
  const graph = inputs("src/indexed-chain-windows.ts");
  assert.ok(graph["src/raw-capture-floors.ts"]);
  for (const forbidden of [
    "src/raw-capture-sync.ts",
    "src/contracts.ts",
    "workers/config.ts",
  ])
    assert.ok(!graph[forbidden], `history reader imports ${forbidden}`);
});

test("websocket worker bundles without Node compatibility", () => {
  const graph = inputs("workers/wss-lb.ts", true);
  assert.ok(graph["workers/wss-lb.ts"]);
});
