import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTaoMarket } from "./market.functions";
import { DEFAULT_API_BASE } from "./config";

const PRICE_URL = `${DEFAULT_API_BASE}/api/v1/network/tao-usd?include_points=false`;
const PARAMS_URL = `${DEFAULT_API_BASE}/api/v1/network/parameters`;
const VOLUME_URL = `${DEFAULT_API_BASE}/api/v1/chain/alpha-volume?limit=1`;

const PRICE = 207.03;
const ISSUANCE = 11_215_598.62;
const VOLUME_TAO = 163_936.26;

/** An envelope in the shape every route returns, so a test failure means the
 * composition is wrong rather than that the fixture is. */
const envelope = (data: unknown) => ({
  ok: true,
  json: async () => ({ ok: true, schema_version: 1, data }),
});

/** Route each URL to its own payload; anything unstubbed rejects, so a leg the
 * code adds without a test is a failure and not a silent pass. */
function stubApi(over: Partial<Record<"price" | "params" | "volume", unknown>> = {}) {
  const bodies: Record<string, unknown> = {
    [PRICE_URL]: over.price ?? { latest: { usd_per_tao: PRICE } },
    [PARAMS_URL]: over.params ?? { total_issuance_tao: ISSUANCE },
    [VOLUME_URL]: over.volume ?? { network: { total_volume_tao: VOLUME_TAO } },
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (!(url in bodies)) throw new Error(`unexpected fetch: ${url}`);
    const body = bodies[url];
    if (body === "http_error") return { ok: false, json: async () => ({}) };
    if (body === "throws") throw new Error("network down");
    return envelope(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchTaoMarket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("composes all three figures from OUR API, never a third party", async () => {
    // The whole point of the change: no request leaves for coinpaprika.
    const fetchMock = stubApi();
    const result = await fetchTaoMarket();

    expect(result.price).toBe(PRICE);
    expect(result.market_cap).toBeCloseTo(PRICE * ISSUANCE, 2);
    expect(result.volume_24h).toBeCloseTo(PRICE * VOLUME_TAO, 2);

    const called = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(called.sort()).toEqual([PRICE_URL, VOLUME_URL, PARAMS_URL].sort());
    expect(called.some((u) => u.includes("coinpaprika"))).toBe(false);
  });

  it("states the basis of both derived figures", async () => {
    // Without these, a market cap 17% above the venues' and a volume a third
    // of theirs read as errors rather than as different denominators.
    stubApi();
    const result = await fetchTaoMarket();
    expect(result.supply_basis).toBe("total_issuance");
    expect(result.volume_basis).toBe("subnet_amm_onchain");
  });

  it("narrows both heavy reads -- the ticker needs neither the series nor 128 rows", async () => {
    const fetchMock = stubApi();
    await fetchTaoMarket();
    const called = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(called).toContain(PRICE_URL);
    expect(PRICE_URL).toContain("include_points=false");
    expect(VOLUME_URL).toContain("limit=1");
  });

  it("a null usd_per_tao yields NO price -- and no derived figure either", async () => {
    // `price_basis: insufficient_pools` is a stated outcome on that surface.
    // A market cap computed from a missing price would be a confident zero.
    stubApi({ price: { latest: { usd_per_tao: null } } });
    const result = await fetchTaoMarket();
    expect(result.price).toBeUndefined();
    expect(result.market_cap).toBeUndefined();
    expect(result.volume_24h).toBeUndefined();
  });

  it("a zero price is rejected, not passed through", async () => {
    stubApi({ price: { latest: { usd_per_tao: 0 } } });
    await expect(fetchTaoMarket()).resolves.toMatchObject({
      price: undefined,
      market_cap: undefined,
    });
  });

  it("one failed leg costs its own figure, not the others", async () => {
    // A cold parameters read must not blank the price tile beside it.
    stubApi({ params: "http_error" });
    const result = await fetchTaoMarket();
    expect(result.price).toBe(PRICE);
    expect(result.market_cap).toBeUndefined();
    expect(result.volume_24h).toBeCloseTo(PRICE * VOLUME_TAO, 2);
  });

  it("a thrown leg is caught -- the ticker never takes the page down", async () => {
    stubApi({ volume: "throws" });
    const result = await fetchTaoMarket();
    expect(result.price).toBe(PRICE);
    expect(result.volume_24h).toBeUndefined();
  });

  it("an ok:false envelope is a failed read, not a body", async () => {
    // The envelope's own `ok` is the contract; an error envelope still parses
    // as JSON and would otherwise be read as an empty success.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: false, error: { code: "unavailable" } }),
      })),
    );
    const result = await fetchTaoMarket();
    expect(result.price).toBeUndefined();
    expect(result.market_cap).toBeUndefined();
    expect(result.volume_24h).toBeUndefined();
  });

  it("every leg failing yields a payload of absences, never zeros", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const result = await fetchTaoMarket();
    expect(result).toMatchObject({
      price: undefined,
      market_cap: undefined,
      volume_24h: undefined,
    });
  });
});
