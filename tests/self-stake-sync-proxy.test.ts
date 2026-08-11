// The /api/v1/internal/self-stake-sync proxy (workers/api.ts's
// handleSelfStakeSyncProxy, #10845), which forwards to
// workers/data-api.ts's handleSelfStakeSync over the DATA_API service
// binding. The write logic and the prune-domain property it exists for are
// covered end to end in tests/data-api-self-stake-sync.test.ts.
//
// WHY THE PROXY IS NOT OPTIONAL. The producer is metagraphed-infra's poller
// container, and a container only knows the PUBLIC host -- it POSTs to
// api.metagraph.sh, never to data-api directly. So the route existing on
// data-api is necessary and not sufficient: without this branch the pass 404s
// at the edge and the lane writes nothing while looking alive, which is the
// state `subnet-identity` was in for its entire life (#10710).
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

const PATH = "https://api.metagraph.sh/api/v1/internal/self-stake-sync";

function post({ method = "POST" } = {}) {
  return new Request(PATH, { method });
}

test("rejects non-POST before reaching the binding (405)", async () => {
  let calls = 0;
  const res = await handleRequest(
    post({ method: "GET" }),
    {
      DATA_API: {
        fetch() {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 405);
  assert.equal(calls, 0);
});

test("returns 503 when DATA_API is not bound", async () => {
  const res = await handleRequest(post(), {} as unknown as Env, {});
  assert.equal(res.status, 503);
});

test("relays the sync token and the downstream status", async () => {
  // The token relay is the one thing worth pinning: a proxy that dropped the
  // header would turn every pass into a 401 the lane cannot fix from its side.
  let receivedToken: string | null = null;
  let receivedPath: string | undefined;
  const res = await handleRequest(
    new Request(PATH, {
      method: "POST",
      headers: { "x-self-stake-sync-token": "shared-secret" },
    }),
    {
      DATA_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-self-stake-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({ ok: true, self_stake_positions_written: 128 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/self-stake-sync");
  const body = (await res.json()) as { self_stake_positions_written?: number };
  assert.equal(body.self_stake_positions_written, 128);
});

test("relays a downstream failure rather than masking it", async () => {
  // The lane treats a non-2xx as a failed pass and retries. Flattening a 502
  // into a 200 would make a write that did not happen look like one that did,
  // and for this table that means a card whose owners silently stop moving.
  const res = await handleRequest(
    new Request(PATH, {
      method: "POST",
      headers: { "x-self-stake-sync-token": "shared-secret" },
    }),
    {
      DATA_API: {
        fetch() {
          return new Response(JSON.stringify({ error: "neon write failed" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 502);
});

test("does not intercept the neighbouring internal sync routes", async () => {
  // A path check that matched too loosely would SWALLOW the routes dispatched
  // after it -- validator-nominator-counts-sync, nominator-positions-sync,
  // account-balances-sync and the rest all sit below this branch in the same
  // if-chain, so a `startsWith` or a stray prefix here would silently send
  // another lane's POST to the self-stake handler and fail its token check.
  //
  // Asserted through the neighbour immediately below, which is the one a
  // loosened match would capture first. 503 (DATA_API unbound) is enough: it
  // proves the request reached ITS proxy rather than this one, since this
  // one's 503 would carry a different code.
  const res = await handleRequest(
    new Request(
      "https://api.metagraph.sh/api/v1/internal/validator-nominator-counts-sync",
      { method: "POST" },
    ),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error?: { code?: string } };
  assert.notEqual(
    body.error?.code,
    "self_stake_sync_unavailable",
    "the neighbouring route was captured by the self-stake branch",
  );
});
