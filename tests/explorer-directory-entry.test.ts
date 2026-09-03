import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import api, {
  flushUsageRollup,
  markRequestErrorCode,
  usageRollupBufferSize,
} from "../workers/api.ts";
import {
  EXPLORER_DIRECTORY_ENTRIES,
  handleDefaultExplorerDirectory,
} from "../workers/explorer-directory-entry.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { buildAccountHolderDirectory } from "../src/account-holder-directory.ts";
import { buildValidatorOperatorDirectory } from "../src/validator-operator-directory.ts";
import {
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "../src/kv-keys.ts";
import * as telemetry from "../src/usage-telemetry.ts";
import { mockEnv } from "./row-type.ts";

const NOW = Date.parse("2026-09-03T01:30:00Z");
const ACCOUNT_PATH = "/api/v1/accounts/directory";
const request = (path = ACCOUNT_PATH, init?: RequestInit) =>
  new Request(`https://api.metagraph.sh${path}`, init);

function fixture() {
  const stamp = {
    captured_at: new Date(NOW - 60_000).toISOString(),
    block_number: 8_983_000,
  };
  const accounts = {
    ...buildAccountHolderDirectory([], { priceByNetuid: new Map() }),
    ...stamp,
  };
  const validators = { ...buildValidatorOperatorDirectory(null), ...stamp };
  const values = new Map<string, unknown>([
    [KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT, accounts],
    [KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT, validators],
    [
      "metagraph:latest",
      { published_at: new Date(NOW - 60_000).toISOString() },
    ],
  ]);
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };
  const env = mockEnv({
    METAGRAPH_NEURONS_SOURCE: "data-api",
    METAGRAPH_AUDIT_RESPONSES: "enforce",
    METAGRAPH_CONTROL: { get },
  });
  return { values, accounts, validators, get, ctx, pending, env };
}

function cacheFixture() {
  const values = new Map<string, Response>();
  const match = vi.fn(async (key: Request) => values.get(key.url)?.clone());
  const put = vi.fn(async (key: Request, response: Response) => {
    values.set(key.url, response.clone());
  });
  vi.stubGlobal("caches", { default: { match, put } });
  return { values, match, put };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("default directory entry", () => {
  test("route descriptors stay tied to the published contract", () => {
    for (const entry of EXPLORER_DIRECTORY_ENTRIES) {
      const route = API_ROUTES.find((row) => row.path === entry.path);
      expect(route).toMatchObject({
        id: entry.id,
        artifact_path: entry.artifactTemplate,
      });
    }
  });

  test.each(EXPLORER_DIRECTORY_ENTRIES)(
    "$id returns the same envelope and headers as the complete router",
    async (entry) => {
      const f = fixture();
      const expected = await api.fetch(request(entry.path), f.env, f.ctx);
      const actual = await handleDefaultExplorerDirectory(
        request(entry.path),
        f.env,
        f.ctx,
      );
      expect(actual).not.toBeNull();
      expect(actual!.status).toBe(200);
      expect(await actual!.json()).toEqual(await expected.json());
      expect(Object.fromEntries(actual!.headers)).toEqual(
        Object.fromEntries(expected.headers),
      );
    },
  );

  test.each([
    { path: ACCOUNT_PATH, init: { method: "POST" } },
    { path: `${ACCOUNT_PATH}?network=invalid` },
    { path: "/finney/api/v1/accounts/directory" },
    { path: "/api/v1/validators" },
    ...[
      "authorization",
      "x-api-key",
      "x-payment",
      "payment-signature",
      "upgrade",
    ].map((name) => ({
      path: ACCOUNT_PATH,
      init: {
        headers: {
          [name]:
            name === "authorization"
              ? "Bearer mg_test_directory_key"
              : "mg_test_directory_key",
        },
      },
    })),
  ])(
    "delegates unsupported variants without reading or caching data: %j",
    async ({ path, init }) => {
      const f = fixture();
      const cache = cacheFixture();
      expect(
        await handleDefaultExplorerDirectory(request(path, init), f.env, f.ctx),
      ).toBeNull();
      expect(f.get).not.toHaveBeenCalled();
      expect(cache.match).not.toHaveBeenCalled();
    },
  );

  test("respects the source kill switch", async () => {
    const f = fixture();
    expect(
      await handleDefaultExplorerDirectory(request(), mockEnv(), f.ctx),
    ).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
  });

  test("shares the original cache key and advances to the next snapshot within the existing minute bound", async () => {
    const f = fixture();
    const cache = cacheFixture();
    const first = await handleDefaultExplorerDirectory(request(), f.env, f.ctx);
    expect(first!.headers.get("x-metagraph-cache")).toBe("miss");
    await Promise.all(f.pending);
    const general = await api.fetch(request(), f.env, f.ctx);
    expect(general.headers.get("x-metagraph-cache")).toBe("hit");
    expect(
      f.get.mock.calls.filter(
        ([key]) => key === KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
      ),
    ).toHaveLength(1);
    const advanced = {
      ...f.accounts,
      captured_at: new Date(NOW + 60_000).toISOString(),
      block_number: 8_983_010,
    };
    f.values.set(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT, advanced);
    vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
    const next = await handleDefaultExplorerDirectory(request(), f.env, f.ctx);
    expect(next!.headers.get("x-metagraph-cache")).toBe("miss");
    expect(await next!.json()).toMatchObject({ data: advanced });
    expect(cache.match.mock.calls[0][0].url).not.toBe(
      cache.match.mock.calls[2][0].url,
    );
  });

  test("a cold HEAD retains the GET body in cache and conditional requests still return 304", async () => {
    const f = fixture();
    cacheFixture();
    const head = await handleDefaultExplorerDirectory(
      request(ACCOUNT_PATH, { method: "HEAD" }),
      f.env,
      f.ctx,
    );
    expect(head!.status).toBe(200);
    expect(await head!.text()).toBe("");
    await Promise.all(f.pending);
    const get = await handleDefaultExplorerDirectory(request(), f.env, f.ctx);
    expect(get!.headers.get("x-metagraph-cache")).toBe("hit");
    expect(await get!.json()).toMatchObject({ data: f.accounts });
    const conditional = await handleDefaultExplorerDirectory(
      request(ACCOUNT_PATH, {
        headers: { "if-none-match": head!.headers.get("etag")! },
      }),
      f.env,
      f.ctx,
    );
    expect(conditional!.status).toBe(304);
    expect(await conditional!.text()).toBe("");
  });

  test("an absent materialization uses the existing source-backed fallback", async () => {
    const f = fixture();
    f.values.delete(KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT);
    const fetch = vi.fn(async () => Response.json(f.accounts));
    const response = await handleDefaultExplorerDirectory(
      request(),
      mockEnv({ ...f.env, DATA_API: { fetch } }),
      f.ctx,
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ data: f.accounts });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a cached response without an ETag still returns its complete body", async () => {
    const f = fixture();
    const cache = cacheFixture();
    await handleDefaultExplorerDirectory(request(), f.env, f.ctx);
    await Promise.all(f.pending);
    for (const cached of cache.values.values()) cached.headers.delete("etag");
    const response = await handleDefaultExplorerDirectory(
      request(ACCOUNT_PATH, { headers: { "if-none-match": 'W/"older"' } }),
      f.env,
      f.ctx,
    );
    expect(response!.status).toBe(200);
    expect(response!.headers.get("x-metagraph-cache")).toBe("hit");
    expect(await response!.json()).toMatchObject({ data: f.accounts });
  });

  test("invalid request error markers cannot label successful usage as a failure", async () => {
    const f = fixture();
    const record = vi
      .spyOn(telemetry, "recordUsageEvent")
      .mockResolvedValue(true);
    for (const code of [undefined, "", 500]) {
      const req = request();
      markRequestErrorCode(req, code);
      const response = await handleDefaultExplorerDirectory(
        req,
        mockEnv({ ...f.env, POSTHOG_PROJECT_TOKEN: "phc_test" }),
        f.ctx,
      );
      expect(response!.status).toBe(200);
    }
    await Promise.all(f.pending);
    expect(record).toHaveBeenCalledTimes(3);
    for (const [, event] of record.mock.calls) {
      expect(event.ok).toBe(true);
      expect(event.errorCode).toBeUndefined();
    }
  });

  test("records one usage event and shares the same cost-rollup buffer with the general router", async () => {
    const f = fixture();
    const record = vi
      .spyOn(telemetry, "recordUsageEvent")
      .mockResolvedValue(true);
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ ok: true }),
    );
    const env = mockEnv({
      ...f.env,
      POSTHOG_PROJECT_TOKEN: "phc_test",
      DATA_API: { fetch },
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-only",
    });
    const size = usageRollupBufferSize();
    await handleDefaultExplorerDirectory(request(), env, f.ctx);
    await Promise.all(f.pending);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({
      route: "account-holder-directory",
      ok: true,
      method: "GET",
    });
    await api.fetch(request("/api/v1/validators/operators"), env, f.ctx);
    await Promise.all(f.pending);
    expect(usageRollupBufferSize()).toBe(size + 2);
    flushUsageRollup(mockEnv(), f.ctx);
    flushUsageRollup(mockEnv({ DATA_API: { fetch } }), f.ctx);
    expect(usageRollupBufferSize()).toBe(size + 2);
    expect(fetch).not.toHaveBeenCalled();
    flushUsageRollup(env, f.ctx);
    await Promise.all(f.pending);
    const sent = await (fetch.mock.calls[0][0] as Request).json();
    expect(sent).toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({ family: ACCOUNT_PATH }),
        expect.objectContaining({ family: "/api/v1/validators/operators" }),
      ]),
    });
  });
});
