// The drift check is the live half of the emission harness: the SAME
// reconstruction tests/emission-pipeline.test.ts pins against the committed
// fixture, held against chain state. So the fixture IS the test double here:
// a fake RPC serving its raw hex must reproduce a clean bill of health, and
// any tampering with the observed emissions must be called out. That closes
// the loop the two suites promise -- one implementation, both callers proven
// on the same data.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import fixture from "./fixtures/emission-pipeline.json" with { type: "json" };
import {
  checkEmissionDrift,
  probedNetuids,
} from "../src/emission-drift-check.ts";
import {
  DEFAULT_EMISSION_GATE_EXPONENT,
  decodeLeU64,
} from "../src/network-parameters.ts";
import { blockEmissionForIssuance } from "../src/block-emission.ts";

import { fixtureFetch } from "./helpers/emission-fixture-rpc.ts";

const maps = fixture.maps as unknown as Record<string, Record<string, string>>;
const values = fixture.values as unknown as Record<string, string | null>;

describe("checkEmissionDrift", () => {
  test("gives the committed fixture a clean bill of health, reads pinned", async () => {
    const { impl, calls } = fixtureFetch();
    const { summary, reasons } = await checkEmissionDrift({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
      timeoutMs: 5_000,
    });

    assert.deepEqual(reasons, []);
    assert.equal(summary.identities_failed, 0);
    assert.equal(summary.block_number, fixture.block_number);
    assert.equal(summary.last_gate_block, fixture.last_gate_block);
    // The fixture captured the exponent UNSET -- the runtime default applies,
    // never a recorded zero.
    assert.equal(summary.exponent, DEFAULT_EMISSION_GATE_EXPONENT);
    const emission = blockEmissionForIssuance(
      decodeLeU64(values.total_issuance),
    )!;
    assert.equal(summary.block_emission_rao, emission.rao_per_block.toString());
    assert.equal(summary.halvings, emission.halvings);
    assert.ok(summary.eligible > 0);
    assert.ok(summary.disabled > 0);
    assert.ok(summary.theta > 0);
    assert.ok(summary.max_share_error >= summary.mean_share_error);
    assert.notEqual(summary.theta_recomputed, null);

    // Every state read is PINNED to the header's block hash: theta recomputes
    // on the 360-block boundary and the EMAs move every block, so an unpinned
    // read would mix states that never coexisted.
    for (const call of calls) {
      if (call.method === "state_queryStorageAt")
        assert.equal(call.params[1], fixture.block_hash);
      if (call.method === "state_getStorage")
        assert.equal(call.params[1], fixture.block_hash);
    }
  });

  test("a set exponent is decoded, not defaulted", async () => {
    // 1.0 in U64F64: integer part 1 in the high 64 bits -> LE u128 hex.
    const oneU64F64 = "0x" + "00".repeat(8) + "01" + "00".repeat(7);
    const exponentKey =
      fixture.storage_prefix +
      (fixture.item_hashes as Record<string, string>).emission_gate_exponent;
    const { impl } = fixtureFetch((m, p) =>
      m === "state_getStorage" && p[0] === exponentKey ? oneU64F64 : undefined,
    );
    const { summary } = await checkEmissionDrift({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(summary.exponent, 1);
  });

  test("tampered observed emissions are called out", async () => {
    // Quadruple every subnet's observed TaoInEmission: the identity totals
    // stop matching and the per-subnet shares stay consistent -- exactly the
    // shape of a capture break or a runtime change.
    const taoHash = (fixture.item_hashes as Record<string, string>)
      .tao_in_emission;
    const tao = maps.tao_in_emission;
    const prefix = (fixture.storage_prefix as string).slice(2);
    const { impl } = fixtureFetch((m, p) => {
      if (m !== "state_queryStorageAt") return undefined;
      const keys = p[0] as string[];
      if (!keys[0]?.includes(taoHash)) return undefined;
      const changes = keys.map((key) => {
        const suffix = key.slice(-4);
        const netuid =
          Number.parseInt(suffix.slice(0, 2), 16) +
          Number.parseInt(suffix.slice(2, 4), 16) * 256;
        const raw = tao[String(netuid)];
        if (!raw) return [key, null];
        const quadrupled = (decodeLeU64(raw)! * 4n)
          .toString(16)
          .padStart(16, "0");
        const le = quadrupled.match(/../g)!.reverse().join("");
        return [key, "0x" + le];
      });
      void prefix;
      return [{ changes }];
    });
    const { summary, reasons } = await checkEmissionDrift({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.ok(reasons.length > 0);
    assert.ok(summary.identities_failed > 0);
  });

  test("an empty chain read still summarizes instead of dividing by zero", async () => {
    // A node answering no map entries at all: nothing eligible, nothing
    // observed -- the mean/max error paths must degrade to zero, not NaN.
    const { impl } = fixtureFetch((m) =>
      m === "state_queryStorageAt" ? [] : undefined,
    );
    const { summary } = await checkEmissionDrift({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(summary.eligible, 0);
    assert.equal(summary.mean_share_error, 0);
    assert.equal(summary.max_share_error, 0);
    assert.equal(summary.max_share_error_netuid, -1);
  });

  test("an unset TotalIssuance throws -- block emission is never assumed", async () => {
    const issuanceKey =
      fixture.storage_prefix +
      (fixture.item_hashes as Record<string, string>).total_issuance;
    // A null override IS an override -- only undefined falls through.
    const { impl } = fixtureFetch((m, p) =>
      m === "state_getStorage" && p[0] === issuanceKey ? null : undefined,
    );
    await assert.rejects(
      () => checkEmissionDrift({ rpcUrl: "https://rpc.test", fetchImpl: impl }),
      /could not derive block emission/,
    );
  });

  test("absent bar/quantile and an undecodable exponent all degrade to zero", async () => {
    // A chain where governance never wrote the gate parameters: bar and
    // quantile read as zero (never invented), and a present-but-undecodable
    // exponent degrades to zero rather than the runtime default -- a decoded
    // garbage value must not masquerade as "unset".
    const hashes = fixture.item_hashes as Record<string, string>;
    const nulled = new Set(
      [hashes.emission_gate_bar, hashes.emission_bar_quantile].map(
        (h) => fixture.storage_prefix + h,
      ),
    );
    const exponentKey = fixture.storage_prefix + hashes.emission_gate_exponent;
    const { impl } = fixtureFetch((m, p) => {
      if (m !== "state_getStorage") return undefined;
      if (nulled.has(p[0] as string)) return null;
      if (p[0] === exponentKey) return "0xnothex";
      return undefined;
    });
    const { summary } = await checkEmissionDrift({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(summary.theta, 0);
    assert.equal(summary.quantile, 0);
    assert.equal(summary.exponent, 0);
  });

  test("an HTTP failure throws -- a partial read is never scored", async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 503,
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => checkEmissionDrift({ rpcUrl: "https://rpc.test", fetchImpl: impl }),
      /HTTP 503/,
    );
  });

  test("an rpc error body throws with the engine's payload, via the global fetch default", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ error: { code: -32000, message: "unavailable" } }),
      }) as unknown as Response) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => checkEmissionDrift({ rpcUrl: "https://rpc.test" }),
        /unavailable/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// --- the netuid range is READ, not assumed (the 129th subnet) ---------------
//
// `Array.from({ length: 128 })` read netuids 0..127 while TotalNetworks was
// already 129. The aggregate identity is a SUM, so the check reported the
// network as drifting by exactly the emission of the subnet it had not looked
// at -- measured in production as Δ -110,236 to -125,520 rao, against netuid
// 128 carrying ~120,705 rao of tao_in_emission. Right that something was
// wrong; wrong about what.

describe("the netuid range", () => {
  /** The item hash TotalNetworks is served under, from the fixture itself. */
  const TOTAL_NETWORKS_HASH = (fixture.item_hashes as Record<string, string>)
    .total_networks;

  /** Every netuid the run actually asked the chain about. */
  function netuidsRead(
    calls: { method: string; params: unknown[] }[],
  ): number[] {
    const seen = new Set<number>();
    for (const call of calls) {
      if (call.method !== "state_queryStorageAt") continue;
      for (const key of call.params[0] as string[]) {
        const suffix = key.slice(-4);
        seen.add(
          Number.parseInt(suffix.slice(0, 2), 16) +
            Number.parseInt(suffix.slice(2, 4), 16) * 256,
        );
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  /** Serve the fixture, but report a different TotalNetworks. */
  function withTotalNetworks(hex: string | null) {
    return fixtureFetch((method, params) => {
      if (method !== "state_getStorage") return undefined;
      const key = params[0] as string;
      return key.endsWith(TOTAL_NETWORKS_HASH) ? hex : undefined;
    });
  }

  test("follows TotalNetworks, so a NEW subnet is read the block it appears", async () => {
    // 129 subnets means netuids 0..128 -- the case production was in.
    const { impl, calls } = withTotalNetworks("0x8100");
    await checkEmissionDrift({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const read = netuidsRead(calls);
    assert.equal(read.at(-1), 128, "the newest subnet was read");
    assert.equal(read.length, 129);
  });

  test("does NOT probe one past the count, unlike the burn lane", async () => {
    // src/chain-burn.ts deliberately reads `total + 1` as cheap insurance,
    // because an absent key is simply null to it. Here it is not free:
    // emission_enabled is ABSENT-MEANS-ENABLED, so a phantom netuid would
    // enter the reconstruction as an enabled subnet with no emission and shift
    // every share.
    const { impl, calls } = withTotalNetworks("0x8000");
    await checkEmissionDrift({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const read = netuidsRead(calls);
    assert.equal(read.at(-1), 127);
    assert.equal(read.length, 128);
  });

  test("an unreadable count throws rather than guessing a range", async () => {
    // The same rule the block-emission read follows: a partial read must never
    // be scored as if it were a complete one. Guessing the range is precisely
    // how this check came to report its own blind spot as chain drift.
    const { impl } = withTotalNetworks(null);
    await assert.rejects(
      () => checkEmissionDrift({ rpcUrl: "https://rpc.test", fetchImpl: impl }),
      /TotalNetworks/,
    );
  });

  test("probedNetuids caps an absurd count instead of minting a million keys", () => {
    assert.deepEqual(probedNetuids(3), [0, 1, 2]);
    assert.equal(probedNetuids(65535).length, 1024);
    // A chain reporting zero subnets reads none -- and the identity checks
    // then fail loudly on an empty sum, which is the correct outcome.
    assert.deepEqual(probedNetuids(0), []);
  });
});
