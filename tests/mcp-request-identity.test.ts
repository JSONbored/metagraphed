import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test, vi } from "vitest";
import {
  handleMcpRequest,
  mcpDistinctId,
  resolveMcpRequestDistinctId,
} from "../src/mcp-server.ts";
import {
  anonymousUsageDistinctId,
  POSTHOG_PROJECT_TOKEN_ENV,
} from "../src/usage-telemetry.ts";
import { ANONYMOUS_CLIENT_KEY, resolveClientIp } from "../workers/config.ts";
import { mockEnv } from "./row-type.ts";

const SALT = "identity-fixture-salt";
const IP = "203.0.113.7";
const request = (ip: string | undefined = IP) =>
  new Request("https://api.metagraph.sh/mcp", {
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });

// The previous buildContext ordering, including its always-attempted IP digest.
async function legacyIdentity(
  req: Request,
  salt: string | undefined,
  login: unknown,
  session: string | null | undefined,
  account: unknown,
) {
  const ip = resolveClientIp(req);
  const anonymousId = await anonymousUsageDistinctId(
    salt,
    ip === ANONYMOUS_CLIENT_KEY ? undefined : ip,
  );
  return mcpDistinctId(login, session, {
    accountId: account,
    ...(anonymousId ? { anonymousId } : {}),
  });
}

describe("MCP request identity resolution", () => {
  test.each([
    {
      name: "GitHub outranks account and IP",
      login: "fixture",
      account: "7",
      id: "github:fixture",
      digests: 0,
    },
    {
      name: "GitHub without account",
      login: "fixture",
      account: null,
      id: "github:fixture",
      digests: 0,
    },
    {
      name: "verified account",
      login: undefined,
      account: "7",
      id: "account:7",
      digests: 0,
    },
    {
      name: "empty GitHub falls through to account",
      login: "",
      account: "7",
      id: "account:7",
      digests: 0,
    },
    {
      name: "non-string GitHub falls through to account",
      login: { name: "fixture" },
      account: "7",
      id: "account:7",
      digests: 0,
    },
    {
      name: "existing nonempty-string policy",
      login: " ",
      account: "7",
      id: "github: ",
      digests: 0,
    },
    {
      name: "zero-valued account string",
      login: null,
      account: "0",
      id: "account:0",
      digests: 0,
    },
    {
      name: "anonymous IP outranks session",
      login: undefined,
      account: null,
      digests: 1,
    },
    {
      name: "empty identities remain anonymous",
      login: "",
      account: "",
      digests: 1,
    },
    {
      name: "non-string identities remain anonymous",
      login: 7,
      account: { id: "7" },
      digests: 1,
    },
    {
      name: "numeric account remains anonymous",
      login: false,
      account: 7,
      digests: 1,
    },
  ])("$name matches previous attribution", async (fixture) => {
    const req = request();
    const expected = await legacyIdentity(
      req,
      SALT,
      fixture.login,
      "session-a",
      fixture.account,
    );
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const actual = await resolveMcpRequestDistinctId(
        req,
        SALT,
        fixture.login,
        "session-a",
        fixture.account,
      );
      assert.equal(actual, expected);
      if (fixture.id) assert.equal(actual, fixture.id);
      else assert.match(actual!, /^ip:[a-f0-9]{16}$/);
      assert.equal(digest.mock.calls.length, fixture.digests);
    } finally {
      digest.mockRestore();
    }
  });

  test.each([
    {
      name: "missing IP",
      ip: "",
      salt: SALT,
      session: "session-a",
      expected: "mcp-session:session-a",
    },
    {
      name: "missing salt",
      ip: IP,
      salt: undefined,
      session: "session-a",
      expected: "mcp-session:session-a",
    },
    {
      name: "empty salt",
      ip: IP,
      salt: "",
      session: "session-a",
      expected: "mcp-session:session-a",
    },
    {
      name: "no identity or session",
      ip: "",
      salt: SALT,
      session: null,
      expected: undefined,
    },
    {
      name: "empty session",
      ip: "",
      salt: undefined,
      session: "",
      expected: undefined,
    },
  ])("$name keeps the previous fallback", async (fixture) => {
    const req = request(fixture.ip);
    const expected = await legacyIdentity(
      req,
      fixture.salt,
      undefined,
      fixture.session,
      null,
    );
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const actual = await resolveMcpRequestDistinctId(
        req,
        fixture.salt,
        undefined,
        fixture.session,
        null,
      );
      assert.equal(actual, expected);
      assert.equal(actual, fixture.expected);
      assert.equal(digest.mock.calls.length, 0);
    } finally {
      digest.mockRestore();
    }
  });

  test("mixed concurrent callers keep isolated identities and anonymous reconnects stay stable", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const ids = await Promise.all([
        resolveMcpRequestDistinctId(
          request(),
          SALT,
          "fixture",
          "session-a",
          null,
        ),
        resolveMcpRequestDistinctId(
          request(),
          SALT,
          undefined,
          "session-b",
          "7",
        ),
        resolveMcpRequestDistinctId(
          request(),
          SALT,
          undefined,
          "session-c",
          null,
        ),
        resolveMcpRequestDistinctId(
          request(),
          SALT,
          undefined,
          "session-d",
          null,
        ),
      ]);
      assert.equal(ids[0], "github:fixture");
      assert.equal(ids[1], "account:7");
      assert.match(ids[2]!, /^ip:[a-f0-9]{16}$/);
      assert.equal(ids[2], ids[3]);
      assert.equal(digest.mock.calls.length, 2);
    } finally {
      digest.mockRestore();
    }
  });

  test("anonymous digest failure still propagates instead of inventing a session identity", async () => {
    const error = new Error("fixture digest failure");
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(error);
    try {
      await assert.rejects(
        resolveMcpRequestDistinctId(
          request(),
          SALT,
          undefined,
          "session-a",
          null,
        ),
        (actual) => actual === error,
      );
    } finally {
      digest.mockRestore();
    }
  });

  test.each([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "fixture-missing-method" },
    [
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 4, method: "fixture-missing-method" },
    ],
  ])(
    "the request path skips the GitHub digest and preserves wire responses: %j",
    async (body) => {
      const env = mockEnv({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_fixture",
        USAGE_DISTINCT_ID_SALT: SALT,
      });
      const run = async (githubLogin: string | undefined) => {
        const ids: (string | undefined)[] = [];
        const scheduled: Promise<unknown>[] = [];
        const res = await handleMcpRequest(
          new Request("https://api.metagraph.sh/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "cf-connecting-ip": IP,
              "mcp-session-id": "session-a",
            },
            body: JSON.stringify(body),
          }),
          env,
          {
            executionCtx: {
              props: { githubLogin },
              waitUntil: (pending) => {
                scheduled.push(pending);
              },
            },
            recordUsageEvent: async (_env, _event, options) => {
              ids.push(options?.distinctId);
              return true;
            },
          },
        );
        await Promise.all(scheduled);
        return {
          ids,
          wire: {
            status: res.status,
            headers: [...res.headers],
            bytes: new Uint8Array(await res.arrayBuffer()),
          },
        };
      };
      const digest = vi.spyOn(crypto.subtle, "digest");
      try {
        const anonymous = await run(undefined);
        assert.equal(
          digest.mock.calls.length,
          1,
          "one anonymous identity per request, including batches",
        );
        assert.ok(anonymous.ids.length > 0);
        for (const id of anonymous.ids) assert.match(id!, /^ip:[a-f0-9]{16}$/);
        digest.mockClear();
        const authenticated = await run("fixture");
        assert.deepEqual(authenticated.wire, anonymous.wire);
        assert.equal(digest.mock.calls.length, 0);
        assert.equal(authenticated.ids.length, anonymous.ids.length);
        assert.ok(authenticated.ids.every((id) => id === "github:fixture"));
      } finally {
        digest.mockRestore();
      }
    },
  );
});

// Existing CI runs this bounded fixture with native Node WebCrypto. It measures
// caller attribution only, not request latency; anonymous is an unchanged-work
// control. Timing evidence never determines whether the test passes.
test("fixture measurements of MCP caller attribution", async () => {
  const fixtures = [
    { name: "github", login: "fixture", account: null, removedDigests: 1 },
    {
      name: "verified-account",
      login: undefined,
      account: "7",
      removedDigests: 1,
    },
    {
      name: "anonymous-control",
      login: undefined,
      account: null,
      removedDigests: 0,
    },
  ];
  const iterations = 100;
  const samples = 7;
  for (const fixture of fixtures) {
    const req = request();
    const legacy = () =>
      legacyIdentity(req, SALT, fixture.login, "session-a", fixture.account);
    const optimized = () =>
      resolveMcpRequestDistinctId(
        req,
        SALT,
        fixture.login,
        "session-a",
        fixture.account,
      );
    assert.equal(await optimized(), await legacy());
    for (let warmup = 0; warmup < 25; warmup++) {
      await legacy();
      await optimized();
    }
    const timings: number[][] = [[], []];
    for (let sample = 0; sample < samples; sample++) {
      for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        const run = [legacy, optimized][index];
        const start = performance.now();
        for (let iteration = 0; iteration < iterations; iteration++)
          await run();
        timings[index].push((performance.now() - start) / iterations);
      }
    }
    const medians = timings.map(
      (values) => [...values].sort((a, b) => a - b)[3],
    );
    console.log(
      "MCP_IDENTITY_FIXTURE",
      JSON.stringify({
        fixture: fixture.name,
        iterations,
        samples,
        legacyMedianMs: medians[0],
        optimizedMedianMs: medians[1],
        savedPercent: 100 * (1 - medians[1] / medians[0]),
        removedSha256Digests: fixture.removedDigests,
        node: process.version,
      }),
    );
  }
});
