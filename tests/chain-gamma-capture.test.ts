import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  captureChainGamma,
  chainGammaStatements,
  decodeAccount,
  decodeBool,
  decodeGammaDeposit,
  decodeServiceUrl,
  decodeTaoUsdPrice,
  decodeU128,
  decodeU64,
  loadChainGammaSnapshot,
  netuidAccountFromKey,
  type ChainGammaSnapshot,
} from "../src/chain-gamma-capture.ts";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

// Values read from finney's finalized storage on 2026-11-28 (spec 497), so the
// decoders are held to the runtime's real encodings rather than to fixtures
// written from the same assumptions as the code.
const REAL = {
  price: "0xdde4d3523e8361010000000000000000",
  pending: "0x6bf41b7803000000",
  deposit:
    "0xf8eb9b3b604f25a6faec7dc9676885c9337f33e67fc650ab4766debf702dda30" +
    "824a5b2500000000" +
    "01" +
    "00f2052a01000000" +
    "00c39dd000000000" +
    "a335920000000000",
  serviceUrl:
    "0x9468747470733a2f2f626c6f636b6d616368696e652e696f2f73657276696365732e6a736f6e",
  taoUsd: "0x21b8de6f2b00000021b8de6f2b0000000083920000000000",
  oracle: "0xaecbdd31b6677a5e42e832f6edaf3a693a3dbf193f1781832f665396c63fc536",
};
const account = (hex: string) =>
  encodeAccountId32(Uint8Array.from(Buffer.from(hex, "hex")))!;
const prefix = (item: string) =>
  bytesToHex(storageMapPrefix("SubtensorModule", item));

describe("v497 storage values decode exactly", () => {
  test("prices, balances, flags and accounts", () => {
    assert.equal(decodeU128(REAL.price), "99504970479690973");
    assert.equal(decodeU64(REAL.pending), "14899999851");
    assert.equal(decodeBool("0x01"), true);
    assert.equal(decodeBool("0x00"), false);
    assert.equal(decodeAccount(REAL.oracle), account(REAL.oracle.slice(2)));
  });

  test("a deposit: its coldkey, balance and daily cap", () => {
    assert.deepEqual(decodeGammaDeposit(REAL.deposit), {
      coldkey: account(REAL.deposit.slice(2, 66)),
      balance: "626739842",
      dailyCap: "5000000000",
    });
    // No cap is None, and the value ends there.
    const uncapped = REAL.deposit.slice(0, 2 + 80) + "00";
    assert.equal(decodeGammaDeposit(uncapped).dailyCap, null);
  });

  test("a service's URL and the oracle's price", () => {
    assert.equal(
      decodeServiceUrl(REAL.serviceUrl),
      "https://blockmachine.io/services.json",
    );
    assert.deepEqual(decodeTaoUsdPrice(REAL.taoUsd), {
      accepted: "186560460833",
      feed: "186560460833",
      fedAt: 9_601_792,
    });
  });

  test("a moved or malformed shape is refused, never misread", () => {
    assert.throws(() => decodeU64("0x6bf41b78"), /truncated/);
    assert.throws(() => decodeU64(REAL.pending + "00"), /trailing bytes/);
    assert.throws(() => decodeBool("0x02"), /bool is out of range/);
    assert.throws(
      () => decodeGammaDeposit(REAL.deposit.slice(0, 82) + "02"),
      /option tag is out of range/,
    );
    assert.throws(() => decodeServiceUrl("0x08fffe"), TypeError);
    assert.throws(() => decodeServiceUrl("0x080a0b"), /not printable/);
    assert.throws(() => decodeU64("not hex"), /not hex/);
  });
});

test("a double-map key names its subnet and account", () => {
  const hotkey = "11".repeat(32);
  const key = prefix("Services") + "1300" + "ab".repeat(16) + hotkey;
  assert.deepEqual(netuidAccountFromKey(key, prefix("Services")), {
    netuid: 19,
    account: account(hotkey),
  });
  assert.equal(netuidAccountFromKey(key + "00", prefix("Services")), null);
  assert.equal(netuidAccountFromKey(key, prefix("GammaDeposits")), null);
});

/** A chain whose storage is a map of key -> value, answering the four
 * methods the snapshot reads. */
function chain(storage: Map<string, string>, opts: { pageCap?: number } = {}) {
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === "chain_getFinalizedHead") return "0xf1";
    if (method === "chain_getHeader") return { number: "0x928300" };
    if (method === "state_queryStorageAt") {
      const keys = params[0] as string[];
      return [
        {
          changes: keys
            .filter((k) => storage.has(k))
            .map((k) => [k, storage.get(k)]),
        },
      ];
    }
    if (method === "state_getKeysPaged") {
      const [itemPrefix, count, start] = params as [string, number, string];
      const keys = [...storage.keys()]
        .filter((k) => k.startsWith(itemPrefix) && k > start)
        .sort();
      return keys.slice(0, opts.pageCap ?? count);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

const HOT = "22".repeat(32);
const HOT2 = "33".repeat(32);
function storageFixture(): Map<string, string> {
  const s = new Map<string, string>();
  s.set(prefix("GammaEnabled"), "0x01");
  s.set(prefix("TotalNetworks"), "0x0400");
  s.set(prefix("TaoUsdPrice"), REAL.taoUsd);
  s.set(prefix("TaoUsdPriceOracle"), REAL.oracle);
  for (const netuid of ["0100", "0300"])
    s.set(prefix("SubnetGammaPrice") + netuid, REAL.price);
  s.set(prefix("SubnetGammaEnabled") + "0300", "0x01");
  s.set(prefix("PendingGammaEmission") + "0300", REAL.pending);
  s.set(prefix("SubnetGammaEmissionWhitelisted") + "0300", "0x01");
  s.set(
    prefix("UnconvertedGammaEmission") + "0300" + "1c00",
    "0x0a00000000000000",
  );
  s.set(
    prefix("UnconvertedGammaEmission") + "0300" + "3500",
    "0x0500000000000000",
  );
  s.set(prefix("Services") + "0300" + "cd".repeat(16) + HOT, REAL.serviceUrl);
  s.set(prefix("GammaDeposits") + "0300" + "ef".repeat(16) + HOT, REAL.deposit);
  s.set(
    prefix("GammaDeposits") + "0300" + "01".repeat(16) + HOT2,
    REAL.deposit,
  );
  return s;
}

test("one finalized block's state, read whole and decoded", async () => {
  const { rpc } = chain(storageFixture());
  const snapshot = await loadChainGammaSnapshot("mainnet", rpc);
  assert.equal(snapshot.block, 9_601_792);
  assert.equal(snapshot.enabled, true);
  // Netuids 0 and 2 carry nothing; 1 has a price; 3 is a whole gamma subnet,
  // its unconverted total summed over its two targets.
  assert.deepEqual(
    snapshot.subnets.map((s) => [
      s.netuid,
      s.enabled,
      s.pending,
      s.unconverted,
    ]),
    [
      [1, null, null, "0"],
      [3, true, "14899999851", "15"],
    ],
  );
  assert.deepEqual(snapshot.services, [
    {
      netuid: 3,
      hotkey: account(HOT),
      url: "https://blockmachine.io/services.json",
    },
  ]);
  assert.equal(snapshot.deposits?.length, 2);
  assert.equal(snapshot.oracle?.oracle, account(REAL.oracle.slice(2)));
  assert.equal(snapshot.undecoded, 0);
});

test("a map past the bound is read as incomplete, and an undecodable value is counted", async () => {
  const storage = storageFixture();
  storage.set(prefix("GammaDeposits") + "0300" + "02".repeat(16) + HOT, "0x00");
  const { rpc } = chain(storage, { pageCap: 1000 });
  // A page that always comes back full never ends: the listing is unknown.
  const fullPages = async (method: string, params: unknown[]) =>
    method === "state_getKeysPaged" &&
    (params[0] as string) === prefix("Services")
      ? Array.from(
          { length: 1000 },
          (_, i) => prefix("Services") + String(i).padStart(4, "0"),
        )
      : rpc(method, params);
  const snapshot = await loadChainGammaSnapshot("mainnet", fullPages);
  assert.equal(snapshot.services, null);
  assert.equal(snapshot.deposits?.length, 2);
  assert.equal(snapshot.undecoded, 1);
});

describe("the capture lands in the serving tables", () => {
  let db: PGlite;
  const store = () => ({
    run: async (text: string, values: unknown[] = []) => ({
      changes:
        (await db.query(toPositionalPlaceholders(text), values)).affectedRows ??
        0,
    }),
    transaction: async (
      statements: readonly { text: string; values?: unknown[] }[],
    ) =>
      db.transaction(async (tx) => {
        const out: { changes: number }[] = [];
        for (const s of statements)
          out.push({
            changes:
              (await tx.query(toPositionalPlaceholders(s.text), s.values ?? []))
                .affectedRows ?? 0,
          });
        return out;
      }),
  });

  beforeEach(async () => {
    db = new PGlite();
    await db.exec("CREATE SCHEMA app; SET search_path TO app;");
    for (const file of ["0047_gamma.sql", "0048_tao_usd_oracle.sql"])
      await db.exec(
        readFileSync(
          new URL(`../migrations/postgres/${file}`, import.meta.url),
          "utf8",
        ),
      );
  });

  test("a second capture deletes a removed service and closes a vanished deposit", async () => {
    const { rpc } = chain(storageFixture());
    const first = await loadChainGammaSnapshot("mainnet", rpc);
    const T1 = 1_795_900_000_000;
    const one = await captureChainGamma(null, {
      db: store(),
      now: () => T1,
      load: async () => first,
    });
    assert.deepEqual(one, { ok: true, captured: 7, undecoded: 0 });
    const rows = async (sql: string) => (await db.query(sql)).rows;
    assert.deepEqual(await rows("SELECT enabled FROM chain_gamma"), [
      { enabled: true },
    ]);
    assert.deepEqual(
      await rows(
        "SELECT netuid::int, price, unconverted_emission FROM subnet_gamma ORDER BY netuid",
      ),
      [
        { netuid: 1, price: "99504970479690973", unconverted_emission: "0" },
        { netuid: 3, price: "99504970479690973", unconverted_emission: "15" },
      ],
    );
    assert.deepEqual(
      await rows("SELECT block_number::int, usd_per_tao FROM tao_usd_oracle"),
      [{ block_number: 9_601_792, usd_per_tao: 186.560460833 }],
    );

    // The next capture: the service is gone and one deposit closed.
    const second: ChainGammaSnapshot = {
      ...first,
      block: 9_601_900,
      services: [],
      deposits: first.deposits!.slice(0, 1),
    };
    const two = await captureChainGamma(null, {
      db: store(),
      now: () => T1 + 900_000,
      load: async () => second,
    });
    assert.equal(two.ok, true);
    assert.deepEqual(
      await rows("SELECT count(*)::int n FROM subnet_services"),
      [{ n: 0 }],
    );
    assert.deepEqual(
      await rows(
        "SELECT closed_at::int FROM gamma_deposits ORDER BY closed_at NULLS FIRST",
      ),
      [{ closed_at: null }, { closed_at: 9_601_900 }],
    );
    // The oracle fed no new block: still one row.
    assert.deepEqual(await rows("SELECT count(*)::int n FROM tao_usd_oracle"), [
      { n: 1 },
    ]);
  });

  test("an incomplete listing neither deletes nor closes", async () => {
    const statements = chainGammaStatements(
      {
        block: 1,
        enabled: null,
        subnets: [],
        services: null,
        deposits: null,
        oracle: null,
        undecoded: 0,
      },
      1_795_900_000_000,
    );
    assert.deepEqual(statements, []);
  });

  test("retention drops the series past thirty days", async () => {
    const old = 1_795_900_000_000 - 31 * 86_400_000;
    await db.query(
      "INSERT INTO subnet_gamma (netuid, enabled, captured_at) VALUES (1, true, $1)",
      [old],
    );
    const { rpc } = chain(storageFixture());
    await captureChainGamma(null, {
      db: store(),
      now: () => 1_795_900_000_000,
      load: (network) => loadChainGammaSnapshot(network, rpc),
    });
    assert.deepEqual(
      (
        await db.query(
          "SELECT count(*)::int n FROM subnet_gamma WHERE captured_at = $1",
          [old],
        )
      ).rows,
      [{ n: 0 }],
    );
  });
});

describe("the capture never throws, and says why it did nothing", () => {
  const snapshot: ChainGammaSnapshot = {
    block: 1,
    enabled: true,
    subnets: [],
    services: [],
    deposits: [],
    oracle: null,
    undecoded: 2,
  };
  const ok = {
    run: async () => ({ changes: 0 }),
    transaction: async (s: readonly unknown[]) => s.map(() => ({ changes: 1 })),
  };

  test("no store, a failed read, a failed write, and undecoded values", async () => {
    assert.equal(
      (await captureChainGamma(null, {})).reason,
      "no_store_binding",
    );
    assert.match(
      (
        await captureChainGamma(null, {
          db: ok,
          load: async () => {
            throw new Error("archive down");
          },
        })
      ).reason ?? "",
      /chain_read_failed: archive down/,
    );
    assert.match(
      (
        await captureChainGamma(null, {
          db: {
            ...ok,
            transaction: async () => {
              throw new Error("pool exhausted");
            },
          },
          load: async () => snapshot,
        })
      ).reason ?? "",
      /write_failed: pool exhausted/,
    );
    const partial = await captureChainGamma(null, {
      db: { ...ok, run: async () => Promise.reject(new Error("prune")) },
      load: async () => snapshot,
    });
    assert.deepEqual(partial, {
      ok: false,
      captured: 3,
      undecoded: 2,
      reason: "undecoded: 2",
    });
  });
});

describe("every edge the reads can meet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("compact lengths in every mode, and a length past the bound", () => {
    // Mode 1, two bytes: a 100-byte URL.
    const url100 = "https://" + "a".repeat(92);
    assert.equal(
      decodeServiceUrl("0x9101" + Buffer.from(url100).toString("hex")),
      url100,
    );
    // Mode 2, four bytes: a 20,000-byte URL.
    const url20k = "https://" + "b".repeat(19_992);
    assert.equal(
      decodeServiceUrl("0x82380100" + Buffer.from(url20k).toString("hex"))
        .length,
      20_000,
    );
    // Mode 3, the big-integer prefix: 2^32 bytes is refused before any read.
    assert.throws(() => decodeServiceUrl("0x070000000001"), /too long/);
  });

  test("an RPC that answers the wrong shape refuses the snapshot", async () => {
    const { rpc } = chain(storageFixture());
    const edge =
      (method: string, answer: unknown) =>
      async (m: string, params: unknown[]) =>
        m === method ? answer : rpc(m, params);
    await assert.rejects(
      loadChainGammaSnapshot("mainnet", edge("chain_getFinalizedHead", null)),
      /no finalized head/,
    );
    await assert.rejects(
      loadChainGammaSnapshot("mainnet", edge("chain_getHeader", {})),
      /finalized header has no number/,
    );
    await assert.rejects(
      loadChainGammaSnapshot("mainnet", edge("state_queryStorageAt", null)),
      /answered no changes/,
    );
    await assert.rejects(
      loadChainGammaSnapshot("mainnet", edge("state_getKeysPaged", null)),
      /answered no keys/,
    );
  });

  test("listings past the bound leave their maps unknown", async () => {
    const { rpc } = chain(storageFixture());
    const unbounded = (item: string) =>
      Array.from(
        { length: 1000 },
        (_, i) => prefix(item) + String(i).padStart(4, "0"),
      );
    const snapshot = await loadChainGammaSnapshot(
      "mainnet",
      async (m, params) => {
        const itemPrefix = params[0];
        if (
          m === "state_getKeysPaged" &&
          itemPrefix === prefix("GammaDeposits")
        )
          return unbounded("GammaDeposits");
        if (
          m === "state_getKeysPaged" &&
          itemPrefix === prefix("UnconvertedGammaEmission")
        )
          return unbounded("UnconvertedGammaEmission");
        return rpc(m, params);
      },
    );
    assert.equal(snapshot.deposits, null);
    assert.deepEqual(
      snapshot.subnets.map((s) => [s.netuid, s.unconverted]),
      [
        [1, null],
        [3, null],
      ],
    );
  });

  test("absent values, a key it cannot parse, a null change and an undecodable total", async () => {
    const storage = storageFixture();
    storage.delete(prefix("TotalNetworks"));
    storage.delete(prefix("TaoUsdPrice"));
    storage.set(prefix("UnconvertedGammaEmission") + "0300" + "1c00", "0x0a");
    const { rpc } = chain(storage);
    const snapshot = await loadChainGammaSnapshot(
      "mainnet",
      async (m, params) => {
        if (m === "state_getKeysPaged" && params[0] === prefix("Services"))
          return [
            ...((await rpc(m, params)) as string[]),
            prefix("Services") + "0300",
          ];
        if (m === "state_queryStorageAt") {
          const answer = (await rpc(m, params)) as { changes: unknown[] }[];
          // A queried key the block does not hold comes back with a null value.
          answer[0].changes.push([prefix("GammaEnabled") + "ff", null]);
          return answer;
        }
        return rpc(m, params);
      },
    );
    assert.deepEqual(snapshot.subnets, []);
    assert.equal(snapshot.oracle, null);
    assert.equal(snapshot.services?.length, 1);
    // The truncated total and the key too short to name an account.
    assert.equal(snapshot.undecoded, 2);
  });

  test("the default reader speaks JSON-RPC to the network's endpoint", async () => {
    const { rpc } = chain(storageFixture());
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: await rpc(body.method, body.params),
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const snapshot = await loadChainGammaSnapshot("testnet");
    assert.equal(snapshot.block, 9_601_792);
    assert.ok(urls.every((url) => url.includes("test.finney")));
  });

  test("a zero price is no USD figure, and a non-Error failure keeps its text", async () => {
    const [statement] = chainGammaStatements(
      {
        block: 1,
        enabled: null,
        subnets: [],
        services: null,
        deposits: null,
        oracle: { accepted: "0", feed: "0", fedAt: 5, oracle: null },
        undecoded: 0,
      },
      1_795_900_000_000,
    );
    assert.equal(statement.values[1], null);
    const ok = {
      run: async () => ({ changes: 0 }),
      transaction: async (s: readonly unknown[]) =>
        s.map(() => ({ changes: 1 })),
    };
    assert.equal(
      (
        await captureChainGamma(null, {
          db: ok,
          load: async () => Promise.reject("archive down"),
        })
      ).reason,
      "chain_read_failed: archive down",
    );
    assert.equal(
      (
        await captureChainGamma(null, {
          db: { ...ok, transaction: async () => Promise.reject("pool gone") },
          load: async () => ({
            block: 1,
            enabled: true,
            subnets: [],
            services: null,
            deposits: null,
            oracle: null,
            undecoded: 0,
          }),
        })
      ).reason,
      "write_failed: pool gone",
    );
  });
});
