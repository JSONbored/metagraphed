// #10512: the wallet feed's items.
//
// THE BURN-CLAIM ITEM IS TESTED HARDER THAN ANYTHING ELSE IN EITHER EPIC.
// It says a team's published claim and the chain disagree, about an address a
// reader can look up, and it will be quoted without its caveats. So the tests
// assert the STRUCTURE of the sentence -- claim, observation, delta -- and the
// ABSENCE of every word that would turn a discrepancy into an allegation.
//
// The second thing under test is that the other three kinds exist at all. A
// feed that only ever fires on the worst finding trains its readers to treat
// any item as an accusation, so ordinary events have to reach it too.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  WALLET_FLOW_MATERIAL_USD,
  walletFeedItems,
  type WalletAttributionRecord,
  type WalletFeedInput,
} from "../src/wallet-feed.ts";
import type { WalletFlowRow } from "../src/wallet-activity.ts";
import { handleFeedRequest } from "../src/feeds.ts";
import { mockEnv } from "./row-type.ts";
import {
  WALLET_FEED_MAX_ADDRESSES,
  resolveWalletFeedItems,
} from "../workers/api.ts";

const NOW = Date.parse("2026-08-10T00:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const BURN = "5EvYE2R9HhPpCk9M2hGgAy9HJ3seergi2cc14hqVkh3aeUy1";
const TREASURY = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";

function wallet(
  over: Partial<WalletAttributionRecord> = {},
): WalletAttributionRecord {
  return {
    ss58: TREASURY,
    category: "treasury",
    netuid: 64,
    name: "Example Team",
    source_urls: ["https://example.org/treasury"],
    ...over,
  };
}

function flow(over: Partial<WalletFlowRow> = {}): WalletFlowRow {
  return {
    address: TREASURY,
    denomination: "tao",
    netuid: null,
    direction: "out",
    amount: 100,
    observed_at: day(1),
    ...over,
  };
}

function items(input: Partial<WalletFeedInput> = {}) {
  return walletFeedItems({
    wallets: [],
    now: NOW,
    prices: { usd_per_tao: 200 },
    ...input,
  });
}

const rows = (...list: WalletFlowRow[]) => {
  const map = new Map<string, WalletFlowRow[]>();
  for (const row of list) {
    map.set(row.address, [...(map.get(row.address) ?? []), row]);
  }
  return map;
};

describe("the burn-claim discrepancy item", () => {
  const declaredBurn = wallet({
    ss58: BURN,
    category: "burn",
    source_urls: ["https://example.org/burn-policy"],
  });
  const discrepancy = () =>
    items({
      wallets: [declaredBurn],
      rowsByAddress: rows(
        flow({ address: BURN, direction: "out", amount: 45 }),
      ),
    }).filter((i) => i.tags.includes("burn-claim"));

  test("states the claim, the observation and the delta, in that order", () => {
    const [item] = discrepancy();
    assert.ok(item);
    const claim = item.summary.indexOf("THE CLAIM:");
    const observation = item.summary.indexOf("THE OBSERVATION:");
    const delta = item.summary.indexOf("THE DELTA:");
    assert.ok(claim >= 0 && observation > claim && delta > observation);
    assert.match(item.summary, /45 TAO moved OUT/);
    assert.match(item.summary, new RegExp(BURN));
  });

  test("names OUR misattribution as a possible explanation", () => {
    // The framing rule from #10512, and the reason the wording is settled in
    // one place instead of improvised per event.
    const [item] = discrepancy();
    assert.match(item.summary, /our attribution may be wrong/);
    assert.match(item.summary, /not a finding of misconduct/);
  });

  test("never asserts intent", () => {
    const [item] = discrepancy();
    assert.doesNotMatch(
      item.summary,
      /fraud|deceiv|lied|misled|stole|scam|dishonest|deliberate|intentional/i,
      "a discrepancy is not an allegation",
    );
    assert.doesNotMatch(item.title, /fraud|scam|lied/i);
  });

  test("carries the evidence for the claim it is disputing", () => {
    // A reader deciding whether to repeat this must be able to check the
    // attribution that produced it, in the same breath.
    const [item] = discrepancy();
    assert.match(item.summary, /https:\/\/example\.org\/burn-policy/);
  });

  test("says so loudly when there is no evidence at all", () => {
    const [item] = items({
      wallets: [wallet({ ss58: BURN, category: "burn", source_urls: [] })],
      rowsByAddress: rows(flow({ address: BURN, amount: 45 })),
    }).filter((i) => i.tags.includes("burn-claim"));
    assert.match(item.summary, /No evidence URLs are recorded/);
    assert.match(item.summary, /worth checking before repeating it/);
  });

  test("an INBOUND movement to a burn address is not a discrepancy", () => {
    // Receiving is what a burn address is for. Reporting it would make the one
    // signal that matters unreadable.
    const out = items({
      wallets: [declaredBurn],
      rowsByAddress: rows(flow({ address: BURN, direction: "in", amount: 45 })),
    });
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 0);
  });

  test("a TREASURY moving funds is not a burn-claim item", () => {
    const out = items({
      wallets: [wallet()],
      rowsByAddress: rows(flow({ amount: 45 })),
    });
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 0);
  });

  test("an undated discrepancy is still reported", () => {
    // The movement happened. Dropping it because the index lost a timestamp
    // would silence the one finding this lane exists for.
    const [item] = items({
      wallets: [declaredBurn],
      rowsByAddress: rows(
        flow({ address: BURN, amount: 45, observed_at: null }),
      ),
    }).filter((i) => i.tags.includes("burn-claim"));
    assert.ok(item);
  });

  test("a dust movement is index noise, not a discrepancy", () => {
    const out = items({
      wallets: [declaredBurn],
      rowsByAddress: rows(flow({ address: BURN, amount: 1e-12 })),
    });
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 0);
  });

  test("an alpha movement names the subnet whose alpha it is", () => {
    const [item] = items({
      wallets: [declaredBurn],
      rowsByAddress: rows(
        flow({ address: BURN, denomination: "alpha", netuid: 64, amount: 45 }),
      ),
    }).filter((i) => i.tags.includes("burn-claim"));
    assert.match(item.summary, /alpha \(subnet 64\)/);
  });
});

describe("attribution and review items", () => {
  test("a new attribution is dated and carries its governance state", () => {
    const [item] = items({
      wallets: [
        wallet({
          review: { state: "community-submitted", submitted_at: day(2) },
        }),
      ],
    }).filter((i) => i.tags.includes("attribution"));
    assert.ok(item);
    assert.equal(item.timestamp, day(2));
    assert.match(item.summary, /not yet checked by a maintainer/);
    assert.match(item.summary, /may be wrong/);
    assert.match(item.summary, /https:\/\/example\.org\/treasury/);
  });

  test("a maintainer review is a SEPARATE item from the submission", () => {
    // "Somebody submitted this" and "a maintainer checked it" are different
    // claims, and a reader deciding how much to trust an attribution is
    // waiting for the second one.
    const out = items({
      wallets: [
        wallet({
          review: {
            state: "maintainer-reviewed",
            submitted_at: day(2),
            reviewed_at: day(1),
          },
        }),
      ],
    });
    const attribution = out.find((i) => i.tags.includes("attribution"));
    const review = out.find((i) => i.tags.includes("review"));
    assert.ok(attribution && review);
    assert.equal(review.timestamp, day(1));
    assert.match(review.title, /maintainer-reviewed/);
  });

  test("a review states what it does NOT verify", () => {
    const [item] = items({
      wallets: [
        wallet({
          review: { state: "maintainer-reviewed", reviewed_at: day(1) },
        }),
      ],
    }).filter((i) => i.tags.includes("review"));
    assert.match(item.summary, /does not verify what the address is used for/);
  });

  test("an attribution older than the window is not news", () => {
    const out = items({
      wallets: [
        wallet({
          review: { state: "maintainer-reviewed", submitted_at: day(200) },
        }),
      ],
    });
    assert.deepEqual(out, []);
  });

  test("an undated review block produces no item", () => {
    // No date means we cannot say when it happened, and a feed item without a
    // real timestamp would sort against everything else as though it did.
    const out = items({
      wallets: [wallet({ review: { state: "maintainer-reviewed" } })],
    });
    assert.equal(out.filter((i) => i.tags.includes("review")).length, 0);
  });

  test("a record with no category is not an attribution", () => {
    const out = items({
      wallets: [
        wallet({
          category: "",
          review: { state: "community-submitted", submitted_at: day(1) },
        }),
      ],
    });
    assert.deepEqual(out, []);
  });
});

describe("material treasury flow", () => {
  test("a large TAO movement is an item, priced for scale", () => {
    const [item] = items({
      wallets: [wallet()],
      rowsByAddress: rows(flow({ amount: 100 })),
    }).filter((i) => i.tags.includes("flow"));
    assert.ok(item);
    assert.match(item.title, /100 TAO moved out of a declared treasury/);
    assert.match(item.summary, /\$20,000/);
    assert.match(item.summary, /a conversion for scale, not a valuation/);
    assert.match(item.summary, /makes no claim about what it was for/);
  });

  test("a movement under the threshold is housekeeping", () => {
    const small = WALLET_FLOW_MATERIAL_USD / 200 / 2;
    const out = items({
      wallets: [wallet()],
      rowsByAddress: rows(flow({ amount: small })),
    });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("alpha is priced through ITS OWN subnet, or not at all", () => {
    const input = {
      wallets: [wallet()],
      rowsByAddress: rows(
        flow({ denomination: "alpha" as const, netuid: 64, amount: 2000 }),
      ),
    };
    // Unpriced: no item, rather than an item against another subnet's price.
    assert.equal(items(input).filter((i) => i.tags.includes("flow")).length, 0);
    const [item] = items({
      ...input,
      prices: {
        usd_per_tao: 200,
        alpha_price_tao: new Map([[64, 0.5]]),
      },
    }).filter((i) => i.tags.includes("flow"));
    assert.ok(item);
    assert.match(item.summary, /alpha \(subnet 64\)/);
    assert.match(item.summary, /\$200,000/);
  });

  test("alpha for a DIFFERENT subnet is not priced from this one's pool", () => {
    const out = items({
      wallets: [wallet()],
      rowsByAddress: rows(
        flow({ denomination: "alpha" as const, netuid: 51, amount: 2000 }),
      ),
      prices: { usd_per_tao: 200, alpha_price_tao: new Map([[64, 0.5]]) },
    });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("no TAO price suppresses every flow item", () => {
    const out = items({
      wallets: [wallet()],
      rowsByAddress: rows(flow({ amount: 100 })),
      prices: { usd_per_tao: null },
    });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("a burn address's movement is NOT double-reported as flow", () => {
    // The same movement under two framings would let a reader quote the
    // gentler one and drop the discrepancy's reading.
    const out = items({
      wallets: [wallet({ ss58: BURN, category: "burn" })],
      rowsByAddress: rows(flow({ address: BURN, amount: 100 })),
    });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 1);
  });

  test("inbound flow is reported too, and says so", () => {
    const [item] = items({
      wallets: [wallet()],
      rowsByAddress: rows(flow({ direction: "in", amount: 100 })),
    }).filter((i) => i.tags.includes("flow"));
    assert.match(item.title, /moved into a declared treasury/);
  });

  test("a row for another address is not attributed to this wallet", () => {
    const map = new Map<string, WalletFlowRow[]>([
      [TREASURY, [flow({ address: BURN, amount: 100 })]],
    ]);
    const out = items({ wallets: [wallet()], rowsByAddress: map });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("undated, negative and unreadable amounts produce nothing", () => {
    const out = items({
      wallets: [wallet()],
      rowsByAddress: rows(
        flow({ amount: 100, observed_at: null }),
        flow({ amount: 100, observed_at: day(400) }),
        flow({ amount: -100 }),
        flow({ amount: null }),
        flow({ denomination: "alpha" as const, netuid: null, amount: 100 }),
      ),
    });
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("a wallet with no ss58 is skipped in both passes", () => {
    const out = items({
      wallets: [
        wallet({ ss58: "" }),
        { ss58: "", category: "burn" } as WalletAttributionRecord,
      ],
      rowsByAddress: rows(flow({ amount: 100 })),
    });
    assert.deepEqual(out, []);
  });

  test("an unattributed wallet names no subnet", () => {
    const [item] = items({
      wallets: [wallet({ netuid: null })],
      rowsByAddress: rows(flow({ amount: 100 })),
    }).filter((i) => i.tags.includes("flow"));
    assert.match(item.title, /An unattributed address/);
    assert.match(item.url, /\/subnets$/);
  });

  test("a non-array wallets input is an empty feed, not a throw", () => {
    assert.deepEqual(walletFeedItems({ wallets: null, now: NOW }), []);
    assert.deepEqual(
      walletFeedItems({ wallets: undefined as never, now: NOW }),
      [],
    );
  });

  test("defaults to now and a 30-day window", () => {
    const out = walletFeedItems({
      wallets: [
        wallet({
          review: {
            state: "community-submitted",
            submitted_at: new Date().toISOString(),
          },
        }),
      ],
    });
    assert.equal(out.length, 1);
  });
});

describe("GET /api/v1/feeds/wallets", () => {
  const ITEM = {
    id: "wallet-burn-claim:x:2026-08-10T00:00:00.000Z:45",
    url: "https://metagraph.sh/subnets/64",
    title: "Subnet 64 — outbound movement from an address declared unspendable",
    summary: "…",
    timestamp: "2026-08-10T00:00:00.000Z",
    tags: ["wallets", "burn-claim"],
  };

  async function feed(path: string, loadWalletFeed?: () => Promise<unknown>) {
    const url = new URL(`https://api.metagraph.sh${path}`);
    const res = await handleFeedRequest(new Request(url), mockEnv(), url, {
      readArtifact: async () => ({ ok: false, status: 404 }) as never,
      loadWalletFeed: loadWalletFeed as never,
    });
    return { res, body: await res.text() };
  }

  test("serves the items on their own feed", async () => {
    const { res, body } = await feed("/api/v1/feeds/wallets.json", async () => [
      ITEM,
    ]);
    assert.equal(res.status, 200);
    const json = JSON.parse(body);
    assert.equal(json.items.length, 1);
    assert.match(json.description, /never asserts intent/);
  });

  test("is folded into the registry feed and narrows by tag", async () => {
    // A subscriber to the site-wide feed must not have to opt into the
    // burn-claim item.
    const { body } = await feed(
      "/api/v1/feeds/registry.json?tag=wallets",
      async () => [ITEM],
    );
    assert.equal(JSON.parse(body).items.length, 1);
  });

  test("a failing store costs the items, never the feed", async () => {
    const { res, body } = await feed(
      "/api/v1/feeds/registry.json",
      async () => {
        throw new Error("upstream unavailable");
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).items, []);
  });

  test("no injected loader is an empty feed", async () => {
    const { res, body } = await feed("/api/v1/feeds/wallets.json");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).items, []);
  });

  test("the 404 for an unknown feed names this one", async () => {
    const { res, body } = await feed("/api/v1/feeds/nope.json");
    assert.equal(res.status, 404);
    assert.match(body, /\/api\/v1\/feeds\/wallets/);
  });
});

describe("shapes the registry and the index can really produce", () => {
  test("a BIGINT-shaped timestamp string still dates an item", () => {
    const [item] = items({
      wallets: [
        wallet({
          review: {
            state: "community-submitted",
            submitted_at: String(NOW - 86_400_000),
          },
        }),
      ],
    }).filter((i) => i.tags.includes("attribution"));
    assert.equal(item.timestamp, day(1));
  });

  test("an overflowing or unparseable date produces no item", () => {
    const out = items({
      wallets: [
        wallet({
          review: {
            state: "community-submitted",
            submitted_at: "9".repeat(400),
          },
        }),
        wallet({
          ss58: BURN,
          review: { state: "community-submitted", submitted_at: "not a date" },
        }),
      ],
    });
    assert.deepEqual(out, []);
  });

  test("a review block with no state reads as unrecorded, not as reviewed", () => {
    const out = items({
      wallets: [
        wallet({ review: { submitted_at: day(1), reviewed_at: day(1) } }),
      ],
    });
    for (const item of out) assert.match(item.summary, /`unrecorded`/);
    assert.equal(out.length, 2);
  });

  test("a nameless wallet is attributed without inventing a name", () => {
    const [item] = items({
      wallets: [
        wallet({
          name: null,
          review: { state: "community-submitted", submitted_at: day(1) },
        }),
      ],
    }).filter((i) => i.tags.includes("attribution"));
    assert.doesNotMatch(item.title, /null|undefined/);
    assert.doesNotMatch(item.summary, /for null|for undefined/);
  });

  test("a non-string ss58 is skipped everywhere", () => {
    const out = items({
      wallets: [
        { ss58: 12345, category: "treasury" } as never,
        { ss58: 12345, category: "burn" } as never,
      ],
      rowsByAddress: rows(flow({ amount: 100 })),
    });
    assert.deepEqual(out, []);
  });

  test("a burn discrepancy older than the window is not news", () => {
    const out = items({
      wallets: [wallet({ ss58: BURN, category: "burn" })],
      rowsByAddress: rows(
        flow({ address: BURN, amount: 45, observed_at: day(200) }),
      ),
    });
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 0);
  });

  test("a burn alpha movement with no netuid still reports", () => {
    // The discrepancy floor is dust, not price, so an alpha leg reaches this
    // item without needing a netuid to price it -- and must not print `null`.
    const [item] = items({
      wallets: [wallet({ ss58: BURN, category: "burn" })],
      rowsByAddress: rows(
        flow({
          address: BURN,
          denomination: "alpha" as const,
          netuid: null,
          amount: 45,
        }),
      ),
    }).filter((i) => i.tags.includes("burn-claim"));
    assert.ok(item);
    assert.doesNotMatch(item.summary, /subnet null|subnet undefined/);
  });
});

// ── the worker resolver ─────────────────────────────────────────────────────
//
// The registry Worker has no route to the transfer tier, so it reads the entity
// registry from a served artifact and the transfers through DATA_API -- the
// same seam the subnet news items use. What is only reachable from here is that
// the two sources are joined correctly, and that the vocabularies match: the
// route says `received`/`sent` and the aggregator says in/out, and getting that
// backwards would report every inbound payment as a burn-claim discrepancy.

describe("resolveWalletFeedItems", () => {
  function env({
    entities,
    transfers = {},
    usdPerTao = 200,
    dataApi,
  }: {
    entities?: unknown;
    transfers?: Record<string, unknown[]>;
    usdPerTao?: number | null;
    /** Replaces the transfer stub, for the tests that count fetches. */
    dataApi?: { fetch(request: Request): Promise<Response> };
  }) {
    const artifacts: Record<string, unknown> = {
      "/metagraph/entities.json": entities == null ? undefined : { entities },
      "/metagraph/network/tao-usd.json":
        usdPerTao == null ? undefined : { latest: { usd_per_tao: usdPerTao } },
    };
    return mockEnv({
      ASSETS: {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          const value = artifacts[pathname];
          return value === undefined
            ? new Response("{}", { status: 404 })
            : Response.json(value as never);
        },
      },
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          const pathname = `/metagraph/${String(key).replace(/^latest\//, "")}`;
          const value = artifacts[pathname];
          return value === undefined
            ? null
            : {
                async json() {
                  return value;
                },
              };
        },
      },
      DATA_API: dataApi ?? {
        async fetch(request: Request) {
          const { pathname } = new URL(request.url);
          const ss58 = /\/accounts\/([^/]+)\/transfers/.exec(pathname)?.[1];
          const list = ss58 ? transfers[decodeURIComponent(ss58)] : undefined;
          if (!list) return new Response("{}", { status: 404 });
          return Response.json({ data: { transfers: list } });
        },
      },
    });
  }

  test("no entities artifact is no items, and no upstream calls", async () => {
    let calls = 0;
    const e = env({
      dataApi: {
        async fetch() {
          calls += 1;
          return new Response("{}", { status: 404 });
        },
      },
    });
    assert.deepEqual(await resolveWalletFeedItems(e as never), []);
    assert.equal(calls, 0, "an empty registry must not fan out");
  });

  test("an outbound transfer from a declared burn becomes a discrepancy", async () => {
    const out = await resolveWalletFeedItems(
      env({
        entities: [
          {
            ss58: BURN,
            category: "burn",
            netuid: 64,
            source_urls: ["https://example.org/burn"],
          },
        ],
        transfers: {
          [BURN]: [
            {
              direction: "sent",
              amount_tao: 45,
              observed_at: new Date().toISOString(),
            },
          ],
        },
      }) as never,
    );
    const item = out.find((i) => i.tags.includes("burn-claim"));
    assert.ok(item, "a `sent` transfer is an OUTBOUND movement");
    assert.match(item.summary, /45 TAO moved OUT/);
  });

  test("a RECEIVED transfer is not read as outbound", async () => {
    // The vocabularies differ between the route and the aggregator. Inverting
    // them would report every inbound payment to a burn address -- the normal
    // case -- as a discrepancy.
    const out = await resolveWalletFeedItems(
      env({
        entities: [{ ss58: BURN, category: "burn", source_urls: ["x"] }],
        transfers: {
          [BURN]: [
            {
              direction: "received",
              amount_tao: 45,
              observed_at: new Date().toISOString(),
            },
          ],
        },
      }) as never,
    );
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 0);
  });

  test("only burn and treasury addresses are fetched for", async () => {
    const fetched: string[] = [];
    const e = env({
      entities: [
        { ss58: BURN, category: "burn", source_urls: ["x"] },
        { ss58: TREASURY, category: "multisig", source_urls: ["x"] },
      ],
      dataApi: {
        async fetch(request: Request) {
          fetched.push(new URL(request.url).pathname);
          return new Response("{}", { status: 404 });
        },
      },
    });
    await resolveWalletFeedItems(e as never);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], new RegExp(BURN));
  });

  test("a malformed entity row is dropped before it becomes a fetch", async () => {
    const out = await resolveWalletFeedItems(
      env({
        entities: [{ ss58: 12345 }, { category: "burn" }, "nope"],
      }) as never,
    );
    assert.deepEqual(out, []);
  });

  test("a non-array entities key is not iterated", async () => {
    assert.deepEqual(
      await resolveWalletFeedItems(env({ entities: "not a list" }) as never),
      [],
    );
  });

  test("an upstream that answers with no transfers array is skipped", async () => {
    const e = env({
      entities: [{ ss58: TREASURY, category: "treasury", source_urls: ["x"] }],
      dataApi: {
        async fetch() {
          return Response.json({ data: { transfers: null } });
        },
      },
    });
    assert.deepEqual(await resolveWalletFeedItems(e as never), []);
  });

  test("no TAO price still reports the discrepancy, just not the flow", async () => {
    // The burn item does not depend on a price; the flow item does. Losing the
    // price must not lose the finding.
    const now = new Date().toISOString();
    const out = await resolveWalletFeedItems(
      env({
        usdPerTao: null,
        entities: [
          { ss58: BURN, category: "burn", source_urls: ["x"] },
          { ss58: TREASURY, category: "treasury", source_urls: ["x"] },
        ],
        transfers: {
          [BURN]: [{ direction: "sent", amount_tao: 45, observed_at: now }],
          [TREASURY]: [
            { direction: "sent", amount_tao: 5000, observed_at: now },
          ],
        },
      }) as never,
    );
    assert.equal(out.filter((i) => i.tags.includes("burn-claim")).length, 1);
    assert.equal(out.filter((i) => i.tags.includes("flow")).length, 0);
  });

  test("a transfer with an unreadable amount or date is not invented", async () => {
    const out = await resolveWalletFeedItems(
      env({
        entities: [{ ss58: BURN, category: "burn", source_urls: ["x"] }],
        transfers: {
          [BURN]: [
            { direction: "sent", amount_tao: "45", observed_at: 12345 },
            { direction: "sent" },
          ],
        },
      }) as never,
    );
    assert.deepEqual(out, []);
  });

  test("the fan-out is capped", async () => {
    const many = Array.from(
      { length: WALLET_FEED_MAX_ADDRESSES + 10 },
      (_, i) => ({
        ss58: `5Test${i}`,
        category: "treasury",
        source_urls: ["x"],
      }),
    );
    let calls = 0;
    const e = env({
      entities: many,
      dataApi: {
        async fetch() {
          calls += 1;
          return new Response("{}", { status: 404 });
        },
      },
    });
    await resolveWalletFeedItems(e as never);
    assert.equal(calls, WALLET_FEED_MAX_ADDRESSES);
  });
});
