// The /api/v1/internal/subnet-ownership-sync proxy (workers/api.ts's
// handleSubnetOwnershipSyncProxy, #10836), which forwards to
// workers/data-api.ts's handleSubnetOwnershipSync over the DATA_API service
// binding. Mirrors tests/subnet-identity-sync-proxy.test.ts; the write logic
// itself is covered end to end in tests/data-api-subnet-ownership-sync.test.ts.
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

const PATH = "https://api.metagraph.sh/api/v1/internal/subnet-ownership-sync";

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
      headers: { "x-subnet-ownership-sync-token": "shared-secret" },
    }),
    {
      DATA_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-subnet-ownership-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({ ok: true, subnet_ownership_written: 128 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/subnet-ownership-sync");
  const body = (await res.json()) as { subnet_ownership_written?: number };
  assert.equal(body.subnet_ownership_written, 128);
});

test("relays a downstream failure rather than masking it", async () => {
  // The lane treats a non-2xx as a failed pass and retries. Flattening a 502
  // into a 200 would make a write that did not happen look like one that did,
  // and for this table that means a card whose owners silently stop moving.
  const res = await handleRequest(
    new Request(PATH, {
      method: "POST",
      headers: { "x-subnet-ownership-sync-token": "shared-secret" },
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
