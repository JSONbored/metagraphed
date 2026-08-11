// The /api/v1/internal/subnet-identity-sync proxy (workers/api.ts's
// handleSubnetIdentitySyncProxy, #10710), which forwards to
// workers/data-api.ts's handleSubnetIdentitySync over the DATA_API service
// binding. Mirrors tests/account-identity-sync-proxy.test.ts; the write logic
// itself is covered end to end in tests/data-api-subnet-identity-sync.test.ts.
//
// The producer is metagraphed-infra's chain-direct `subnet-identity` poller
// lane, which reaches this path from outside and therefore crosses the proxy --
// so the relay of its token is the one thing worth pinning here. A proxy that
// dropped the header would turn every pass into a 401 the lane cannot fix.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

const PATH = "https://api.metagraph.sh/api/v1/internal/subnet-identity-sync";

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
  let receivedToken: string | null = null;
  let receivedPath: string | undefined;
  const res = await handleRequest(
    new Request(PATH, {
      method: "POST",
      headers: { "x-subnet-identity-sync-token": "shared-secret" },
    }),
    {
      DATA_API: {
        fetch(req: Request) {
          receivedToken = req.headers.get("x-subnet-identity-sync-token");
          receivedPath = new URL(req.url).pathname;
          return new Response(
            JSON.stringify({ ok: true, subnet_identity_written: 129 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    } as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(receivedToken, "shared-secret");
  assert.equal(receivedPath, "/api/v1/internal/subnet-identity-sync");
  const body = (await res.json()) as { subnet_identity_written?: number };
  assert.equal(body.subnet_identity_written, 129);
});

test("relays a downstream failure rather than masking it", async () => {
  // The lane treats a non-2xx as a failed pass and retries. A proxy that
  // flattened a 502 into a 200 would make a write that did not happen look
  // like one that did -- the exact shape of the bug this route exists to end.
  const res = await handleRequest(
    new Request(PATH, {
      method: "POST",
      headers: { "x-subnet-identity-sync-token": "shared-secret" },
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
