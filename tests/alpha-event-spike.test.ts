import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { AlphaEventSpike } from "../scripts/lib/alpha-event-spike.ts";
import { analyzeAlphaEventFiles } from "../scripts/analyze-alpha-event-window.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import { quoteAlphaPool } from "../src/alpha-share-value.ts";
import { encodeAccountId32 } from "../src/ss58.ts";

const hot = encodeAccountId32(new Uint8Array(32).fill(1))!;
const other = encodeAccountId32(new Uint8Array(32).fill(2))!;
const cold = encodeAccountId32(new Uint8Array(32).fill(3))!;
const start = Date.parse("2026-10-14T00:00:00Z");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const runtime = (
  spec: 454 | 478 = 478,
): { spec_version: 454 | 478; code_hash: string; metadata_sha256: string } => ({
  spec_version: spec,
  code_hash: ALPHA_RUNTIMES[spec].code,
  metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
});
function evidence(v2 = false, retired = false) {
  return {
    share: v2
      ? {
          legacy_bits: null,
          v2: { mantissa: "100000000000000000000", exponent: "-20" },
        }
      : { legacy_bits: (1n << 64n).toString(), v2: null },
    denominator: { legacy_bits: (2n << 64n).toString(), v2: null },
    total_alpha_rao: "100",
    pool_epoch: retired ? "2" : null,
    member_epoch: retired ? "1" : null,
  };
}
function fixture(spec: 454 | 478 = 478) {
  const block = {
    block_number: 101,
    block_hash: hash(101),
    parent_hash: hash(100),
    timestamp_ms: start + 12_000,
    runtime: runtime(spec),
    events: [
      ["StakeAdded", [cold, hot, 10, 20, 7, 1]],
      ["StakeRemoved", [cold, hot, 5, 10, 7, 1]],
      ["StakeMoved", [cold, hot, 7, other, 8, 9]],
      ["StakeSwapped", [cold, hot, 7, 9, 10]],
      ["StakeTransferred", [cold, other, hot, 7, 10, 5]],
      ...(spec === 478
        ? [["SharePoolDenominatorReconciled", { netuid: 7, hotkey: hot }]]
        : []),
    ].map(([method, args], event_index) => ({
      event_index,
      pallet: "SubtensorModule",
      method,
      args: JSON.stringify(args),
    })),
    canonical_state: [false, true].map((v2, index) => ({
      hotkey: hot,
      coldkey: index === 0 ? cold : other,
      netuid: 7,
      evidence: evidence(v2),
      alpha_rao: quoteAlphaPool(evidence(v2), spec).alphaRao,
    })),
  };
  const source = JSON.stringify(block) + "\n";
  const { events, canonical_state: _state, ...header } = block;
  const manifest = {
    version: 1,
    evidence_kind: "synthetic",
    genesis_hash: ALPHA_GENESIS,
    source_sha256: createHash("sha256").update(source).digest("hex"),
    census_provenance:
      "Synthetic complete-window contract, not authentic chain history",
    day: "2026-10-14",
    before: {
      block_number: 100,
      block_hash: hash(100),
      parent_hash: hash(99),
      timestamp_ms: start - 1,
    },
    after: {
      block_number: 102,
      block_hash: hash(102),
      parent_hash: hash(101),
      timestamp_ms: start + 86_400_000,
    },
    blocks: [{ ...header, event_count: events.length }],
  };
  return { block, manifest, source };
}
function run(spec: 454 | 478 = 478) {
  const f = fixture(spec),
    analysis = new AlphaEventSpike(f.manifest);
  analysis.accept(f.block);
  return analysis.finish(f.manifest.source_sha256);
}

describe("bounded retained Alpha event spike", () => {
  test("counts both move/swap legs once while refusing event-only derivability", () => {
    for (const spec of [454, 478] as const) {
      const result = run(spec);
      assert.equal(result.known_event_touched_pool_count, 4);
      assert.equal(result.canonical_same_hash_checks, 2);
      assert.equal(result.event_only_producer_qualified, false);
      assert.equal(result.complete_state_mutation_pool_count, null);
      assert.equal(result.authentic_day_evidence_verified, false);
      assert.ok(
        result.events.every((row) => row.event_only_derivable === false),
      );
      assert.deepEqual(
        result.events.find((row) => row.method === "StakeAdded")!.operands,
        ["coldkey", "hotkey", "tao_amount", "alpha_amount", "netuid", "fee"],
      );
      assert.ok(
        (result.events[0]!.missing_state as string[]).some((name) =>
          name.includes("denominator"),
        ),
      );
    }
  });

  test("compares canonical originals with existing epoch-retirement arithmetic", () => {
    const f = fixture();
    f.block.canonical_state[0]!.evidence = evidence(false, true);
    f.block.canonical_state[0]!.alpha_rao = "0";
    const analysis = new AlphaEventSpike(f.manifest);
    analysis.accept(f.block);
    assert.equal(
      analysis.finish(f.manifest.source_sha256).canonical_same_hash_checks,
      2,
    );
    f.block.canonical_state[0]!.alpha_rao = "50";
    const failed = new AlphaEventSpike(f.manifest);
    assert.throws(() => failed.accept(f.block), /canonical quantity differs/);
    f.block.canonical_state[0]!.alpha_rao = "0";
    assert.throws(() => failed.accept(f.block), /poisoned/);
    assert.throws(() => failed.finish(f.manifest.source_sha256), /poisoned/);
  });

  test("pins runtime and preserves missing operands rather than guessing a destination", () => {
    const f = fixture();
    f.block.events[2]!.args = JSON.stringify([cold, hot, 7]);
    f.block.events.push({
      event_index: f.block.events.length,
      pallet: "SubtensorModule",
      method: "FutureMutation",
      args: "[]",
    });
    f.manifest.blocks[0]!.event_count++;
    const analysis = new AlphaEventSpike(f.manifest);
    analysis.accept(f.block);
    const report = analysis.finish(f.manifest.source_sha256);
    assert.equal(report.unsupported_subtensor_methods["478:FutureMutation"], 1);
    assert.ok(
      (report.events[2]!.missing_state as string[]).includes(
        "decodable pool identity",
      ),
    );
    f.block.runtime.code_hash = hash(1);
    f.manifest.blocks[0]!.runtime.code_hash = hash(1);
    f.block.canonical_state = [];
    const unknown = new AlphaEventSpike(f.manifest);
    unknown.accept(f.block);
    assert.equal(
      unknown.finish(f.manifest.source_sha256).known_event_touched_pool_count,
      0,
    );
  });

  test("keeps unsafe raw amount tokens and shows denominator/epoch effects only through canonical state", () => {
    const f = fixture();
    f.block.events[0]!.args = `["${cold}","${hot}",18446744073709551615,20,7,1]`;
    const changed = evidence(true);
    changed.denominator.legacy_bits = (4n << 64n).toString();
    f.block.canonical_state[0]!.evidence = changed;
    f.block.canonical_state[0]!.alpha_rao = "25";
    const analysis = new AlphaEventSpike(f.manifest);
    analysis.accept(f.block);
    const result = analysis.finish(f.manifest.source_sha256);
    assert.equal(result.known_event_touched_pool_count, 4);
    assert.equal(result.events[0]!.raw_args, f.block.events[0]!.args);
    assert.equal(result.events[0]!.typed_operands_valid, true);
    assert.equal(quoteAlphaPool(evidence(true, true), 454).alphaRao, "50");
    assert.equal(quoteAlphaPool(evidence(true, true), 478).alphaRao, "0");
  });

  test("excludes malformed operands and canonicalizes aliases before pool and member counting", () => {
    const f = fixture();
    f.block.events = [
      {
        event_index: 0,
        pallet: "SubtensorModule",
        method: "StakeAdded",
        args: JSON.stringify([null, hot, {}, false, 7, "bad"]),
      },
    ];
    f.manifest.blocks[0]!.event_count = 1;
    const malformed = new AlphaEventSpike(f.manifest);
    malformed.accept(f.block);
    assert.equal(
      malformed.finish(f.manifest.source_sha256).known_event_touched_pool_count,
      0,
    );
    assert.equal(
      malformed.finish(f.manifest.source_sha256).malformed_supported_events,
      1,
    );
    const aliases = fixture();
    aliases.block.events[1]!.args = JSON.stringify([
      cold,
      "1" + hot,
      5,
      10,
      7,
      1,
    ]);
    const normalized = new AlphaEventSpike(aliases.manifest);
    normalized.accept(aliases.block);
    assert.equal(
      normalized.finish(aliases.manifest.source_sha256)
        .known_event_touched_pool_count,
      4,
    );
    aliases.block.canonical_state[1]!.coldkey = "1" + cold;
    assert.throws(
      () => new AlphaEventSpike(aliases.manifest).accept(aliases.block),
      /identity/,
    );
    const wrongPrefix = fixture();
    wrongPrefix.block.canonical_state[0]!.hotkey = encodeAccountId32(
      new Uint8Array(32).fill(1),
      0,
    )!;
    assert.throws(
      () => new AlphaEventSpike(wrongPrefix.manifest).accept(wrongPrefix.block),
      /identity/,
    );
  });

  test("rejects duplicates, missing blocks, reordered events, reorgs and incomplete windows", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.block.parent_hash = hash(1);
      },
      (f: ReturnType<typeof fixture>) => {
        f.block.events[0]!.event_index = 1;
      },
      (f: ReturnType<typeof fixture>) => {
        f.block.events.pop();
      },
      (f: ReturnType<typeof fixture>) => {
        f.manifest.after.parent_hash = hash(1);
      },
      (f: ReturnType<typeof fixture>) => {
        f.manifest.blocks.push({ ...f.manifest.blocks[0]!, block_number: 102 });
      },
    ]) {
      const f = fixture();
      change(f);
      assert.throws(() => {
        const a = new AlphaEventSpike(f.manifest);
        a.accept(f.block);
        a.finish(f.manifest.source_sha256);
      });
    }
    const f = fixture(),
      a = new AlphaEventSpike(f.manifest);
    a.accept(f.block);
    assert.throws(() => a.accept(f.block), /pinned census/);
    assert.throws(() => a.finish(f.manifest.source_sha256), /poisoned/);
    const b = new AlphaEventSpike(f.manifest);
    b.accept(f.block);
    assert.throws(() => b.finish("f".repeat(64)), /digest/);
  });

  test("the read-only file adapter verifies the complete admitted source digest", async () => {
    const f = fixture(),
      directory = mkdtempSync(join(tmpdir(), "alpha-spike-"));
    try {
      const manifest = join(directory, "manifest.json"),
        source = join(directory, "blocks.ndjson");
      writeFileSync(manifest, JSON.stringify(f.manifest));
      writeFileSync(source, f.source);
      assert.equal(
        (await analyzeAlphaEventFiles(manifest, source))
          .known_event_touched_pool_count,
        4,
      );
      writeFileSync(source, f.source + "\n");
      await assert.rejects(analyzeAlphaEventFiles(manifest, source));
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  test("the file adapter refuses non-files, invalid UTF-8 and byte overflow without partial success", async () => {
    const f = fixture(),
      directory = mkdtempSync(join(tmpdir(), "alpha-spike-limits-"));
    try {
      const manifest = join(directory, "manifest.json"),
        source = join(directory, "blocks.ndjson");
      writeFileSync(manifest, JSON.stringify(f.manifest));
      writeFileSync(source, f.source);
      await assert.rejects(
        analyzeAlphaEventFiles(directory, source),
        /regular-file/,
      );
      await assert.rejects(
        analyzeAlphaEventFiles(manifest, directory),
        /regular-file/,
      );
      writeFileSync(
        source,
        Buffer.concat([
          Buffer.from(f.source.slice(0, -2)),
          Buffer.from([255]),
          Buffer.from("}\n"),
        ]),
      );
      await assert.rejects(
        analyzeAlphaEventFiles(manifest, source),
        /encoded data|encoding|UTF/i,
      );
      writeFileSync(source, " ".repeat(16 * 1024 * 1024 + 1));
      await assert.rejects(
        analyzeAlphaEventFiles(manifest, source),
        /Block line exceeds/,
      );
      // Sparse files prove admission before any large source is read.
      truncateSync(source, 256 * 1024 * 1024 + 1);
      await assert.rejects(
        analyzeAlphaEventFiles(manifest, source),
        /regular-file byte budget/,
      );
      writeFileSync(source, f.source);
      const exactManifest = JSON.stringify(f.manifest).padEnd(
        8 * 1024 * 1024,
        " ",
      );
      writeFileSync(manifest, exactManifest);
      assert.equal(
        (await analyzeAlphaEventFiles(manifest, source))
          .known_event_touched_pool_count,
        4,
      );
      truncateSync(manifest, 8 * 1024 * 1024 + 1);
      await assert.rejects(
        analyzeAlphaEventFiles(manifest, source),
        /regular-file byte budget/,
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
