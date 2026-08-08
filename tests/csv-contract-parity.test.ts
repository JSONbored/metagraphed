// A route that serves CSV says so, and one that says so serves it (#10090).
//
// The bug this exists to stop: five routes answered `?format=csv` with
// text/csv in production while publishing neither a `format` parameter nor a
// text/csv 200 response — /accounts/{ss58}/history, /blocks/{ref}/events,
// /blocks/{ref}/extrinsics, /subnets/{netuid}/uptime and
// /validators/{hotkey}/nominators. Every one is a real headered projection. A
// consumer generated from openapi.json had no way to discover they existed.
//
// ── Why nothing caught it ───────────────────────────────────────────────────
//
// openapi.json was internally CONSISTENT and wrong on both sides at once: 78
// routes published `format` and exactly the same 78 declared a text/csv
// response, because both are emitted from one `csvResponse: true` flag. Any
// check comparing the contract to itself passes. The disagreement was only ever
// visible against the code that answers the request.
//
// So this drives the real router. `handleRequest` + `createLocalArtifactEnv()`
// is the same in-process seam the CSV export tests in api-coverage already use:
// a full dispatch, no live Worker, and the response's own content-type as the
// answer.
//
// ── The two directions are not symmetric ────────────────────────────────────
//
// SERVES-BUT-UNDECLARED is the defect, and it takes no exemptions: if a route
// answers text/csv here, it must declare it. A new CSV export cannot land
// undocumented.
//
// DECLARED-BUT-NOT-SERVED is weaker evidence, because a route whose rows come
// from a live data tier declines to the schema-stable empty JSON envelope under
// this env rather than emitting a CSV of nothing. That is correct behaviour and
// not something to assert away, so those routes are declared below with a
// reason — and a STALE entry FAILS, the same contract as the MCP-parity and
// schema-opacity allowlists. The list can only shrink.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { type Row } from "./row-type.ts";

/**
 * Path-parameter fixtures.
 *
 * Values that resolve against the built local artifacts, so a route is
 * exercised rather than 404ing before it can answer. A `{param}` with no entry
 * here fails the coverage check below rather than being skipped — an
 * unsubstituted path is a route this gate stopped looking at.
 */
const PATH_FIXTURES: Record<string, string> = {
  "{netuid}": "1",
  "{ss58}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{hotkey}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{ref}": "1000000",
  "{uid}": "0",
  "{slug}": "academia",
  "{date}": "2026-08-01",
  "{tag}": "inference",
  "{surface_id}": "sn-1-apex-healthcheck",
  "{hash}":
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  "{h160}": "0x0000000000000000000000000000000000000000",
  "{id}": "00000000-0000-0000-0000-000000000000",
  "{crowdloan_id}": "0",
};

/**
 * Routes that declare CSV but cannot demonstrate it under the local artifact
 * env, and why. Every entry is a statement someone made; a stale one fails.
 */
const DECLARED_NOT_LOCALLY_SERVABLE: Record<string, string> = {
  // Rows come from the chain-events tier, which this env does not bind. The
  // handler declines to the schema-stable empty JSON envelope rather than
  // emitting a CSV with a header and no rows. Verified live: production
  // answers ?format=csv with text/csv and the block_number,event_index,
  // pallet,method,phase,extrinsic_index,observed_at header.
  "/api/v1/chain-events":
    "rows come from the chain-events tier; unbound here, so the handler " +
    "declines to the empty JSON envelope (production serves text/csv)",
};

const ORIGIN = "https://api.metagraph.sh";

interface Probe {
  path: string;
  status: number;
  csv: boolean;
  declared: boolean;
}

/** Dispatch every plain GET route with ?format=csv and record what came back. */
async function probeRoutes(): Promise<Probe[]> {
  const env = createLocalArtifactEnv() as never;
  const probes: Probe[] = [];
  for (const entry of API_ROUTES as Row[]) {
    const path = String(entry.path);
    // The 42 /api/v1/{network}/… forms are the same handlers behind a prefix,
    // and csv_response rides on the plain entry they are derived from.
    if (entry.method !== "GET" || path.includes("{network}")) continue;
    let concrete = path;
    for (const [token, value] of Object.entries(PATH_FIXTURES)) {
      concrete = concrete.replaceAll(token, value);
    }
    assert.ok(
      !concrete.includes("{"),
      `${path} has a path parameter with no PATH_FIXTURES entry, so this ` +
        "gate would silently stop covering it",
    );
    const response = await handleRequest(
      new Request(`${ORIGIN}${concrete}?format=csv`),
      env,
      {},
    );
    probes.push({
      path,
      status: response.status,
      csv: /^text\/csv/.test(response.headers.get("content-type") ?? ""),
      declared: entry.csv_response === true,
    });
  }
  return probes;
}

const probes = await probeRoutes();

describe("a route that serves CSV declares it (#10090)", () => {
  test("nothing answers text/csv without publishing ?format", () => {
    // The defect direction. No exemptions: an undeclared export is
    // undiscoverable from our own spec, which is the entire finding.
    const undeclared = probes
      .filter((probe) => probe.csv && !probe.declared)
      .map((probe) => probe.path);
    assert.deepEqual(
      undeclared,
      [],
      "these routes answer ?format=csv with text/csv but publish no `format` " +
        "parameter and no text/csv response, so nothing generated from " +
        "openapi.json can reach the export: " +
        undeclared.join(", "),
    );
  });

  test("every route declaring CSV serves it, or says why it cannot here", () => {
    const missing = probes
      .filter((probe) => probe.declared && !probe.csv)
      .map((probe) => probe.path);
    const undeclaredMisses = missing.filter(
      (path) => !(path in DECLARED_NOT_LOCALLY_SERVABLE),
    );
    assert.deepEqual(
      undeclaredMisses,
      [],
      "these routes publish a text/csv response the handler did not produce: " +
        undeclaredMisses.join(", "),
    );
  });

  test("the exemption list is not stale", () => {
    // Same contract as the MCP-parity allowlist: an entry that has started
    // working must be deleted, so the list can only shrink.
    const stale = Object.keys(DECLARED_NOT_LOCALLY_SERVABLE).filter((path) => {
      const probe = probes.find((candidate) => candidate.path === path);
      return !probe || probe.csv;
    });
    assert.deepEqual(
      stale,
      [],
      "these DECLARED_NOT_LOCALLY_SERVABLE entries now serve CSV locally (or " +
        "name a route that no longer exists) and must be removed: " +
        stale.join(", "),
    );
  });

  test("the sweep is not vacuous", () => {
    // Guards the guard. Every assertion above passes trivially on an empty
    // probe set, and the failure mode of a dispatch sweep is silence.
    assert.ok(
      probes.length >= 190,
      `only ${probes.length} routes were dispatched; the sweep stopped ` +
        "covering the surface",
    );
    const served = probes.filter((probe) => probe.csv).length;
    assert.ok(
      served >= 60,
      `only ${served} routes answered text/csv, so the CSV path is not being ` +
        "exercised and the first assertion proves nothing",
    );
  });

  test("the five routes this issue found are among them", () => {
    // Named rather than left to the generic sweep: these are the ones that
    // were undeclared, and a failure here should say so.
    for (const path of [
      "/api/v1/accounts/{ss58}/history",
      "/api/v1/blocks/{ref}/events",
      "/api/v1/blocks/{ref}/extrinsics",
      "/api/v1/subnets/{netuid}/uptime",
      "/api/v1/validators/{hotkey}/nominators",
    ]) {
      const probe = probes.find((candidate) => candidate.path === path);
      assert.ok(probe, `${path} is no longer dispatched by this gate`);
      assert.ok(probe.declared, `${path} stopped declaring its CSV export`);
      assert.ok(probe.csv, `${path} stopped serving CSV`);
    }
  });
});
