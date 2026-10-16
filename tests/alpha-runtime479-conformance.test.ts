import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { quoteAlphaPool } from "../src/alpha-share-value.ts";
import { runtime479Diagnostics } from "./helpers/alpha-runtime479-diagnostics.ts";

interface Decimal {
  mantissa: string;
  exponent: string;
}
interface OracleDecimal extends Decimal {
  scale_hex: string;
}
interface OracleCase {
  id: string;
  provenance: "synthetic" | "historical_crosscheck";
  evidence: unknown;
  expected: {
    status: string;
    classification: string;
    alpha_rao: string | null;
    runtime_get_stake_alpha_rao: string;
    uncapped_alpha_rao: string | null;
    share_source: string;
    denominator_source: string;
    selected_raw_share: OracleDecimal | null;
    effective_share: OracleDecimal | null;
    effective_denominator: OracleDecimal;
    effective_pool_epoch: string;
    effective_member_epoch: string;
    upstream_div_ratio: OracleDecimal | null;
  };
}
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/alpha-runtime/valuation-479.json", import.meta.url),
    "utf8",
  ),
) as { cases: OracleCase[] };

function scale(value: Decimal | null): string | null {
  if (value === null) return null;
  const bytes = Buffer.alloc(24);
  const mantissa = BigInt(value.mantissa);
  bytes.writeBigUInt64LE(mantissa & ((1n << 64n) - 1n), 0);
  bytes.writeBigUInt64LE(mantissa >> 64n, 8);
  bytes.writeBigInt64LE(BigInt(value.exponent), 16);
  return "0x" + bytes.toString("hex");
}

function assertDecimal(actual: Decimal | null, expected: OracleDecimal | null) {
  assert.deepEqual(
    actual,
    expected === null
      ? null
      : { mantissa: expected.mantissa, exponent: expected.exponent },
  );
  assert.equal(scale(actual), expected?.scale_hex ?? null);
}

test("runtime479 conformance retains all synthetic and unchanged historical inputs", () => {
  assert.equal(fixture.cases.length, 27);
  assert.equal(
    fixture.cases.filter((c) => c.provenance === "synthetic").length,
    23,
  );
  assert.equal(
    fixture.cases.filter((c) => c.provenance === "historical_crosscheck").length,
    4,
  );
  for (const spec of [454, 478]) {
    const original = JSON.parse(
      readFileSync(
        new URL(`./fixtures/alpha-runtime/frozen-${spec}.json`, import.meta.url),
        "utf8",
      ),
    ) as { members: { evidence: unknown }[] };
    for (const [index, member] of original.members.entries()) {
      const crosscheck = fixture.cases.find(
        (c) => c.id === `historical-${spec}-${index}`,
      );
      assert.deepEqual(crosscheck?.evidence, member.evidence);
    }
  }
});

for (const vector of fixture.cases) {
  test(`runtime479 official arithmetic: ${vector.id}`, () => {
    const quote = quoteAlphaPool(vector.evidence, 479);
    const actual = runtime479Diagnostics(vector.evidence);
    const expected = vector.expected;
    assert.ok(actual);
    assert.deepEqual(quote.evidence, vector.evidence);
    assertDecimal(actual.rawShare, expected.selected_raw_share);
    assertDecimal(actual.effectiveShare, expected.effective_share);
    assertDecimal(actual.effectiveDenominator, expected.effective_denominator);
    assertDecimal(actual.divisionRatio, expected.upstream_div_ratio);
    assert.equal(actual.shareSource, expected.share_source);
    assert.equal(actual.denominatorSource, expected.denominator_source);
    assert.equal(actual.poolEpoch, expected.effective_pool_epoch);
    assert.equal(actual.memberEpoch, expected.effective_member_epoch);
    assert.equal(actual.status, expected.status);
    assert.equal(actual.classification, expected.classification);
    assert.equal(actual.uncappedAlphaRao, expected.uncapped_alpha_rao);
    assert.equal(actual.tryGetValueAlphaRao, expected.alpha_rao);
    assert.equal(quote.tryGetValueAlphaRao, expected.alpha_rao);
    assert.equal(
      actual.runtimeGetterAlphaRao,
      expected.runtime_get_stake_alpha_rao,
    );
    assert.equal(quote.alphaRao, expected.runtime_get_stake_alpha_rao);
    assert.equal(quote.retired, expected.status === "retired_member");
    if (expected.status === "missing_member") {
      assert.equal(actual.rawShare, null);
      assert.equal(actual.effectiveShare, null);
      assert.equal(actual.tryGetValueAlphaRao, null);
      assert.equal(actual.runtimeGetterAlphaRao, "0");
    }
    if (expected.classification === "zero_share") {
      assert.ok(actual.rawShare);
      assert.equal(actual.effectiveShare?.mantissa, "0");
      assert.equal(actual.tryGetValueAlphaRao, "0");
      assert.equal(quote.retired, false);
    }
  });
}

test("invalid evidence and unsupported runtimes cannot become a qualified zero", () => {
  const evidence = fixture.cases[4].evidence as Record<string, unknown>;
  for (const invalid of [
    null,
    {},
    { ...evidence, extra: true },
    {
      ...evidence,
      total_alpha_rao: "18446744073709551616",
    },
  ])
    assert.throws(() => quoteAlphaPool(invalid, 479));
  assert.throws(() => quoteAlphaPool(fixture.cases[4].evidence, 480 as 479));
});
