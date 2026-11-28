import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, test, vi } from "vitest";
import {
  captureCommitments,
  commitmentChanges,
  commitmentDigest,
  commitmentKey,
  commitmentsCaptureDue,
  type CommitmentsSnapshot,
  decodeRegistration,
  decodeReveals,
  loadCommitmentsSnapshot,
} from "../src/commitments-capture.ts";
import { storageAt, storageAtBatched } from "../src/chain-storage-read.ts";
import { rpcUrlForNetwork } from "../src/chain-network.ts";
import {
  COMMITMENTS_WRITE_CHUNK,
  createPgCommitmentsStore,
} from "../src/pg-commitments.ts";
import { createPgSubnetEmissionStore } from "../src/pg-subnet-emission.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";

// Live finney values (blocks 9604369 and 9604581), keys and SCALE bytes verbatim.
const REAL = {
  raw1: {
    key: "0xca407206ec1ab726b2636c4b145ac287419a60ae8b01e6dcaebd7317e43c69bf0100889980bcf23c71cae4df2c7397e1443378b4cec0f2fca9dac1d0923d020e7aab11dd41428014ab59",
    value:
      "0x0000000000000000ccc84d0004627b27706565725f6964273a2027313244334b6f6f57" +
      "524e7735344157347a725157655a4c32627568553850373167666f395058515141485577" +
      "4541653468413334272c20276d6f64656c5f68756767696e67666163655f6964273a204e" +
      "6f6e657d",
  },
  bigRaw80: {
    key: "0xca407206ec1ab726b2636c4b145ac287419a60ae8b01e6dcaebd7317e43c69bf5000012bce70f5185c87523fd2cd084ee0a20711c7ac3856cd111ae92117a36bb2268e770913d656cf0c",
    value:
      "0x0000000000000000f07c8d000488f1047b2273223a22354476596b34555279734c5462" +
      "6552476d7856377a785443585872766e37535a58767a41476b58415a7157714445345922" +
      "2c2268223a22333363626339653639396235383561323938393663353566326636303835" +
      "65383839633561393962366364333039383130616135356532643265346564643037222c" +
      "2263223a2239613165363031333535353963613135393762323265666533313532633237" +
      "653163623133633566222c2272223a362c2269223a224a65525279303432325365632f70" +
      "69302e352d633130642d45654d5246717a786b4c5366222c2262223a2234356235396330" +
      "346334316237646266396634383566363161626365316563616333303031336436633739" +
      "303963646561343534356565396664363861653566222c226262223a393237323535392c" +
      "22636964223a31307d",
  },
  resetBonds2: {
    key: "0xca407206ec1ab726b2636c4b145ac287419a60ae8b01e6dcaebd7317e43c69bf0200003973ed650d9acefe256facf401fa32b3683c5416b911da2a0fcb43a17b955739421c8873a04f70",
    value: "0x00000000000000007f045e000487",
  },
  multi10: {
    key: "0xca407206ec1ab726b2636c4b145ac287419a60ae8b01e6dcaebd7317e43c69bf0a0003c49a966eb9eda2b8baad1cb64018c75ff1b2021da760f993914f23324451a8250b73f13d7ad112",
    value:
      "0x000000000000000092ab8a000c8176327c61303733623937622d663139342d34336466" +
      "2d386131612d3631633665633162383238397c3463336434376631646639646565326437" +
      "37373934663666633565663131633634383137653466637c7368613235363a6262383336" +
      "353833323238643830383838363463653462623562356663636535623230336239656581" +
      "3639353637336337386334623465633334396432353563627c68747470733a2f2f706172" +
      "65746f6e2d73332e73332e75732d656173742d322e616d617a6f6e6177732e636f6d2f73" +
      "74616765302f707269766174652f63616d706169676e732f61303733623937622d663139" +
      "342d343364662d386131612d363163366563316273383238392f706174636865732f3547" +
      "45763833746f6247386e7232655675556472484b656f37696f5648394457714e64563550" +
      "7234757a555748786b5a2f33373731356365632d306630302d343236332d393533352d62" +
      "66336561643061663936382e646966667c393038373838377c3131",
  },
  sha64: {
    key: "0xca407206ec1ab726b2636c4b145ac287419a60ae8b01e6dcaebd7317e43c69bf40000019a36293f38fbf041b7c61010faf66cb0114f4093e0c71f20b7de5c2c125d92e580795c82b5f46",
    value:
      "0x000000000000000037154e000483c44eab0caf1c2d6304c5a7da3dbfe3e45024e6b721" +
      "0b305e23624f801a28d6e4",
  },
  reveals1: {
    key: "0xca407206ec1ab726b2636c4b145ac2879055a2cffd4b296f38f2de8d9b333cab010003746147beb84411e8bcc7fb856102deeb6bf2e9da23cec93ccdbb295306fa76f639bc0abb513c63",
    value:
      "0x040901010168747470733a2f2f676973742e6769746875622e636f6d2f756e636f6e73" +
      "742f61376333666566643865316137373530623733393232366565383336376464319d77" +
      "600000000000",
  },
};

const COMMITMENT_OF = bytesToHex(
  storageMapPrefix("Commitments", "CommitmentOf"),
);
const REVEALED = bytesToHex(
  storageMapPrefix("Commitments", "RevealedCommitments"),
);

/** Little-endian hex of `n` in `bytes` bytes. */
const le = (n: number | bigint, bytes: number) => {
  let v = BigInt(n);
  let out = "";
  for (let i = 0; i < bytes; i += 1) {
    out += (v & 0xffn).toString(16).padStart(2, "0");
    v >>= 8n;
  }
  return out;
};
/** SCALE compact for lengths under 16,384. */
const compact = (n: number) =>
  n < 64 ? (n << 2).toString(16).padStart(2, "0") : le((n << 2) | 1, 2);
const utf8 = (s: string) => Buffer.from(s, "utf8").toString("hex");
const rawField = (s: string) =>
  (utf8(s).length / 2 + 1).toString(16).padStart(2, "0") + utf8(s);
const registration = (block: number, fields: string[], deposit = 0n) =>
  "0x" +
  le(deposit, 8) +
  le(block, 4) +
  compact(fields.length) +
  fields.join("");
const revealList = (items: [string, number][]) =>
  "0x" +
  compact(items.length) +
  items
    .map(([hex, block]) => compact(hex.length / 2) + hex + le(block, 8))
    .join("");
const hotkey = (n: number) => n.toString(16).padStart(64, "0");
const keyOf = (item: string, netuid: number, key: string) =>
  item + le(netuid, 2) + "00".repeat(8) + key;

/** A finney stand-in: paged keys honouring the start key, values by key. */
function chain(
  storage: Map<string, string>,
  opts: { gone?: Set<string>; fullPages?: boolean } = {},
) {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === "chain_getFinalizedHead") return "0xf1";
    if (method === "chain_getHeader") return { number: "0x928461" };
    if (method === "state_getKeysPaged") {
      const [prefix, count, start] = params as [string, number, string];
      if (opts.fullPages)
        return Array.from({ length: count }, (_, i) =>
          keyOf(prefix, 1, hotkey(i)),
        );
      return [...storage.keys()]
        .filter((k) => k.startsWith(prefix) && k > start)
        .sort()
        .slice(0, count);
    }
    if (method === "state_queryStorageAt") {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      const keys = params[0] as string[];
      return [
        {
          changes: keys
            .filter((k) => storage.has(k) && !opts.gone?.has(k))
            .map((k) => [k, storage.get(k)]),
        },
      ];
    }
    throw new Error(`unexpected ${method}`);
  };
  // One HTTP request per batch, its calls answered as single calls would be.
  let requests = 0;
  let requestsInFlight = 0;
  let peakRequests = 0;
  const batch = async (
    batchCalls: readonly { method: string; params: unknown[] }[],
  ) => {
    requests += 1;
    requestsInFlight += 1;
    peakRequests = Math.max(peakRequests, requestsInFlight);
    try {
      return await Promise.all(
        batchCalls.map((call) => rpc(call.method, call.params)),
      );
    } finally {
      requestsInFlight -= 1;
    }
  };
  return {
    rpc,
    batch,
    calls,
    peak: () => peak,
    requests: () => requests,
    peakRequests: () => peakRequests,
  };
}

describe("the Data fields decode as the chain holds them", () => {
  test("live values of every kind finney carries", () => {
    const raw = decodeRegistration(REAL.raw1.value);
    assert.equal(raw.deposit, "0");
    assert.equal(raw.block, 5_097_676);
    assert.equal(raw.fields.length, 1);
    assert.equal(raw.fields[0].kind, "raw");
    assert.match(raw.fields[0].text!, /^\{'peer_id': '12D3KooW/);

    const hash = decodeRegistration(REAL.sha64.value);
    assert.deepEqual(
      hash.fields.map((f) => [f.kind, f.text]),
      [["sha256", undefined]],
    );
    assert.equal(hash.fields[0].hex!.length, 66);

    const big = decodeRegistration(REAL.bigRaw80.value);
    assert.equal(big.fields[0].kind, "big_raw");
    assert.match(big.fields[0].text!, /^\{"s":"/);

    assert.deepEqual(decodeRegistration(REAL.resetBonds2.value).fields, [
      { kind: "reset_bonds" },
    ]);

    const multi = decodeRegistration(REAL.multi10.value);
    assert.deepEqual(
      multi.fields.map((f) => f.kind),
      ["raw", "raw", "raw"],
    );
    assert.match(multi.fields[0].text!, /^v2\|/);
  });

  test("a reveal's text is the payload inside its SCALE bytes", () => {
    const reveals = decodeReveals(REAL.reveals1.value);
    assert.equal(reveals.length, 1);
    assert.equal(reveals[0].block, 6_322_077);
    assert.equal(
      reveals[0].text,
      "https://gist.github.com/unconst/a7c3fefd8e1a7750b739226ee8367dd1",
    );
    // Bytes that are no SCALE vector are read as text whole, and binary
    // bytes carry none.
    const plain = decodeReveals(revealList([[utf8("hi"), 7]]));
    assert.deepEqual(plain, [{ hex: "0x" + utf8("hi"), text: "hi", block: 7 }]);
    const binary = decodeReveals(revealList([["00ff", 8]]));
    assert.deepEqual(binary, [{ hex: "0x00ff", block: 8 }]);
  });

  test("timelocks, hashes and empty fields, from the runtime's encoding", () => {
    const ciphertext = "ab".repeat(40);
    const fields = decodeRegistration(
      registration(
        9,
        [
          "86" + compact(40) + ciphertext + le(123_456, 8),
          "89" + compact(2) + "cdcd" + le(7, 8),
          "82" + "11".repeat(32),
          "84" + "22".repeat(32),
          "85" + "33".repeat(32),
          "00",
          rawField(""),
          rawField("tab\tok"),
          rawField("two\r\nlines"),
        ],
        18_446_744_073_709_551_615n,
      ),
    );
    assert.equal(fields.deposit, "18446744073709551615");
    assert.deepEqual(fields.fields, [
      { kind: "timelock", hex: "0x" + ciphertext, reveal_round: 123_456 },
      { kind: "timelock_failed", hex: "0xcdcd", reveal_round: 7 },
      { kind: "blake2_256", hex: "0x" + "11".repeat(32) },
      { kind: "keccak256", hex: "0x" + "22".repeat(32) },
      { kind: "sha3_256", hex: "0x" + "33".repeat(32) },
      { kind: "none" },
      { kind: "raw", hex: "0x" },
      { kind: "raw", hex: "0x" + utf8("tab\tok"), text: "tab\tok" },
      {
        kind: "raw",
        hex: "0x" + utf8("two\r\nlines"),
        text: "two\r\nlines",
      },
    ]);
  });

  test("bytes that are not text carry no text", () => {
    const fields = decodeRegistration(
      registration(1, ["03" + "c328", "03" + "0107", "02" + "7f"]),
    ).fields;
    assert.deepEqual(
      fields.map((f) => f.text),
      [undefined, undefined, undefined],
    );
  });

  test("a value the runtime could not have written is refused, never guessed", () => {
    // Tag 138 is past the enum, and a field list may not leave bytes over.
    assert.throws(() => decodeRegistration(registration(1, ["8a"])));
    assert.throws(() => decodeRegistration(registration(1, ["00"]) + "00"));
    assert.throws(() => decodeRegistration(registration(1, ["05" + "61"])));
    assert.throws(() => decodeReveals("0x04"));
  });
});

describe("keys and digests", () => {
  test("a key names its subnet and hotkey, or nothing", () => {
    assert.deepEqual(commitmentKey(REAL.sha64.key, COMMITMENT_OF), {
      netuid: 64,
      hotkey:
        "0x041b7c61010faf66cb0114f4093e0c71f20b7de5c2c125d92e580795c82b5f46",
    });
    assert.equal(commitmentKey(REAL.sha64.key, REVEALED), null);
    assert.equal(
      commitmentKey(REAL.sha64.key.slice(0, -2), COMMITMENT_OF),
      null,
    );
  });

  test("the digest is the chain's bytes, an absent value distinct from an empty one", async () => {
    const one = await commitmentDigest("0xAB", null);
    assert.equal(one, await commitmentDigest("0xab", null));
    assert.match(one, /^[0-9a-f]{64}$/);
    assert.notEqual(one, await commitmentDigest(null, "0xab"));
    assert.notEqual(
      await commitmentDigest(null, null),
      await commitmentDigest("", ""),
    );
  });

  test("the capture takes the hour's first burn tick", () => {
    assert.equal(commitmentsCaptureDue(Date.UTC(2026, 10, 28, 9, 1)), true);
    assert.equal(commitmentsCaptureDue(Date.UTC(2026, 10, 28, 9, 16)), false);
    assert.equal(commitmentsCaptureDue(Date.UTC(2026, 10, 28, 9, 46)), false);
    assert.equal(commitmentsCaptureDue(Number.NaN), false);
  });
});

describe("storage reads in flight", () => {
  test("at most the stated readers, and every value lands", async () => {
    const storage = new Map<string, string>();
    for (let i = 0; i < 2_400; i += 1)
      storage.set(keyOf("0xaa", 1, hotkey(i)), "0x01");
    const fake = chain(storage);
    const values = await storageAt(fake.rpc, [...storage.keys()], "0xf1", 4);
    assert.equal(values.size, 2_400);
    assert.equal(fake.peak(), 4);
    const serial = chain(storage);
    await storageAt(serial.rpc, [...storage.keys()], "0xf1");
    assert.equal(serial.peak(), 1);
    assert.equal((await storageAt(serial.rpc, [], "0xf1", 4)).size, 0);
  });

  test("a failed read starts no more calls", async () => {
    let calls = 0;
    const rpc = async () => {
      calls += 1;
      const call = calls;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (call === 1) throw new Error("boom");
      return [{ changes: [] }];
    };
    const keys = Array.from({ length: 5_000 }, (_, i) => hotkey(i));
    await assert.rejects(storageAt(rpc, keys, "0xf1", 2), /boom/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 2);
  });

  test("batched: ten calls to a request, at most the stated requests in flight", async () => {
    const storage = new Map<string, string>();
    for (let i = 0; i < 12_000; i += 1)
      storage.set(keyOf("0xaa", 1, hotkey(i)), "0x01");
    const fake = chain(storage);
    const values = await storageAtBatched(
      fake.batch,
      [...storage.keys()],
      "0xf1",
      { perRequest: 10, concurrency: 2 },
    );
    assert.equal(values.size, 12_000);
    // 24 calls of 500 keys: requests of ten, ten and four.
    assert.equal(
      fake.calls.filter((m) => m === "state_queryStorageAt").length,
      24,
    );
    assert.equal(fake.requests(), 3);
    assert.equal(fake.peakRequests(), 2);
    const none = await storageAtBatched(fake.batch, [], "0xf1", {
      perRequest: 10,
    });
    assert.equal(none.size, 0);
    assert.equal(fake.requests(), 3);
  });

  test("batched: a failed request, or an answer short of its calls, fails the read whole", async () => {
    const keys = Array.from({ length: 1_000 }, (_, i) => hotkey(i));
    await assert.rejects(
      storageAtBatched(
        async () => {
          throw new Error("batch(2): HTTP 429");
        },
        keys,
        "0xf1",
        { perRequest: 10 },
      ),
      /HTTP 429/,
    );
    await assert.rejects(
      storageAtBatched(async () => [[{ changes: [] }]], keys, "0xf1", {
        perRequest: 10,
      }),
      /answered the wrong count/,
    );
    await assert.rejects(
      storageAtBatched(async () => [], keys, "0xf1", { perRequest: 0 }),
      RangeError,
    );
  });

  test("batched: a failed request starts no more requests", async () => {
    let requests = 0;
    const batch = async (calls: readonly unknown[]) => {
      requests += 1;
      const request = requests;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (request === 1) throw new Error("boom");
      return calls.map(() => [{ changes: [] }]);
    };
    // 50,000 keys: 100 calls, ten requests of ten.
    const keys = Array.from({ length: 50_000 }, (_, i) => hotkey(i));
    await assert.rejects(
      storageAtBatched(batch, keys, "0xf1", { perRequest: 10, concurrency: 2 }),
      /boom/,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests, 2);
  });
});

describe("one finalized block's commitments", () => {
  const storage = () => {
    const s = new Map<string, string>();
    s.set(
      keyOf(COMMITMENT_OF, 1, hotkey(2)),
      registration(40, [rawField("b")]),
    );
    s.set(
      keyOf(COMMITMENT_OF, 1, hotkey(1)),
      registration(30, [rawField("a")]),
    );
    s.set(keyOf(REVEALED, 1, hotkey(1)), revealList([[utf8("x"), 31]]));
    s.set(keyOf(REVEALED, 2, hotkey(1)), revealList([[utf8("y"), 32]]));
    return s;
  };

  test("every pair, whole and in order, each with its digest", async () => {
    const s = storage();
    const fake = chain(s);
    const snapshot = await loadCommitmentsSnapshot("mainnet", fake);
    // The values went in one batched request, not one request a call.
    assert.equal(fake.requests(), 1);
    assert.equal(snapshot.block, 0x928461);
    assert.deepEqual(
      snapshot.commitments.map((c) => [
        c.netuid,
        c.hotkey,
        c.commitment?.block ?? null,
        c.reveals.map((r) => r.text),
      ]),
      [
        [1, "0x" + hotkey(1), 30, ["x"]],
        [1, "0x" + hotkey(2), 40, []],
        [2, "0x" + hotkey(1), null, ["y"]],
      ],
    );
    assert.equal(
      snapshot.commitments[0].digest,
      await commitmentDigest(
        s.get(keyOf(COMMITMENT_OF, 1, hotkey(1)))!,
        s.get(keyOf(REVEALED, 1, hotkey(1)))!,
      ),
    );
    assert.deepEqual(snapshot.unknown, []);
    assert.equal(snapshot.undecoded, 0);
  });

  test("pairs come out by hotkey whatever order their hashed keys list in", async () => {
    // On chain the Twox64 of the hotkey orders the keys, not the hotkey.
    const hashed = (twox: string, key: number) =>
      COMMITMENT_OF + le(5, 2) + twox.repeat(8) + hotkey(key);
    const s = new Map([
      [hashed("00", 3), registration(1, [rawField("c")])],
      [hashed("11", 1), registration(1, [rawField("a")])],
      [hashed("22", 2), registration(1, [rawField("b")])],
    ]);
    const snapshot = await loadCommitmentsSnapshot("mainnet", chain(s));
    assert.deepEqual(
      snapshot.commitments.map((c) => c.commitment?.fields[0].text),
      ["a", "b", "c"],
    );
  });

  test("a pair gone between listing and read, or unreadable, is unknown whole", async () => {
    const s = storage();
    s.set(keyOf(REVEALED, 1, hotkey(2)), "0x04");
    const gone = new Set([keyOf(REVEALED, 1, hotkey(1))]);
    const snapshot = await loadCommitmentsSnapshot(
      "mainnet",
      chain(s, { gone }),
    );
    assert.deepEqual(
      snapshot.commitments.map((c) => [c.netuid, c.hotkey]),
      [[2, "0x" + hotkey(1)]],
    );
    assert.deepEqual(snapshot.unknown, [
      { netuid: 1, hotkey: "0x" + hotkey(1) },
      { netuid: 1, hotkey: "0x" + hotkey(2) },
    ]);
    assert.equal(snapshot.undecoded, 1);
  });

  test("the network's own transport: single calls for the listing, one batch for the values", async () => {
    const fake = chain(storage());
    const urls = new Set<string>();
    let batches = 0;
    let failValues = false;
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      urls.add(String(url));
      const body = JSON.parse(String(init?.body)) as
        | { id: number; method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];
      const answer = async (call: {
        id: number;
        method: string;
        params: unknown[];
      }) =>
        failValues && call.method === "state_queryStorageAt"
          ? {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32000, message: "Upstream overloaded" },
            }
          : {
              jsonrpc: "2.0",
              id: call.id,
              result: await fake.rpc(call.method, call.params),
            };
      if (Array.isArray(body)) batches += 1;
      const payload = Array.isArray(body)
        ? await Promise.all(body.map(answer))
        : await answer(body);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const snapshot = await loadCommitmentsSnapshot("mainnet");
      assert.equal(snapshot.commitments.length, 3);
      assert.equal(batches, 1);
      assert.deepEqual([...urls], [rpcUrlForNetwork("mainnet")]);
      // One call of the batch failing fails the read, naming that call once.
      failValues = true;
      await assert.rejects(
        loadCommitmentsSnapshot("mainnet"),
        /^Error: state_queryStorageAt: Upstream overloaded$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a listing past its bound, or a key naming no pair, refuses the snapshot", async () => {
    await assert.rejects(
      loadCommitmentsSnapshot("mainnet", chain(new Map(), { fullPages: true })),
      /larger than their read bound/,
    );
    const s = new Map([[COMMITMENT_OF + "0100", registration(1, [])]]);
    await assert.rejects(
      loadCommitmentsSnapshot("mainnet", chain(s)),
      /names no subnet and hotkey/,
    );
  });
});

describe("what a capture changes", () => {
  const snapshot = (
    pairs: [number, number, string][],
    unknown: [number, number][] = [],
  ): CommitmentsSnapshot => ({
    block: 500,
    commitments: pairs.map(([netuid, key, digest]) => ({
      netuid,
      hotkey: "0x" + hotkey(key),
      commitment: { deposit: "0", block: 10, fields: [{ kind: "none" }] },
      reveals: [],
      digest,
    })),
    unknown: unknown.map(([netuid, key]) => ({
      netuid,
      hotkey: "0x" + hotkey(key),
    })),
    undecoded: 0,
  });

  test("only the pairs whose bytes moved, and those the chain no longer holds", () => {
    const changes = commitmentChanges(
      snapshot(
        [
          [1, 1, "aa"],
          [1, 2, "bb"],
          [1, 3, "cc"],
        ],
        [[1, 5]],
      ),
      [
        { netuid: 1, hotkey: hotkey(1), digest: "aa" },
        { netuid: 1, hotkey: hotkey(2).toUpperCase(), digest: "00" },
        { netuid: 1, hotkey: hotkey(4), digest: "dd" },
        { netuid: 1, hotkey: hotkey(5), digest: "ee" },
      ],
    );
    assert.deepEqual(changes.close, [
      { netuid: 1, hotkey: hotkey(2) },
      { netuid: 1, hotkey: hotkey(4) },
    ]);
    assert.deepEqual(
      changes.open.map((o) => [
        o.netuid,
        o.hotkey,
        o.digest,
        o.committed_block,
      ]),
      [
        [1, hotkey(2), "bb", 10],
        [1, hotkey(3), "cc", 10],
      ],
    );
  });

  test("a reveals-only pair opens with no commitment", () => {
    const only = snapshot([[2, 1, "ff"]]);
    only.commitments[0].commitment = null;
    only.commitments[0].reveals = [{ block: 3, hex: "0x00" }];
    assert.deepEqual(commitmentChanges(only, []).open, [
      {
        netuid: 2,
        hotkey: hotkey(1),
        committed_block: null,
        deposit: null,
        fields: null,
        reveals: [{ block: 3, hex: "0x00" }],
        digest: "ff",
      },
    ]);
  });
});

describe("the capture's verdict", () => {
  const empty: CommitmentsSnapshot = {
    block: 9,
    commitments: [],
    unknown: [],
    undecoded: 0,
  };
  const store = (outcome = { written: true, opened: 2, closed: 1 }) => ({
    write: async () => outcome,
  });

  test("no store, a failed read and a failed write each name their reason", async () => {
    assert.deepEqual(await captureCommitments({}), {
      ok: false,
      commitments: 0,
      changed: 0,
      undecoded: 0,
      reason: "no_store_binding",
    });
    const failedRead = await captureCommitments(
      {},
      {
        store: store(),
        load: async () => Promise.reject(new Error("rpc down")),
      },
    );
    assert.equal(failedRead.reason, "chain_read_failed: rpc down");
    // A rejection that is no Error is named by its own value.
    const thrownText = await captureCommitments(
      {},
      { store: store(), load: async () => Promise.reject("timeout") },
    );
    assert.equal(thrownText.reason, "chain_read_failed: timeout");
    const writeText = await captureCommitments(
      {},
      {
        store: { write: async () => Promise.reject("locked") },
        load: async () => empty,
      },
    );
    assert.equal(writeText.reason, "write_failed: locked");
    const failedWrite = await captureCommitments(
      {},
      {
        store: { write: async () => Promise.reject(new Error("pool")) },
        load: async () => ({ ...empty, undecoded: 2 }),
      },
    );
    assert.deepEqual(
      [failedWrite.ok, failedWrite.reason, failedWrite.undecoded],
      [false, "write_failed: pool", 2],
    );
  });

  test("a written capture is ok, and one not newer or partly undecoded is not", async () => {
    assert.deepEqual(
      await captureCommitments({}, { store: store(), load: async () => empty }),
      { ok: true, commitments: 0, changed: 3, undecoded: 0 },
    );
    const older = await captureCommitments(
      {},
      {
        store: store({ written: false, opened: 0, closed: 0 }),
        load: async () => empty,
      },
    );
    assert.deepEqual([older.ok, older.reason], [false, "not_newer"]);
    const partial = await captureCommitments(
      {},
      { store: store(), load: async () => ({ ...empty, undecoded: 1 }) },
    );
    assert.deepEqual([partial.ok, partial.reason], [false, "undecoded: 1"]);
  });
});

describe("the capture lands in state.commitments as validity ranges", () => {
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
  const migration = (name: string) =>
    readFileSync(
      new URL(`../migrations/postgres/${name}`, import.meta.url),
      "utf8",
    );

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(migration("0060_subnet_emission_state.sql"));
    await db.exec(migration("0061_subnet_commitments.sql"));
    await db.exec("SET search_path TO state");
  });

  const T = 1_795_900_000_000;
  const at = async (block: number, s: Map<string, string>) => ({
    ...(await loadCommitmentsSnapshot("mainnet", chain(s))),
    block,
  });
  const fixture = () =>
    new Map<string, string>([
      [REAL.raw1.key, REAL.raw1.value],
      [REAL.sha64.key, REAL.sha64.value],
      [REAL.reveals1.key, REAL.reveals1.value],
      [REAL.multi10.key, REAL.multi10.value],
    ]);

  test("a first capture opens a row per pair and marks its block", async () => {
    const store = createPgCommitmentsStore(database());
    assert.deepEqual(await store.write(await at(100, fixture()), T), {
      written: true,
      opened: 4,
      closed: 0,
    });
    const page = await store.subnet(1, { limit: 10, offset: 0 });
    assert.deepEqual(page.observation, {
      block_number: "100",
      observed_at_ms: String(T),
    });
    assert.equal(page.total, 2);
    // Most recently committed first; the reveals-only pair has no block.
    assert.deepEqual(
      page.rows.map((r) => [
        r.committed_block,
        r.deposit,
        r.valid_from,
        r.valid_to,
      ]),
      [
        ["5097676", "0", "100", null],
        [null, null, "100", null],
      ],
    );
    assert.equal((page.rows[0].fields as { kind: string }[])[0].kind, "raw");
    assert.equal(
      (page.rows[1].reveals as { text: string }[])[0].text,
      "https://gist.github.com/unconst/a7c3fefd8e1a7750b739226ee8367dd1",
    );
    const second = await store.subnet(1, { limit: 1, offset: 1 });
    assert.deepEqual([second.total, second.rows.length], [2, 1]);
  });

  test("an unchanged chain writes nothing but its watermark", async () => {
    const store = createPgCommitmentsStore(database());
    await store.write(await at(100, fixture()), T);
    assert.deepEqual(await store.write(await at(200, fixture()), T + 1), {
      written: true,
      opened: 0,
      closed: 0,
    });
    const page = await store.subnet(64, { limit: 10, offset: 0 });
    assert.equal(page.observation?.block_number, "200");
    assert.equal(page.rows[0].valid_from, "100");
  });

  test("a changed commitment closes and reopens; a gone one closes; an unknown one is left", async () => {
    const store = createPgCommitmentsStore(database());
    await store.write(await at(100, fixture()), T);
    const moved = fixture();
    moved.set(REAL.sha64.key, REAL.resetBonds2.value);
    moved.delete(REAL.multi10.key);
    assert.deepEqual(await store.write(await at(300, moved), T + 2), {
      written: true,
      opened: 1,
      closed: 2,
    });
    const sha = commitmentKey(REAL.sha64.key, COMMITMENT_OF)!;
    const history = await store.hotkey(64, sha.hotkey.slice(2));
    assert.deepEqual(
      history.rows.map((r) => [
        r.valid_from,
        r.valid_to,
        (r.fields as { kind: string }[])[0].kind,
      ]),
      [
        ["300", null, "reset_bonds"],
        ["100", "300", "sha256"],
      ],
    );
    const multi = commitmentKey(REAL.multi10.key, COMMITMENT_OF)!;
    assert.deepEqual(
      (await store.hotkey(10, multi.hotkey.slice(2))).rows.map(
        (r) => r.valid_to,
      ),
      ["300"],
    );
    // SN1's pairs are unknown at 400: their rows stay as they were.
    const unknown = await at(400, new Map());
    unknown.unknown = [
      commitmentKey(REAL.raw1.key, COMMITMENT_OF)!,
      commitmentKey(REAL.reveals1.key, REVEALED)!,
    ];
    assert.deepEqual(await store.write(unknown, T + 3), {
      written: true,
      opened: 0,
      closed: 1,
    });
    assert.equal((await store.subnet(1, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await store.subnet(64, { limit: 10, offset: 0 })).total, 0);
  });

  test("a block the store has passed is refused", async () => {
    const store = createPgCommitmentsStore(database());
    await store.write(await at(500, fixture()), T);
    assert.deepEqual(await store.write(await at(500, fixture()), T), {
      written: false,
      opened: 0,
      closed: 0,
    });
    assert.deepEqual(
      (await store.write(await at(450, new Map()), T)).written,
      false,
    );
  });

  test("a capture past one statement's rows writes them all, in chunks", async () => {
    const store = createPgCommitmentsStore(database());
    const many = new Map<string, string>();
    for (let i = 0; i <= COMMITMENTS_WRITE_CHUNK; i += 1)
      many.set(
        keyOf(COMMITMENT_OF, 7, hotkey(i)),
        registration(i + 1, [rawField("m")]),
      );
    const first = await store.write(await at(10, many), T);
    assert.equal(first.opened, COMMITMENTS_WRITE_CHUNK + 1);
    const changed = new Map<string, string>();
    for (const key of many.keys())
      changed.set(key, registration(9, [rawField("n")]));
    const second = await store.write(await at(20, changed), T);
    assert.deepEqual(
      [second.opened, second.closed],
      [first.opened, first.opened],
    );
    assert.equal(
      (await store.subnet(7, { limit: 256, offset: 0 })).total,
      first.opened,
    );
  });

  test("reads refuse an identity no pair can have, before any query", async () => {
    const store = createPgCommitmentsStore(database());
    for (const netuid of [-1, 65536, 1.5])
      await assert.rejects(
        store.subnet(netuid, { limit: 1, offset: 0 }),
        /Invalid native commitment identity/,
      );
    await assert.rejects(
      store.hotkey(1, "zz"),
      /Invalid native commitment identity/,
    );
    await assert.rejects(
      store.subnet(1, { limit: Number.NaN, offset: 0 }),
      /Invalid native commitments page/,
    );
    // A page wider than the route's bound is held to it.
    assert.deepEqual(
      (await store.subnet(1, { limit: 10_000, offset: -5 })).rows,
      [],
    );
    assert.equal(
      (await store.subnet(1, { limit: 1, offset: 0 })).observation,
      null,
    );
  });

  test("a count the database does not answer reads as none", async () => {
    const store = createPgCommitmentsStore({
      read: { query: async () => [] },
      transaction: async () => {
        throw new Error("not reached");
      },
    });
    assert.deepEqual(await store.subnet(1, { limit: 1, offset: 0 }), {
      observation: null,
      total: 0,
      rows: [],
    });
  });

  test("the emission families keep their own watermark beside the commitments'", async () => {
    await db.exec(
      "INSERT INTO observations (family, block_number, observed_at) VALUES " +
        "('subnet_emission_splits', 90, now()), ('subnet_lifecycle_states', 95, now()), " +
        "('commitments', 99, now())",
    );
    const emission = createPgSubnetEmissionStore(database());
    assert.equal((await emission.current()).observation?.block_number, "90");
  });
});
