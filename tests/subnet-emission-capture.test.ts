import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  captureSubnetEmission,
  decodeEmissionSlots,
  decodeEpochConsensus,
  decodeGammaShares,
  decodeLeaseFlag,
  decodeSubnetStage,
  defaultEmissionSlots,
  EMISSION_PARTS_ONE,
  loadSubnetEmissionSnapshot,
  subnetEmissionChanges,
  type SubnetEmissionSnapshot,
} from "../src/subnet-emission-capture.ts";
import { createPgSubnetEmissionStore } from "../src/pg-subnet-emission.ts";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

// Values read from finney's finalized storage at block 9,602,145 (spec 497),
// so the decoders are held to the runtime's real encodings rather than to
// fixtures written from the same assumptions as the code.
const REAL = {
  started: "0x01",
  registered: "0x00",
  nullConsensus: "0x01",
  yuma: "0x00",
  // Subnet 1: the runtime's default split, as the chain stores it.
  weights1:
    "0x1400000000000000000000000000000000142e142e142e142ef5e8f5e8f5e8f568f6e8f5e8f5e8f568",
  // Subnet 3: owner 18%, validators 36%, miners 36%, and 10% to SN51's gamma.
  weights3:
    "0x14000000000000000000000000000000007a14ae47e17a142ef5285c8fc2f5285cf7285c8fc2f5285c",
  gamma3: "0x0433009999999999999919",
  // Subnet 76: 3% to SN28's gamma and 5% to SN53's.
  gamma76: "0x081c0014ae47e17a14ae073500cccccccccccccc0c",
};
const prefix = (item: string) =>
  bytesToHex(storageMapPrefix("SubtensorModule", item));
const suffix = (netuid: number) =>
  (netuid & 0xff).toString(16).padStart(2, "0") +
  (netuid >> 8).toString(16).padStart(2, "0");
const key = (item: string, netuid: number) => prefix(item) + suffix(netuid);

describe("v497 storage values decode exactly", () => {
  test("lifecycle stage, epoch consensus and the lease flag", () => {
    assert.equal(decodeSubnetStage(REAL.started), "started");
    assert.equal(decodeSubnetStage(REAL.registered), "registered");
    assert.equal(decodeSubnetStage("0x02"), "pending_dissolution");
    assert.equal(decodeSubnetStage("0x03"), "dissolving");
    assert.equal(decodeEpochConsensus(REAL.nullConsensus), "null");
    assert.equal(decodeEpochConsensus(REAL.yuma), "yuma");
    assert.equal(decodeLeaseFlag("0x01"), true);
  });

  test("a split's five slots, and the default the runtime builds", () => {
    assert.deepEqual(decodeEmissionSlots(REAL.weights3), {
      burn: 0n,
      recycle: 0n,
      owner: 3320413933267719290n,
      validator: 6640827866535438581n,
      miner: 6640827866535438583n,
    });
    // The default is what the chain stores for a subnet that never set one.
    assert.deepEqual(
      decodeEmissionSlots(REAL.weights1),
      defaultEmissionSlots(),
    );
    const d = defaultEmissionSlots();
    assert.equal(
      d.burn + d.recycle + d.owner + d.validator + d.miner,
      EMISSION_PARTS_ONE,
    );
    // A vector shorter than five reads the rest as zero, as the runtime does.
    assert.deepEqual(
      decodeEmissionSlots("0x080100000000000000ff00000000000000"),
      {
        burn: 1n,
        recycle: 255n,
        owner: 0n,
        validator: 0n,
        miner: 0n,
      },
    );
  });

  test("gamma shares, and the whole split sums to u64::MAX", () => {
    assert.deepEqual(decodeGammaShares(REAL.gamma76), [
      { target: 28, parts: 553402322211286548n },
      { target: 53, parts: 922337203685477580n },
    ]);
    const slots = decodeEmissionSlots(REAL.weights3);
    const [share] = decodeGammaShares(REAL.gamma3);
    assert.deepEqual(share, { target: 51, parts: 1844674407370955161n });
    assert.equal(
      slots.burn +
        slots.recycle +
        slots.owner +
        slots.validator +
        slots.miner +
        share.parts,
      EMISSION_PARTS_ONE,
    );
  });

  test("a moved or malformed shape is refused, never misread", () => {
    assert.throws(() => decodeSubnetStage("0x04"), /enum is out of range/);
    assert.throws(() => decodeEpochConsensus("0x02"), /enum is out of range/);
    // Six slots, one past BoundedVec<u64, 5>.
    assert.throws(
      () => decodeEmissionSlots("0x18" + "00".repeat(48)),
      /longer than its bound/,
    );
    // Seventeen shares, one past the sixteen a subnet may have.
    assert.throws(
      () => decodeGammaShares("0x44" + "00".repeat(170)),
      /longer than its bound/,
    );
    assert.throws(
      () => decodeEmissionSlots(REAL.weights3 + "00"),
      /trailing bytes/,
    );
  });
});

/** A chain whose storage is a map of key -> value, answering what the
 * snapshot reads. */
function chain(
  storage: Map<string, string>,
  opts: { fullPages?: boolean } = {},
) {
  return async (method: string, params: unknown[]) => {
    if (method === "chain_getFinalizedHead") return "0xf1";
    if (method === "chain_getHeader") return { number: "0x928461" };
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
      const [itemPrefix, count] = params as [string, number];
      if (opts.fullPages)
        return Array.from(
          { length: count },
          (_, i) => itemPrefix + String(i).padStart(4, "0"),
        );
      return [...storage.keys()].filter((k) => k.startsWith(itemPrefix)).sort();
    }
    throw new Error(`unexpected ${method}`);
  };
}

function storageFixture(): Map<string, string> {
  const s = new Map<string, string>();
  for (const netuid of [0, 3, 24, 57, 76])
    s.set(key("SubnetState", netuid), REAL.started);
  s.set(key("SubnetState", 57), REAL.registered);
  // Subnet 0 stores no vector: the ValueQuery default.
  s.set(key("SubnetEmissionWeights", 3), REAL.weights3);
  s.set(key("SubnetEmissionWeights", 24), REAL.weights1);
  s.set(key("SubnetEmissionWeights", 57), REAL.weights1);
  s.set(key("SubnetEmissionWeights", 76), REAL.weights1);
  s.set(key("SubnetGammaEmission", 3), REAL.gamma3);
  s.set(key("SubnetGammaEmission", 76), REAL.gamma76);
  s.set(key("SubnetEpochConsensus", 24), REAL.nullConsensus);
  s.set(key("SubnetEpochConsensus", 76), REAL.yuma);
  s.set(key("SubnetCreatedViaLease", 57), "0x01");
  return s;
}

describe("one finalized block's emission state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("every subnet SubnetState holds, each ValueQuery's absence its default", async () => {
    const snapshot = await loadSubnetEmissionSnapshot(
      "mainnet",
      chain(storageFixture()),
    );
    assert.equal(snapshot.block, 9_602_145);
    assert.deepEqual(snapshot.unknown, []);
    assert.equal(snapshot.undecoded, 0);
    assert.deepEqual(
      snapshot.subnets.map((s) => [
        s.netuid,
        s.stage,
        s.epochConsensus,
        s.createdViaLease,
      ]),
      [
        [0, "started", "yuma", false],
        [3, "started", "yuma", false],
        [24, "started", "null", false],
        [57, "registered", "yuma", true],
        [76, "started", "yuma", false],
      ],
    );
    const [zero, three] = snapshot.subnets;
    assert.deepEqual(zero.slots, defaultEmissionSlots());
    assert.deepEqual(zero.gammaShares, []);
    assert.equal(three.slots.owner, 3320413933267719290n);
    assert.deepEqual(three.gammaShares, [
      { target: 51, parts: 1844674407370955161n },
    ]);
  });

  test("a subnet whose state does not read whole is unknown, and counted", async () => {
    const storage = storageFixture();
    storage.set(key("SubnetEmissionWeights", 3), "0x00ff");
    const snapshot = await loadSubnetEmissionSnapshot(
      "mainnet",
      chain(storage),
    );
    assert.deepEqual(snapshot.unknown, [3]);
    assert.equal(snapshot.undecoded, 1);
    assert.ok(!snapshot.subnets.some((s) => s.netuid === 3));
  });

  test("a listed subnet gone by the read is unknown, never closed as gone", async () => {
    const rpc = chain(storageFixture());
    const snapshot = await loadSubnetEmissionSnapshot(
      "mainnet",
      async (m, params) => {
        if (m === "state_getKeysPaged")
          return [
            ...((await rpc(m, params)) as string[]),
            key("SubnetState", 99),
          ];
        return rpc(m, params);
      },
    );
    assert.deepEqual(snapshot.unknown, [99]);
    assert.equal(snapshot.undecoded, 0);
  });

  test("a listing that cannot say which subnets exist refuses the snapshot", async () => {
    await assert.rejects(
      loadSubnetEmissionSnapshot(
        "mainnet",
        chain(storageFixture(), { fullPages: true }),
      ),
      /larger than its read bound/,
    );
    const rpc = chain(storageFixture());
    await assert.rejects(
      loadSubnetEmissionSnapshot("mainnet", async (m, params) =>
        m === "state_getKeysPaged"
          ? [prefix("SubnetState") + "zz00"]
          : rpc(m, params),
      ),
      /names no netuid/,
    );
  });

  test("the default reader speaks JSON-RPC to the network's endpoint", async () => {
    const rpc = chain(storageFixture());
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
    const snapshot = await loadSubnetEmissionSnapshot("testnet");
    assert.equal(snapshot.subnets.length, 5);
    assert.ok(urls.every((url) => url.includes("test.finney")));
  });
});

const split = (overrides: Record<string, unknown> = {}) => ({
  netuid: 3,
  burn_parts: "0",
  recycle_parts: "0",
  owner_parts: "3320413933267719290",
  validator_parts: "6640827866535438581",
  miner_parts: "6640827866535438583",
  gamma_shares: [{ target: 51, parts: "1844674407370955161" }],
  ...overrides,
});
const lifecycle = (overrides: Record<string, unknown> = {}) => ({
  netuid: 3,
  stage: "started",
  epoch_consensus: "yuma",
  created_via_lease: false,
  ...overrides,
});

describe("what one snapshot changes", () => {
  let snapshot: SubnetEmissionSnapshot;
  beforeEach(async () => {
    const storage = new Map<string, string>([
      [key("SubnetState", 3), REAL.started],
      [key("SubnetEmissionWeights", 3), REAL.weights3],
      [key("SubnetGammaEmission", 3), REAL.gamma3],
    ]);
    snapshot = await loadSubnetEmissionSnapshot("mainnet", chain(storage));
  });

  test("a first capture opens every row and closes none", () => {
    const changes = subnetEmissionChanges(snapshot, {
      splits: [],
      lifecycle: [],
    });
    assert.deepEqual(changes.closeSplits, []);
    assert.deepEqual(changes.closeLifecycle, []);
    assert.deepEqual(changes.openSplits, [split()]);
    assert.deepEqual(changes.openLifecycle, [lifecycle()]);
  });

  test("an unchanged subnet changes nothing", () => {
    const changes = subnetEmissionChanges(snapshot, {
      splits: [split()],
      lifecycle: [lifecycle()],
    });
    assert.deepEqual(changes, {
      closeSplits: [],
      openSplits: [],
      closeLifecycle: [],
      openLifecycle: [],
    });
  });

  test("a changed split closes and reopens only the split; a changed stage only the stage", () => {
    const moved = subnetEmissionChanges(snapshot, {
      splits: [split({ owner_parts: "1" })],
      lifecycle: [lifecycle()],
    });
    assert.deepEqual(moved.closeSplits, [3]);
    assert.equal(moved.openSplits.length, 1);
    assert.deepEqual(moved.closeLifecycle, []);
    const staged = subnetEmissionChanges(snapshot, {
      splits: [split()],
      lifecycle: [lifecycle({ stage: "registered" })],
    });
    assert.deepEqual(staged.closeSplits, []);
    assert.deepEqual(staged.closeLifecycle, [3]);
    assert.equal(staged.openLifecycle.length, 1);
  });

  test("a stored share list that does not read is a change, not a match", () => {
    for (const gamma_shares of [
      null,
      [{ target: "51", parts: "1" }],
      [{ target: 51, parts: 1 }],
    ])
      assert.deepEqual(
        subnetEmissionChanges(snapshot, {
          splits: [split({ gamma_shares })],
          lifecycle: [lifecycle()],
        }).closeSplits,
        [3],
      );
  });

  test("a subnet the chain no longer holds closes; an unknown one is left alone", () => {
    const changes = subnetEmissionChanges(
      { ...snapshot, unknown: [9] },
      {
        splits: [split(), split({ netuid: 8 }), split({ netuid: 9 })],
        lifecycle: [
          lifecycle(),
          lifecycle({ netuid: 8 }),
          lifecycle({ netuid: 9 }),
        ],
      },
    );
    assert.deepEqual(changes.closeSplits, [8]);
    assert.deepEqual(changes.closeLifecycle, [8]);
    assert.deepEqual(changes.openSplits, []);
  });
});

describe("the capture lands in the state tables as validity ranges", () => {
  let db: PGlite;
  const database = () => {
    const query =
      (runner: PGlite | { query: PGlite["query"] }) =>
      async <T>(text: string, values: unknown[] = []) =>
        (await runner.query(toPositionalPlaceholders(text), values))
          .rows as T[];
    return {
      read: { query: query(db) },
      transaction: <T>(
        callback: (tx: { query: ReturnType<typeof query> }) => Promise<T>,
      ) =>
        db.transaction((tx) =>
          callback({ query: query(tx as unknown as PGlite) }),
        ),
    };
  };
  const rows = async (sql: string) => (await db.query(sql)).rows;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(
      readFileSync(
        new URL(
          "../migrations/postgres/0060_subnet_emission_state.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec("SET search_path TO state");
  });

  const T = 1_795_900_000_000;
  const snapshotAt = async (block: number, storage = storageFixture()) => ({
    ...(await loadSubnetEmissionSnapshot("mainnet", chain(storage))),
    block,
  });

  test("a first capture opens a row per subnet and family, and marks its block", async () => {
    const store = createPgSubnetEmissionStore(database());
    const outcome = await store.write(await snapshotAt(100), T);
    assert.deepEqual(outcome, { written: true, opened: 10, closed: 0 });
    const current = await store.current();
    assert.deepEqual(current.observation, {
      block_number: "100",
      observed_at_ms: String(T),
    });
    assert.deepEqual(
      current.splits.map((r) => [
        r.netuid,
        r.owner_parts,
        r.valid_from,
        r.valid_to,
      ]),
      [
        [0, "3320329489486196244", "100", null],
        [3, "3320413933267719290", "100", null],
        [24, "3320329489486196244", "100", null],
        [57, "3320329489486196244", "100", null],
        [76, "3320329489486196244", "100", null],
      ],
    );
    assert.deepEqual(current.splits[1].gamma_shares, [
      { parts: "1844674407370955161", target: 51 },
    ]);
    assert.deepEqual(
      current.lifecycle.map((r) => [
        r.netuid,
        r.stage,
        r.epoch_consensus,
        r.created_via_lease,
      ]),
      [
        [0, "started", "yuma", false],
        [3, "started", "yuma", false],
        [24, "started", "null", false],
        [57, "registered", "yuma", true],
        [76, "started", "yuma", false],
      ],
    );
  });

  test("a later capture closes what changed and what is gone, and keeps the rest", async () => {
    const store = createPgSubnetEmissionStore(database());
    await store.write(await snapshotAt(100), T);
    const next = storageFixture();
    next.set(key("SubnetState", 57), REAL.started);
    next.set(key("SubnetEmissionWeights", 3), REAL.weights1);
    next.delete(key("SubnetGammaEmission", 3));
    next.delete(key("SubnetState", 76));
    const outcome = await store.write(await snapshotAt(200, next), T + 900_000);
    // Subnet 3's split and 57's stage move; 76 is gone from both families.
    assert.deepEqual(outcome, { written: true, opened: 2, closed: 4 });
    const three = await store.subnet(3);
    assert.deepEqual(
      three.splits.map((r) => [r.valid_from, r.valid_to, r.owner_parts]),
      [
        ["200", null, "3320329489486196244"],
        ["100", "200", "3320413933267719290"],
      ],
    );
    assert.deepEqual(
      (await store.subnet(76)).lifecycle.map((r) => [r.valid_from, r.valid_to]),
      [["100", "200"]],
    );
    assert.deepEqual(
      await rows(
        "SELECT count(*)::int AS n FROM subnet_lifecycle_states WHERE valid_to IS NULL",
      ),
      [{ n: 4 }],
    );
  });

  test("an unchanged capture opens and closes nothing, and moves the watermark", async () => {
    const store = createPgSubnetEmissionStore(database());
    await store.write(await snapshotAt(100), T);
    assert.deepEqual(await store.write(await snapshotAt(300), T + 1_800_000), {
      written: true,
      opened: 0,
      closed: 0,
    });
    assert.equal((await store.current()).observation?.block_number, "300");
    assert.deepEqual(
      await rows("SELECT count(*)::int AS n FROM subnet_emission_splits"),
      [{ n: 5 }],
    );
  });

  test("a capture at or before the newest observed block writes nothing", async () => {
    const store = createPgSubnetEmissionStore(database());
    await store.write(await snapshotAt(100), T);
    assert.deepEqual(await store.write(await snapshotAt(100), T + 1), {
      written: false,
      opened: 0,
      closed: 0,
    });
    assert.deepEqual(
      await rows("SELECT count(*)::int AS n FROM subnet_emission_splits"),
      [{ n: 5 }],
    );
  });

  test("an empty store, or one family without the other, has no observation", async () => {
    const store = createPgSubnetEmissionStore(database());
    assert.equal((await store.current()).observation, null);
    await db.query(
      "INSERT INTO observations (family, block_number, observed_at) VALUES ('subnet_emission_splits', 5, now())",
    );
    assert.equal((await store.subnet(3)).observation, null);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const store = createPgSubnetEmissionStore(database());
    for (const netuid of [-1, 65536, 1.5])
      await assert.rejects(
        store.subnet(netuid),
        /Invalid native subnet emission identity/,
      );
  });
});

describe("the capture never throws, and says why it did nothing", () => {
  const snapshot: SubnetEmissionSnapshot = {
    block: 1,
    subnets: [],
    unknown: [],
    undecoded: 0,
  };
  const writes = (written = true) => ({
    write: async () => ({ written, opened: 2, closed: 1 }),
  });

  test("no store, a failed read, a failed write", async () => {
    assert.equal(
      (await captureSubnetEmission(null, {})).reason,
      "no_store_binding",
    );
    assert.equal(
      (
        await captureSubnetEmission(null, {
          store: writes(),
          load: async () => {
            throw new Error("archive down");
          },
        })
      ).reason,
      "chain_read_failed: archive down",
    );
    assert.equal(
      (
        await captureSubnetEmission(null, {
          store: writes(),
          load: async () => Promise.reject("gone"),
        })
      ).reason,
      "chain_read_failed: gone",
    );
    assert.equal(
      (
        await captureSubnetEmission(null, {
          store: {
            write: async () => Promise.reject(new Error("pool exhausted")),
          },
          load: async () => snapshot,
        })
      ).reason,
      "write_failed: pool exhausted",
    );
    assert.equal(
      (
        await captureSubnetEmission(null, {
          store: { write: async () => Promise.reject("disk full") },
          load: async () => snapshot,
        })
      ).reason,
      "write_failed: disk full",
    );
  });

  test("a block already passed, undecoded values, and a clean capture", async () => {
    assert.deepEqual(
      await captureSubnetEmission(null, {
        store: writes(false),
        load: async () => snapshot,
      }),
      {
        ok: false,
        subnets: 0,
        changed: 3,
        undecoded: 0,
        reason: "not_newer",
      },
    );
    assert.equal(
      (
        await captureSubnetEmission(null, {
          store: writes(),
          load: async () => ({ ...snapshot, undecoded: 2 }),
        })
      ).reason,
      "undecoded: 2",
    );
    assert.deepEqual(
      await captureSubnetEmission(null, {
        store: writes(),
        load: async () => snapshot,
      }),
      {
        ok: true,
        subnets: 0,
        changed: 3,
        undecoded: 0,
      },
    );
  });
});
