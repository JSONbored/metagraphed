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
function inputs(): Record<string, { bytes: number }> {
  execFileSync(
    "npx",
    [
      "esbuild",
      "workers/data-api.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--metafile=${metafile}`,
      "--outfile=/dev/null",
      "--log-level=error",
      "--external:cloudflare:workers",
      "--external:node:*",
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
    "src/mcp-server.ts",
    "src/graphql.ts",
    "src/graphql-sdl.ts",
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
    // 4,600,000 bytes (~4492 KiB) leaves ~37% headroom for ordinary growth
    // while still failing on a re-import of anything approaching what was
    // removed.
    const firstParty = Object.entries(graph)
      .filter(([k]) => /^(src|workers|schemas-src|generated)\//.test(k))
      .reduce((sum, [, v]) => sum + v.bytes, 0);
    assert.ok(
      firstParty < 4_600_000,
      `first-party source in data-api's bundle is ${(firstParty / 1024).toFixed(0)} KiB; ` +
        `something large was re-imported. See the named checks above.`,
    );
  });
});
