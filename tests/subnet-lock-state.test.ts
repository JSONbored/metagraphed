// The conviction leaderboard, read live from chain storage (#9319).
//
// `/api/v1/subnets/{netuid}/conviction` was the last route in the API still
// answering `source: data-worker-unavailable`. Its capture lane died with
// Postgres and was NOT rebuilt: `buildSubnetConviction` already rolls each row
// forward from its own `last_update` using the current rates, so a row read
// straight from chain storage goes through identical math to one read from a
// snapshot. No `subnet_locks` table, no migration, no producer cron.
//
// Every byte-level fact asserted here was verified against finney before it was
// written down -- the key hashers and the LockState field offsets in particular,
// because both are the kind of thing that "looks decoded" while being wrong.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  LOCK_RATE_DEFAULT,
  decodeLockState,
  defaultChainRpc,
  loadSubnetConvictionChainTier,
} from "../src/subnet-lock-state.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import {
  bytesToHex,
  storageMapPrefix,
  u16LeBytes,
} from "../src/twox-storage-key.ts";

/** A real OwnerLock(netuid=1) value, copied from finney 2026-08-03. */
const LIVE_OWNER_LOCK =
  "0xa12646795faf00000000000000000000a12646795faf0000d845850000000000";
const LIVE_LOCKED_MASS = 192_824_591_394_465n;
const LIVE_LAST_UPDATE = 8_734_168;

const HEAD = { number: "0x85d1db" }; // 8,770,011

describe("decodeLockState", () => {
  test("reads locked_mass, conviction and last_update at the right offsets", () => {
    // The proof this is not a guess that happens to fit: on a live sample the
    // U64F64's INTEGER part equals locked_mass EXACTLY, with a zero fraction.
    // That only holds if both are being read from the correct offsets.
    const state = decodeLockState(LIVE_OWNER_LOCK);
    assert.ok(state);
    assert.equal(state.lockedMass, LIVE_LOCKED_MASS);
    assert.equal(state.lastUpdate, LIVE_LAST_UPDATE);
    assert.equal(
      state.convictionBits >> 64n,
      LIVE_LOCKED_MASS,
      "U64F64 integer part must equal locked_mass on this live sample",
    );
    assert.equal(
      state.convictionBits % 2n ** 64n,
      0n,
      "and its fractional part must be zero",
    );
  });

  test("rejects anything that is not exactly 32 bytes", () => {
    // A short blob is not a lock worth zero -- publishing one would understate
    // the subnet's total conviction with no way for a caller to notice.
    for (const bad of [
      null,
      undefined,
      "",
      "0x",
      "0xdeadbeef",
      `${LIVE_OWNER_LOCK}00`,
      "not-hex",
      "0xzz".repeat(32),
      42,
    ]) {
      assert.equal(decodeLockState(bad), null, JSON.stringify(bad));
    }
  });
});

describe("loadSubnetConvictionChainTier", () => {
  const prefix = (item: string) =>
    bytesToHex(storageMapPrefix("SubtensorModule", item));
  /** The netuid-suffixed single key, exactly as the reader builds it. */
  const nk = (item: string, netuid = 7) =>
    prefix(item) + bytesToHex(u16LeBytes(netuid)).slice(2);
  /** A (netuid, hotkey) DMap key: netuid ++ blake2_128 ++ account. */
  const dmapKey = (item: string, accountByte: string, netuid = 7) =>
    nk(item, netuid) + "ab".repeat(16) + accountByte.repeat(32);

  /**
   * A fake chain keyed on the ACTUAL storage keys the reader asks for, built
   * from the same helpers it uses. Keying on real prefixes rather than on call
   * order means a reordering of the reads cannot silently hand a fixture to the
   * wrong map -- the failure this shape exists to prevent.
   */
  function chain(
    over: {
      header?: unknown;
      values?: Record<string, unknown>;
      keys?: Record<string, unknown>;
    } = {},
  ) {
    const seen: Array<[string, string]> = [];
    const rpc = async (method: string, params: unknown[]) => {
      const key = String(params[0] ?? "");
      seen.push([method, key]);
      // `"header" in over` rather than `over.header ?? HEAD`: the decline
      // cases override it to undefined/null, and `??` would swallow both and
      // silently answer with a healthy head.
      if (method === "chain_getHeader")
        return "header" in over ? over.header : HEAD;
      if (method === "state_getKeysPaged") {
        return over.keys && key in over.keys ? over.keys[key] : [];
      }
      return over.values?.[key] ?? null;
    };
    return { rpc, seen };
  }

  test("refuses a netuid that is not a real subnet id", async () => {
    for (const netuid of [-1, 1.5, Number.NaN, 65_536, 1e9]) {
      const c = chain();
      assert.equal(
        await loadSubnetConvictionChainTier(netuid, { rpc: c.rpc }),
        null,
        `netuid ${netuid}`,
      );
      assert.equal(c.seen.length, 0, "must not reach the chain");
    }
  });

  test("declines when the head block cannot be read", async () => {
    // (now - last_update) is the roll-forward's entire input, so an unknown
    // head makes every row's decay unknowable. A board computed against
    // `now = 0` would report every lock as fully decayed.
    for (const header of [undefined, null, {}, { number: "not-hex" }]) {
      const c = chain({ header });
      assert.equal(
        await loadSubnetConvictionChainTier(7, { rpc: c.rpc }),
        null,
        JSON.stringify(header),
      );
    }
  });

  test("an absent rate means its declared default, not zero", async () => {
    // A missing StorageValue means "the runtime's declared default". Reading it
    // as 0 would make exp_decay treat every lock as instantaneously decayed --
    // a whole subnet's board silently collapsing.
    const c = chain();
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    assert.equal(data.unlock_rate, LOCK_RATE_DEFAULT);
    assert.equal(data.maturity_rate, LOCK_RATE_DEFAULT);
  });

  test("reads the two rates independently", async () => {
    // They are separately governance-adjustable and DO differ live
    // (MaturityRate 311,622 against UnlockRate's 934,866 default), which is why
    // decayMassAndConviction's three-way branch must not be collapsed.
    const c = chain({
      values: {
        [prefix("UnlockRate")]: "0xd2430e0000000000", // 934,866 LE u64
        [prefix("MaturityRate")]: "0x46c1040000000000", // 311,622 LE u64
      },
    });
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    assert.equal(data.unlock_rate, 934_866);
    assert.equal(data.maturity_rate, 311_622);
  });

  test("declines on a malformed rate rather than defaulting past it", async () => {
    // An unreadable value is not an absent one: defaulting here would publish a
    // board computed against a rate the chain never reported.
    for (const item of ["UnlockRate", "MaturityRate"]) {
      const c = chain({ values: { [prefix(item)]: "0xdead" } });
      assert.equal(
        await loadSubnetConvictionChainTier(7, { rpc: c.rpc }),
        null,
        item,
      );
    }
  });

  test("a subnet with no locks publishes a MEASURED empty board", async () => {
    // Distinct from declining: the rates and the queried block are real, and
    // the board is genuinely empty. Returning null here would make a quiet
    // subnet indistinguishable from an unreachable chain.
    const c = chain();
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    assert.equal(data.count, 0);
    assert.deepEqual(data.leaderboard, []);
    assert.equal(data.queried_at_block, 8_770_011);
  });

  test("builds the owner row from SubnetOwnerHotkey, not from the key", async () => {
    // OwnerLock is keyed by netuid alone, so unlike the DMaps its identity is
    // not recoverable from the key -- it has to come from SubnetOwnerHotkey.
    const c = chain({
      values: {
        [nk("OwnerLock")]: LIVE_OWNER_LOCK,
        [nk("SubnetOwnerHotkey")]: `0x${"22".repeat(32)}`,
      },
    });
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    assert.equal(data.count, 1);
    const row = (data.leaderboard as Array<Record<string, unknown>>)[0]!;
    assert.equal(row.is_owner, true);
    assert.equal(row.locked_mass, Number(LIVE_LOCKED_MASS));
    assert.match(String(row.hotkey), /^5/, "an SS58, not raw bytes");
  });

  test("declines an owner lock whose owner hotkey cannot be resolved", async () => {
    // A leaderboard is keyed by hotkey. Publishing an unattributed row would
    // put real locked mass against nobody.
    const c = chain({ values: { [nk("OwnerLock")]: LIVE_OWNER_LOCK } });
    assert.equal(await loadSubnetConvictionChainTier(7, { rpc: c.rpc }), null);
  });

  test("declines an owner lock whose value will not decode", async () => {
    const c = chain({
      values: {
        [nk("OwnerLock")]: "0xdeadbeef",
        [nk("SubnetOwnerHotkey")]: `0x${"22".repeat(32)}`,
      },
    });
    assert.equal(await loadSubnetConvictionChainTier(7, { rpc: c.rpc }), null);
  });

  test("recovers each hotkey from the trailing 32 bytes of its DMap key", async () => {
    // The second hasher is Blake2_128Concat (16 bytes), not Twox64Concat (8).
    // Reading the account from the wrong offset yields a valid-looking SS58 for
    // an account that does not exist, which is why this asserts the identity
    // rather than merely that a row appeared.
    const key = dmapKey("HotkeyLock", "33");
    const c = chain({
      keys: { [nk("HotkeyLock")]: [key] },
      values: { [key]: LIVE_OWNER_LOCK },
    });
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    assert.equal(data.count, 1);
    const row = (data.leaderboard as Array<Record<string, unknown>>)[0]!;
    assert.equal(row.is_owner, false);
    assert.equal(
      row.hotkey,
      encodeAccountId32(new Uint8Array(32).fill(0x33)),
      "the account is the key's LAST 32 bytes",
    );
  });

  test("marks each map's rows with the right owner/perpetual pair", async () => {
    // The four maps are the same struct meaning four different things; mixing
    // them up would put a decaying lock on the perpetual side of the math.
    const perp = dmapKey("HotkeyLock", "44");
    const decaying = dmapKey("DecayingHotkeyLock", "55");
    const c = chain({
      keys: {
        [nk("HotkeyLock")]: [perp],
        [nk("DecayingHotkeyLock")]: [decaying],
      },
      values: {
        [perp]: LIVE_OWNER_LOCK,
        [decaying]: LIVE_OWNER_LOCK,
        [nk("OwnerLock")]: LIVE_OWNER_LOCK,
        [nk("DecayingOwnerLock")]: LIVE_OWNER_LOCK,
        [nk("SubnetOwnerHotkey")]: `0x${"22".repeat(32)}`,
      },
    });
    const data = await loadSubnetConvictionChainTier(7, { rpc: c.rpc });
    assert.ok(data);
    // The owner's two sub-aggregates combine into ONE leaderboard entry, so
    // three hotkeys yield three rows.
    assert.equal(data.count, 3);
    const owners = (data.leaderboard as Array<Record<string, unknown>>).filter(
      (r) => r.is_owner,
    );
    assert.equal(owners.length, 1, "perpetual + decaying owner rows combine");
  });

  test("declines when an enumerated key's value will not decode", async () => {
    // The key came from this very prefix, so an undecodable value is a real
    // inconsistency, not an absence. Dropping the row would understate the
    // board with nothing to signal it.
    const key = dmapKey("HotkeyLock", "66");
    const c = chain({
      keys: { [nk("HotkeyLock")]: [key] },
      values: { [key]: "0x1234" },
    });
    assert.equal(await loadSubnetConvictionChainTier(7, { rpc: c.rpc }), null);
  });

  test("declines when an enumerated key is too short to hold an account", async () => {
    const c = chain({
      keys: { [nk("HotkeyLock")]: ["0xdead"] },
      values: { "0xdead": LIVE_OWNER_LOCK },
    });
    assert.equal(await loadSubnetConvictionChainTier(7, { rpc: c.rpc }), null);
  });

  test("declines when a key enumeration fails or is not a list", async () => {
    // undefined from the RPC means the call FAILED; [] means the subnet has no
    // locks of that kind. Collapsing them would publish a partial board as
    // though it were complete.
    for (const bad of [undefined, "not-a-list", 42]) {
      const c = chain({ keys: { [nk("HotkeyLock")]: bad } });
      assert.equal(
        await loadSubnetConvictionChainTier(7, { rpc: c.rpc }),
        null,
        JSON.stringify(bad),
      );
    }
  });
});

describe("defaultChainRpc", () => {
  // The only part that touches the network. Stubbed rather than skipped,
  // because "never throws" is the property every decline path above depends on.
  async function withFetch(stub: typeof fetch, fn: () => Promise<unknown>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  test("returns the JSON-RPC result on success", async () => {
    const out = await withFetch(
      (async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xbeef" }),
        )) as unknown as typeof fetch,
      () => defaultChainRpc("state_getStorage", ["0x00"]),
    );
    assert.equal(out, "0xbeef");
  });

  test("returns undefined rather than throwing on any failure", async () => {
    // A throw here would 500 the route instead of degrading it.
    const failures: Array<typeof fetch> = [
      (async () =>
        new Response("nope", { status: 502 })) as unknown as typeof fetch,
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      (async () => new Response("not json")) as unknown as typeof fetch,
    ];
    for (const stub of failures) {
      assert.equal(
        await withFetch(stub, () => defaultChainRpc("chain_getHeader", [])),
        undefined,
      );
    }
  });
});

describe("all three conviction surfaces reach the live tier", () => {
  test("REST and MCP go through coldTierChainEventsPayload", () => {
    // GraphQL proxies the REST route byte-for-byte, so wiring the shared
    // dispatcher plus MCP's own fallback covers all three.
    assert.match(
      readFileSync("src/chain-events-degraded.ts", "utf8"),
      /loadSubnetConvictionChainTier\(/,
      "the shared dispatcher REST reaches must serve conviction",
    );
    assert.match(
      readFileSync("src/mcp-server.ts", "utf8"),
      /loadSubnetConviction[\s\S]{0,600}coldTierChainEventsPayload\(/,
      "MCP must fall back to the SAME reader, or the two surfaces can disagree",
    );
  });

  test("no subnet_locks capture tier was reintroduced", () => {
    // The whole point: the lane is not rebuilt. A table, migration or write
    // path appearing here would mean someone took the larger road after all.
    // Comments legitimately NAME subnet_locks while explaining its absence, so
    // this asserts on the code: no D1 binding, no prepared statement, no SQL.
    const code = readFileSync("src/subnet-lock-state.ts", "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /subnet_locks/);
    assert.doesNotMatch(code, /prepare\(|\.bind\(|SELECT /i);
  });
});
