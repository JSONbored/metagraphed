// #9009: the session-bound surface-credential store, unit-level.
//
// The property that matters most here is that KV never holds a readable
// credential: the whole reason the issue exists is that a secret belonging to
// a third-party subnet API was travelling through places it should not (tool
// arguments, client logs, transcripts), and a store that then wrote it to KV
// in the clear would have moved the problem rather than fixed it. So the
// first test reads the raw stored bytes and asserts the plaintext is absent.
//
// tests/call-subnet-surface-mcp.test.ts covers the tool-level wiring (the
// three new tools, the resolution order, the deprecation notice).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SURFACE_CREDENTIAL_KV_PREFIX,
  clampSurfaceCredentialTtl,
  deleteSurfaceCredential,
  isSurfaceCredentialStoreConfigured,
  listSurfaceCredentials,
  loadSurfaceCredential,
  resolveSurfaceCredentialIdentity,
  storeSurfaceCredential,
  type ConfiguredSurfaceCredentialEnv,
} from "../src/mcp-surface-credentials.ts";

// Map-backed KV double: same convention as the artifact/KV fakes elsewhere in
// this suite -- real module logic, fake infrastructure. Records the raw stored
// string so a test can inspect what actually lands in KV.
function fakeKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    store,
    get: async (key: string) => {
      const entry = store.get(key);
      return entry ? JSON.parse(entry.value) : null;
    },
    put: async (
      key: string,
      value: string,
      options?: { metadata?: unknown },
    ) => {
      store.set(key, { value, metadata: options?.metadata });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (options?: { prefix?: string }) => ({
      keys: [...store.entries()]
        .filter(([name]) => name.startsWith(options?.prefix ?? ""))
        .map(([name, entry]) => ({ name, metadata: entry.metadata })),
      list_complete: true,
    }),
  };
}

function fakeEnv(secret = "test-secret") {
  const kv = fakeKv();
  return {
    kv,
    env: {
      METAGRAPH_CONTROL: kv,
      MCP_SURFACE_CREDENTIAL_SECRET: secret,
    } as unknown as ConfiguredSurfaceCredentialEnv,
  };
}

describe("surface credential store", () => {
  test("the credential is encrypted at rest, not merely encoded", async () => {
    const { kv, env } = fakeEnv();
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "hunter2");

    const [raw] = [...kv.store.values()];
    assert.ok(raw, "a KV record must exist");
    // The plaintext must not appear anywhere in the stored bytes -- neither
    // raw nor base64-encoded (an "encryption" that was really an encoding
    // would pass a naive substring check on the raw form alone).
    assert.ok(!raw.value.includes("hunter2"));
    assert.ok(!raw.value.includes(btoa("hunter2")));
    const envelope = JSON.parse(raw.value);
    assert.equal(envelope.v, 1);
    assert.equal(typeof envelope.iv, "string");
    assert.equal(typeof envelope.data, "string");
  });

  test("a stored string credential round-trips for the same identity", async () => {
    const { env } = fakeEnv();
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "hunter2");
    assert.equal(
      await loadSurfaceCredential(env, "account:7", "sn-1-x-api"),
      "hunter2",
    );
  });

  test("a signature bundle round-trips as an object", async () => {
    const { env } = fakeEnv();
    const bundle = { "X-Hotkey": "5abc", "X-Signature": "0xdead" };
    await storeSurfaceCredential(env, "account:7", "sn-2-x-api", bundle);
    assert.deepEqual(
      await loadSurfaceCredential(env, "account:7", "sn-2-x-api"),
      bundle,
    );
  });

  // The isolation property. One caller's registration must be unreachable
  // from another caller's identity, even for the same surface -- these are
  // third-party secrets, and a prefix collision would be a credential leak.
  test("one identity cannot read another's credential", async () => {
    const { env } = fakeEnv();
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "mine");
    assert.equal(
      await loadSurfaceCredential(env, "account:8", "sn-1-x-api"),
      null,
    );
    assert.deepEqual(await listSurfaceCredentials(env, "account:8"), []);
  });

  test("a rotated secret makes stored credentials unreadable, not wrong", async () => {
    const { kv, env } = fakeEnv("old-secret");
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "hunter2");
    const rotated = {
      METAGRAPH_CONTROL: kv,
      MCP_SURFACE_CREDENTIAL_SECRET: "new-secret",
    } as unknown as ConfiguredSurfaceCredentialEnv;
    assert.equal(
      await loadSurfaceCredential(rotated, "account:7", "sn-1-x-api"),
      null,
    );
  });

  test("storing twice replaces, and reports that it did", async () => {
    const { env } = fakeEnv();
    const first = await storeSurfaceCredential(
      env,
      "account:7",
      "sn-1-x-api",
      "one",
    );
    assert.equal(first.replaced, false);
    const second = await storeSurfaceCredential(
      env,
      "account:7",
      "sn-1-x-api",
      "two",
    );
    assert.equal(second.replaced, true);
    assert.equal(
      await loadSurfaceCredential(env, "account:7", "sn-1-x-api"),
      "two",
    );
  });

  test("listing returns metadata only, never a credential value", async () => {
    const { env } = fakeEnv();
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "hunter2");
    await storeSurfaceCredential(env, "account:7", "sn-2-x-api", {
      sig: "0xdead",
    });
    const listed = await listSurfaceCredentials(env, "account:7");
    assert.equal(listed.length, 2);
    const serialized = JSON.stringify(listed);
    assert.ok(!serialized.includes("hunter2"));
    assert.ok(!serialized.includes("0xdead"));
    const byId = new Map(listed.map((entry) => [entry.surface_id, entry]));
    assert.equal(byId.get("sn-1-x-api")?.shape, "string");
    assert.equal(byId.get("sn-2-x-api")?.shape, "object");
    assert.ok(byId.get("sn-1-x-api")?.expires_at);
    assert.ok(byId.get("sn-1-x-api")?.created_at);
  });

  test("listing tolerates a record whose metadata was lost", async () => {
    const { kv, env } = fakeEnv();
    // A KV record written without metadata (an older writer, or metadata
    // dropped by KV): the surface id is still recoverable from the key, and
    // one such record must not break the whole listing.
    kv.store.set(`${SURFACE_CREDENTIAL_KV_PREFIX}account:7:sn-9-x-api`, {
      value: JSON.stringify({ v: 1, iv: "aaaa", data: "bbbb" }),
    });
    const listed = await listSurfaceCredentials(env, "account:7");
    assert.deepEqual(listed, [
      {
        surface_id: "sn-9-x-api",
        shape: "string",
        created_at: "",
        expires_at: "",
      },
    ]);
  });

  // KV's list is paginated (1000 keys per page), so a caller with many
  // registrations spans pages. Listing only the first page would silently
  // under-report what is stored, which for a credential inventory means a
  // registration the caller cannot see to revoke.
  test("listing follows KV pagination to the end", async () => {
    const { env } = fakeEnv();
    const pages = [
      {
        keys: [
          {
            name: `${SURFACE_CREDENTIAL_KV_PREFIX}account:7:sn-1-x-api`,
            metadata: {
              surface_id: "sn-1-x-api",
              shape: "string",
              created_at: "t1",
              expires_at: "t2",
            },
          },
        ],
        list_complete: false,
        cursor: "next",
      },
      {
        keys: [
          {
            name: `${SURFACE_CREDENTIAL_KV_PREFIX}account:7:sn-2-x-api`,
            metadata: {
              surface_id: "sn-2-x-api",
              shape: "object",
              created_at: "t3",
              expires_at: "t4",
            },
          },
        ],
        list_complete: true,
      },
    ];
    const cursors: (string | undefined)[] = [];
    env.METAGRAPH_CONTROL.list = async (options?: { cursor?: string }) => {
      cursors.push(options?.cursor);
      return pages.shift()!;
    };
    const listed = await listSurfaceCredentials(env, "account:7");
    assert.deepEqual(
      listed.map((entry) => entry.surface_id),
      ["sn-1-x-api", "sn-2-x-api"],
    );
    assert.deepEqual(cursors, [undefined, "next"]);
  });

  test("delete removes the record and is idempotent", async () => {
    const { env } = fakeEnv();
    await storeSurfaceCredential(env, "account:7", "sn-1-x-api", "hunter2");
    assert.equal(
      await deleteSurfaceCredential(env, "account:7", "sn-1-x-api"),
      true,
    );
    assert.equal(
      await loadSurfaceCredential(env, "account:7", "sn-1-x-api"),
      null,
    );
    assert.equal(
      await deleteSurfaceCredential(env, "account:7", "sn-1-x-api"),
      false,
    );
  });

  test("a corrupt or foreign KV record reads as absent", async () => {
    const { kv, env } = fakeEnv();
    const key = `${SURFACE_CREDENTIAL_KV_PREFIX}account:7:sn-1-x-api`;
    for (const value of [
      JSON.stringify("not-an-object"),
      JSON.stringify({ v: 2, iv: "a", data: "b" }),
      JSON.stringify({ v: 1, iv: 5, data: "b" }),
      JSON.stringify({ v: 1, iv: "a", data: 5 }),
      JSON.stringify({ v: 1, iv: "!!", data: "!!" }),
    ]) {
      kv.store.set(key, { value });
      assert.equal(
        await loadSurfaceCredential(env, "account:7", "sn-1-x-api"),
        null,
        `${value} must read as absent`,
      );
    }
  });

  test("a KV read failure degrades to absent rather than throwing", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => {
          throw new Error("kv down");
        },
      },
      MCP_SURFACE_CREDENTIAL_SECRET: "s",
    } as unknown as ConfiguredSurfaceCredentialEnv;
    assert.equal(
      await loadSurfaceCredential(env, "account:7", "sn-1-x-api"),
      null,
    );
  });

  test("an unconfigured deployment resolves nothing", async () => {
    const { kv } = fakeEnv();
    assert.equal(isSurfaceCredentialStoreConfigured(null), false);
    assert.equal(isSurfaceCredentialStoreConfigured({}), false);
    assert.equal(
      isSurfaceCredentialStoreConfigured({
        MCP_SURFACE_CREDENTIAL_SECRET: "s",
      }),
      false,
      "a secret without the KV binding is not configured",
    );
    assert.equal(
      isSurfaceCredentialStoreConfigured({ METAGRAPH_CONTROL: kv }),
      false,
      "a KV binding without the secret is not configured",
    );
    assert.equal(
      isSurfaceCredentialStoreConfigured({
        METAGRAPH_CONTROL: kv,
        MCP_SURFACE_CREDENTIAL_SECRET: "s",
      }),
      true,
    );
    assert.equal(
      await loadSurfaceCredential({}, "account:7", "sn-1-x-api"),
      null,
    );
  });
});

describe("surface credential identity", () => {
  test("the rate-limit gate's account id wins over the OAuth props", () => {
    assert.equal(
      resolveSurfaceCredentialIdentity({
        accountId: "7",
        executionCtx: { props: { accountId: 9 } },
      }),
      "account:7",
    );
  });

  test("the OAuth props are the fallback", () => {
    assert.equal(
      resolveSurfaceCredentialIdentity({
        executionCtx: { props: { accountId: 9 } },
      }),
      "account:9",
    );
  });

  test("an anonymous caller has no identity", () => {
    assert.equal(resolveSurfaceCredentialIdentity({}), null);
    assert.equal(resolveSurfaceCredentialIdentity({ accountId: null }), null);
    assert.equal(
      resolveSurfaceCredentialIdentity({ executionCtx: { props: {} } }),
      null,
    );
  });

  // An account id becomes a KV-key segment. If one could contain the ":"
  // delimiter, "7:sn-1-x-api" would let identity 7 read a key belonging to a
  // differently-shaped identity -- so a delimiter-bearing id is refused
  // outright rather than escaped.
  test("an id that could alias another identity's key space is refused", () => {
    assert.equal(
      resolveSurfaceCredentialIdentity({ accountId: "7:sn-1-x-api" }),
      null,
    );
    assert.equal(resolveSurfaceCredentialIdentity({ accountId: "  " }), null);
  });
});

describe("surface credential TTL", () => {
  test("defaults to 30 days and clamps the extremes", () => {
    assert.equal(clampSurfaceCredentialTtl(), 2_592_000);
    assert.equal(clampSurfaceCredentialTtl(Number.NaN), 2_592_000);
    assert.equal(clampSurfaceCredentialTtl(1), 60);
    assert.equal(clampSurfaceCredentialTtl(99_999_999), 7_776_000);
    assert.equal(clampSurfaceCredentialTtl(3600), 3600);
    assert.equal(clampSurfaceCredentialTtl(3600.4), 3600);
  });

  test("the stored expiry reflects the clamped TTL", async () => {
    const { env } = fakeEnv();
    const before = Date.now();
    const { expiresAt } = await storeSurfaceCredential(
      env,
      "account:7",
      "sn-1-x-api",
      "hunter2",
      3600,
    );
    const delta = new Date(expiresAt).getTime() - before;
    assert.ok(
      delta >= 3_600_000 && delta < 3_610_000,
      `expiry ${expiresAt} should be ~1h out, saw ${delta}ms`,
    );
  });
});
