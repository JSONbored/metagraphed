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
import { API_ROUTES, CONTRACT_VERSION } from "../src/contracts.ts";
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
const OPERATOR_PATH = "/api/v1/validators/operators";
type OperatorDirectory = ReturnType<typeof buildValidatorOperatorDirectory>;
const request = (path = ACCOUNT_PATH, init?: RequestInit) =>
  new Request(`https://api.metagraph.sh${path}`, init);

function operatorDirectory(nominatorCount: number | null) {
  return buildValidatorOperatorDirectory({
    captured_at: new Date(NOW - 60_000).toISOString(),
    block_number: 8_983_000,
    validators: [
      {
        hotkey: "operator-hotkey",
        total_stake_tao: 10,
        total_emission_tao: 1,
        nominator_count: nominatorCount,
      },
    ],
  });
}

function fixture() {
  const stamp = {
    captured_at: new Date(NOW - 60_000).toISOString(),
    block_number: 8_983_000,
  };
  const accounts = {
    ...buildAccountHolderDirectory([], { priceByNetuid: new Map() }),
    ...stamp,
  };
  const validators = {
    ...buildValidatorOperatorDirectory({
      validators: [
        {
          hotkey: "recorded-validator",
          coldkey: "recorded-owner",
          coldkey_count: 1,
          subnet_count: 2,
          uid_count: 2,
          total_emission_tao: 4,
          nominator_count: 3,
          take: 0.18,
        },
      ],
    }),
    ...stamp,
  };
  const values = new Map<string, unknown>([
    [KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT, accounts],
    [KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT, validators],
    [
      "metagraph:latest",
      { published_at: new Date(NOW - 60_000).toISOString() },
    ],
  ]);
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const fetch = vi.fn(async () => Response.json(validators));
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
    DATA_API: { fetch },
  });
  return { values, accounts, validators, get, fetch, ctx, pending, env };
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

function seedOperatorCache(
  cache: ReturnType<typeof cacheFixture>,
  directory: OperatorDirectory,
) {
  const route = `validator-operator-directory${OPERATOR_PATH}`;
  const key = [
    "https://edge-cache.metagraph.sh/analytics",
    encodeURIComponent(CONTRACT_VERSION),
    encodeURIComponent(`minute:${Math.floor(NOW / 60_000)}`),
    route,
  ].join("/");
  cache.values.set(
    key,
    Response.json({
      ok: true,
      schema_version: 1,
      data: directory,
      meta: { contract_version: CONTRACT_VERSION },
    }),
  );
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
      expect(entry.cacheLabel).toBe(`${entry.id}-principal-unavailable`);
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

  test.each(
    EXPLORER_DIRECTORY_ENTRIES.flatMap((entry) =>
      [123, 0].map((capital) => ({ entry, capital })),
    ),
  )(
    "$entry.id skips legacy capital $capital and preserves its source freshness policy",
    async ({ entry, capital }) => {
      const f = fixture();
      const cache = cacheFixture();
      const account = entry.path === ACCOUNT_PATH;
      const data = account ? f.accounts : f.validators;
      const kvKey = account
        ? KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT
        : KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT;
      const legacy = account
        ? { ...f.accounts, priced_registered_stake_tao: capital }
        : {
            ...f.validators,
            operators: f.validators.operators.map((operator) => ({
              ...operator,
              total_stake_tao: capital,
              apy_estimate: capital,
              stake_dominance: capital,
            })),
          };
      const legacyKey = `https://edge-cache.metagraph.sh/analytics/${encodeURIComponent(
        CONTRACT_VERSION,
      )}/${encodeURIComponent(`minute:${Math.floor(NOW / 60_000)}`)}/${entry.id}${entry.path}`;
      cache.values.set(legacyKey, Response.json({ data: legacy }));
      const first = await handleDefaultExplorerDirectory(
        request(entry.path),
        f.env,
        f.ctx,
      );
      expect(first!.headers.get("x-metagraph-cache")).toBe("miss");
      expect(await first!.json()).toMatchObject({ data });
      await Promise.all(f.pending);
      const general = await api.fetch(request(entry.path), f.env, f.ctx);
      expect(general.headers.get("x-metagraph-cache")).toBe(
        account ? "hit" : "miss",
      );
      expect(await general.json()).toMatchObject({ data });
      expect(await cache.values.get(legacyKey)!.json()).toEqual({
        data: legacy,
      });
      if (account)
        expect(cache.match.mock.calls[0][0].url).toContain(
          `/${entry.id}-principal-unavailable${entry.path}`,
        );
      else expect(cache.match).not.toHaveBeenCalled();
      expect(cache.put).toHaveBeenCalledTimes(account ? 1 : 0);
      expect(f.get.mock.calls.filter(([key]) => key === kvKey)).toHaveLength(
        account ? 1 : 0,
      );
      expect(f.fetch).toHaveBeenCalledTimes(account ? 0 : 2);
      const advanced = {
        ...data,
        captured_at: new Date(NOW + 60_000).toISOString(),
        block_number: 8_983_010,
      };
      f.values.set(kvKey, advanced);
      if (!account)
        f.fetch.mockImplementation(async () => Response.json(advanced));
      vi.mocked(Date.now).mockReturnValue(NOW + 61_000);
      const next = await handleDefaultExplorerDirectory(
        request(entry.path),
        f.env,
        f.ctx,
      );
      expect(next!.headers.get("x-metagraph-cache")).toBe("miss");
      expect(await next!.json()).toMatchObject({ data: advanced });
      if (account)
        expect(cache.match.mock.calls[0][0].url).not.toBe(
          cache.match.mock.calls[2][0].url,
        );
      else {
        expect(cache.match).not.toHaveBeenCalled();
        expect(f.fetch).toHaveBeenCalledTimes(3);
      }
    },
  );

  test.each(EXPLORER_DIRECTORY_ENTRIES)(
    "$id HEAD and conditional GET preserve the source freshness policy",
    async (entry) => {
      const f = fixture();
      const cache = cacheFixture();
      const head = await handleDefaultExplorerDirectory(
        request(entry.path, { method: "HEAD" }),
        f.env,
        f.ctx,
      );
      expect(head!.status).toBe(200);
      expect(await head!.text()).toBe("");
      await Promise.all(f.pending);
      const get = await handleDefaultExplorerDirectory(
        request(entry.path),
        f.env,
        f.ctx,
      );
      expect(get!.headers.get("x-metagraph-cache")).toBe(
        entry.path === ACCOUNT_PATH ? "hit" : "miss",
      );
      expect(await get!.json()).toMatchObject({
        data: entry.path === ACCOUNT_PATH ? f.accounts : f.validators,
      });
      const conditional = await handleDefaultExplorerDirectory(
        request(entry.path, {
          headers: { "if-none-match": head!.headers.get("etag")! },
        }),
        f.env,
        f.ctx,
      );
      expect(conditional!.status).toBe(304);
      expect(await conditional!.text()).toBe("");
      expect(f.fetch).toHaveBeenCalledTimes(
        entry.path === ACCOUNT_PATH ? 0 : 3,
      );
      expect(cache.put).toHaveBeenCalledTimes(
        entry.path === ACCOUNT_PATH ? 1 : 0,
      );
      expect(cache.match).toHaveBeenCalledTimes(
        entry.path === ACCOUNT_PATH ? 3 : 0,
      );
    },
  );

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

  test.each(["default", "full"] as const)(
    "%s operator entry ignores old KV and edge counts when the neuron stamp is unchanged",
    async (entry) => {
      const f = fixture();
      const cache = cacheFixture();
      const stale = operatorDirectory(99);
      f.values.set(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT, stale);
      seedOperatorCache(cache, stale);
      let current = operatorDirectory(7);
      const fetch = vi.fn(async () => Response.json(current));
      const env = mockEnv({ ...f.env, DATA_API: { fetch } });
      const read =
        entry === "default" ? handleDefaultExplorerDirectory : api.fetch;
      let previousEtag: string | null = null;
      for (const count of [7, null, 0, 12]) {
        current = operatorDirectory(count);
        let init: RequestInit | undefined;
        if (previousEtag) {
          init = { headers: { "if-none-match": previousEtag } };
        }
        const response: Response | null = await read(
          request(OPERATOR_PATH, init),
          env,
          f.ctx,
        );
        expect(response!.status).toBe(200);
        const body = (await response!.json()) as { data: OperatorDirectory };
        expect(body.data).toEqual(current);
        expect(body.data.operators[0].nominator_count).toBe(count);
        expect(response!.headers.get("x-metagraph-cache")).toBe("miss");
        expect(response!.headers.get("cache-control")).toBe("no-store");
        previousEtag = response!.headers.get("etag");
      }
      await Promise.all(f.pending);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(cache.match).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      const operatorReads = f.get.mock.calls.filter(
        ([key]) => key === KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
      );
      expect(operatorReads).toHaveLength(0);
      expect(Date.now()).toBe(NOW);
    },
  );

  test.each(["default", "full"] as const)(
    "%s operator entry cannot borrow an old positive or zero count when its source fails",
    async (entry) => {
      for (const count of [0, 99]) {
        const f = fixture();
        const cache = cacheFixture();
        const stale = operatorDirectory(count);
        f.values.set(KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT, stale);
        seedOperatorCache(cache, stale);
        const fetch = vi.fn(async () => new Response(null, { status: 503 }));
        const env = mockEnv({ ...f.env, DATA_API: { fetch } });
        const read =
          entry === "default" ? handleDefaultExplorerDirectory : api.fetch;
        const response = await read(request(OPERATOR_PATH), env, f.ctx);
        expect(response!.status).toBe(200);
        expect(await response!.json()).toMatchObject({
          data: buildValidatorOperatorDirectory(null),
        });
        expect(response!.headers.get("x-metagraph-degraded")).toBe(
          "tier_unavailable",
        );
        expect(response!.headers.get("cache-control")).toBe("no-store");
        await Promise.all(f.pending);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(cache.match).not.toHaveBeenCalled();
        expect(cache.put).not.toHaveBeenCalled();
        const operatorReads = f.get.mock.calls.filter(
          ([key]) => key === KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
        );
        expect(operatorReads).toHaveLength(0);
      }
    },
  );

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
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      return Response.json(
        path === OPERATOR_PATH ? f.validators : { ok: true },
      );
    });
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
    expect(fetch).toHaveBeenCalledTimes(1);
    flushUsageRollup(env, f.ctx);
    await Promise.all(f.pending);
    expect(fetch).toHaveBeenCalledTimes(2);
    const sent = await fetch.mock.calls[1][0].json();
    expect(sent).toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({ family: ACCOUNT_PATH }),
        expect.objectContaining({ family: "/api/v1/validators/operators" }),
      ]),
    });
  });
});
