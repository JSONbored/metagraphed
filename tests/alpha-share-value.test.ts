import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { quoteAlphaPool } from "../src/alpha-share-value.ts";
import type { Row } from "./row-type.ts";

const safe = (n: bigint, exponent = -21) => ({
  mantissa: n.toString(),
  exponent: String(exponent),
});
const original = (n: bigint) => ({ legacy_bits: null, v2: safe(n) });
const base = () => ({
  share: original(300000000000000000000n),
  denominator: original(1000000000000000000000n),
  total_alpha_rao: "1000000000",
  pool_epoch: null,
  member_epoch: null,
});

test("authentic legacy and V2 originals match sampled runtime values without inferring a denominator", () => {
  for (const spec of [454, 478] as const) {
    const f = JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/alpha-runtime/frozen-${spec}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Row;
    for (const m of f.members) {
      const quoted = quoteAlphaPool(m.evidence, spec);
      assert.equal(quoted.alphaRao, m.expected_alpha_rao);
      assert.equal(quoted.shareFraction, 1);
      assert.deepEqual(quoted.evidence, m.evidence);
    }
  }
});

test("synthetic fractional, mixed-layout, zero and overlapping originals use legacy presence first", () => {
  assert.equal(quoteAlphaPool(base(), 478).alphaRao, "300000000");
  const legacy = {
    ...base(),
    share: {
      legacy_bits: ((1n << 64n) * 3n).toString(),
      v2: safe(900000000000000000000n),
    },
    denominator: { legacy_bits: ((1n << 64n) * 10n).toString(), v2: null },
  };
  assert.equal(quoteAlphaPool(legacy, 478).alphaRao, "300000000");
  assert.equal(
    quoteAlphaPool(
      { ...legacy, share: { legacy_bits: "0", v2: legacy.share.v2 } },
      478,
    ).alphaRao,
    "0",
  );
  assert.equal(
    quoteAlphaPool({ ...base(), share: { legacy_bits: null, v2: null } }, 478)
      .alphaRao,
    "0",
  );
  assert.equal(
    quoteAlphaPool(
      {
        ...base(),
        denominator: { legacy_bits: "0", v2: base().denominator.v2 },
      },
      478,
    ).alphaRao,
    "0",
  );
  assert.equal(
    quoteAlphaPool({ ...base(), total_alpha_rao: "0" }, 478).alphaRao,
    "0",
  );
  const fractional = {
    ...base(),
    share: { legacy_bits: ((1n << 64n) / 2n).toString(), v2: null },
    denominator: { legacy_bits: (1n << 64n).toString(), v2: null },
  };
  assert.equal(quoteAlphaPool(fractional, 478).alphaRao, "500000000");
});

test("synthetic runtime454 and478 differ in epoch retirement and pool caps", () => {
  for (const member_epoch of [null, "0", "4", "6"]) {
    const e = { ...base(), pool_epoch: "5", member_epoch };
    assert.equal(quoteAlphaPool(e, 478).alphaRao, "0");
    assert.equal(quoteAlphaPool(e, 478).retired, true);
    assert.equal(quoteAlphaPool(e, 454).alphaRao, "300000000");
  }
  assert.equal(
    quoteAlphaPool({ ...base(), pool_epoch: "0", member_epoch: "9" }, 478)
      .alphaRao,
    "300000000",
  );
  const over = {
    ...base(),
    share: original(1000000000000000000000n),
    denominator: original(300000000000000000000n),
  };
  assert.equal(quoteAlphaPool(over, 478).alphaRao, "1000000000");
  assert.equal(quoteAlphaPool(over, 454).alphaRao, "3333333333");
});

test("synthetic exponent bounds, checked intermediates, capped powers and u64 saturation match runtime failure rules", () => {
  const min = "-9223372036854775808",
    max = "9223372036854775807";
  const sf = (mantissa: string, exponent: string) => ({
    legacy_bits: null,
    v2: { mantissa, exponent },
  });
  const e = {
    ...base(),
    share: sf("300000000000000000000", min),
    denominator: sf("1000000000000000000000", "0"),
  };
  assert.equal(quoteAlphaPool(e, 478).alphaRao, "0");
  const overflow = {
    ...base(),
    total_alpha_rao: "18446744073709551615",
    share: sf("1000000000000000000000", min),
    denominator: sf("1000000000000000000000", min),
  };
  assert.equal(
    quoteAlphaPool(overflow, 454).alphaRao,
    "0",
    "overflowing product exponent may not be canceled by denominator",
  );
  const saturate = {
    ...base(),
    share: sf("1000000000000000000000", "22"),
    denominator: sf("1000000000000000000000", "-21"),
  };
  assert.equal(quoteAlphaPool(saturate, 454).alphaRao, "18446744073709551615");
  assert.equal(quoteAlphaPool(saturate, 478).alphaRao, "1000000000");
  assert.equal(
    quoteAlphaPool(
      { ...saturate, share: sf("1000000000000000000000", max) },
      454,
    ).shareFraction,
    null,
  );
});

test("malformed or overbudget originals fail before bigint parsing or any lossy numeric coercion", () => {
  for (const bits of [
    "-1",
    "1.2",
    "01",
    "x",
    "1".repeat(100000),
    (1n << 128n).toString(),
  ])
    assert.throws(() =>
      quoteAlphaPool(
        { ...base(), share: { legacy_bits: bits, v2: null } },
        478,
      ),
    );
  for (const exponent of [
    "-0",
    "x",
    "9223372036854775808",
    "-9223372036854775809",
  ])
    assert.throws(() =>
      quoteAlphaPool(
        {
          ...base(),
          share: { legacy_bits: null, v2: { mantissa: "1", exponent } },
        },
        478,
      ),
    );
  assert.throws(() => quoteAlphaPool({ ...base(), extra: true }, 478));
  assert.throws(() =>
    quoteAlphaPool({ ...base(), total_alpha_rao: "18446744073709551616" }, 478),
  );
  assert.throws(() => quoteAlphaPool(base(), 999 as 478));
});

test("normalization cannot repair an intermediate signed exponent overflow", () => {
  for (const version of [454, 478] as const) {
    const evidence = {
      ...base(),
      total_alpha_rao: "1",
      share: {
        legacy_bits: null,
        v2: {
          mantissa: "1000000000000000000000",
          exponent: "9223372036854775807",
        },
      },
      denominator: {
        legacy_bits: null,
        v2: { mantissa: "999999999999999999999", exponent: "-21" },
      },
    };
    assert.equal(quoteAlphaPool(evidence, version).alphaRao, "0");
    assert.equal(
      quoteAlphaPool(
        {
          ...evidence,
          share: {
            legacy_bits: null,
            v2: { mantissa: "1", exponent: "0" },
          },
          denominator: {
            legacy_bits: null,
            v2: {
              mantissa: "1000000000000000000000",
              exponent: "9223372036854775787",
            },
          },
        },
        version,
      ).alphaRao,
      "0",
    );
  }
});
