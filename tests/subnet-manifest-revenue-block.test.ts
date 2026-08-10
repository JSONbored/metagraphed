// #10441: the `revenue` block on a subnet surface declares what that surface
// measures and on what terms. Every field encodes a trap found by probing a
// real subnet, not a hypothetical:
//
//   role        — Targon's stats.targon.com/api/miners exposes `payout`, which
//                 is EMISSION payout to miners. Without an explicit role the
//                 denominator ends up in the numerator.
//   currency    — api.chutes.ai/payments/summary/tao is named for TAO and its
//                 values reconcile as USD.
//   excludes    — Chutes' `sponsored_inference` is subnet-funded and
//                 `pending_instance_revenue` is unrecognised; neither is
//                 external revenue.
//   supersedes  — Chutes exposes /payments (TAO channel) AND
//                 daily_revenue_summary (all channels). The first is a subset;
//                 summing both inflates ~10%.
//   searched_at — an undated absence is not evidence, so provenance "none"
//                 without a date is rejected rather than accepted as a claim.
//
// The two conditionals are the load-bearing part: a schema that only ever
// accepts proves nothing, so every `then` branch here is asserted to REJECT.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
const manifestSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const validate = ajv.compile(manifestSchema);

type Json = Record<string, unknown>;

// The SN64 surface this block was designed against, verified live 2026-08-10.
const CHUTES_REVENUE: Json = {
  role: "external-revenue",
  provenance: "probe-derived",
  currency: "USD",
  grain: "daily",
  fields: { date: "date", amount: "total_revenue" },
  excludes: ["sponsored_inference", "pending_instance_revenue"],
  supersedes: ["sn-64-chutes-payments-summary-tao"],
  circularity: "external",
  source_url: "https://api.chutes.ai/openapi.json",
};

function manifest(revenue?: Json): Json {
  const surface: Json = {
    id: "sn-64-chutes-daily-revenue-summary",
    name: "Chutes daily revenue summary",
    kind: "data-artifact",
    url: "https://api.chutes.ai/daily_revenue_summary",
    provider: "chutes",
    auth_required: false,
    authority: "community",
    public_safe: true,
  };
  if (revenue !== undefined) surface.revenue = revenue;
  return {
    schema_version: 1,
    netuid: 64,
    name: "Chutes",
    slug: "sn-64",
    status: "active",
    categories: ["inference"],
    surfaces: [surface],
  };
}

function errorsFor(doc: Json): string[] {
  validate(doc);
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath} ${e.keyword} ${JSON.stringify(e.params)}`,
  );
}

describe("subnet-manifest revenue block (#10441)", () => {
  test("accepts the real SN64 declaration", () => {
    assert.equal(
      validate(manifest(CHUTES_REVENUE)),
      true,
      errorsFor(manifest(CHUTES_REVENUE)).join("; "),
    );
  });

  test("the block stays optional — surfaces without revenue still validate", () => {
    assert.equal(validate(manifest()), true);
  });

  test("role and provenance are both required when the block is present", () => {
    for (const partial of [
      {},
      { role: "external-revenue" },
      { provenance: "probe-derived" },
    ]) {
      assert.equal(
        validate(manifest(partial as Json)),
        false,
        `expected rejection for ${JSON.stringify(partial)}`,
      );
    }
  });

  test("rejects a role or provenance outside the vocabulary", () => {
    // "revenue" is the kind of plausible-looking value a contributor reaches
    // for; it is not a role, and accepting it would erase the payout/proxy
    // distinction the enum exists to draw.
    assert.equal(
      validate(manifest({ role: "revenue", provenance: "probe-derived" })),
      false,
    );
    assert.equal(
      validate(
        manifest({ role: "external-revenue", provenance: "self-reported" }),
      ),
      false,
    );
  });

  test('provenance "none" without searched_at is rejected', () => {
    const undated = { role: "not-revenue", provenance: "none" };
    assert.equal(validate(manifest(undated)), false);
    assert.ok(
      errorsFor(manifest(undated)).some((e) => e.includes("searched_at")),
      "rejection must name searched_at, not fail for an unrelated reason",
    );

    const dated = { ...undated, searched_at: "2026-08-10T00:00:00Z" };
    assert.equal(
      validate(manifest(dated)),
      true,
      errorsFor(manifest(dated)).join("; "),
    );
  });

  test("external-revenue must declare currency, grain and fields", () => {
    // Without these the amount is a bare number with no unit, no period and no
    // named source field — exactly the shape that produced the TAO/USD trap.
    const bare = { role: "external-revenue", provenance: "probe-derived" };
    assert.equal(validate(manifest(bare)), false);
    const named = errorsFor(manifest(bare)).join(" ");
    for (const required of ["currency", "grain", "fields"]) {
      assert.ok(named.includes(required), `rejection must name ${required}`);
    }
  });

  test("an UNREADABLE external-revenue surface is not asked to describe its payload", () => {
    // #10453/#10458/#10459/#10462: SN93, SN110 and Hippius all declare revenue
    // endpoints in their own OpenAPI schemas that answer 401/403 without a key.
    // The endpoint is real and the role is external-revenue, but currency,
    // grain and the field names are exactly what cannot be known without
    // reading the payload. Demanding them here would force a contributor to
    // invent three values to describe a response nobody has seen — which is
    // the opposite of what the provenance ladder is for.
    for (const provenance of [
      "operator-attested",
      "third-party-reported",
    ] as const) {
      assert.equal(
        validate(manifest({ role: "external-revenue", provenance })),
        true,
        `${provenance} should not require currency/grain/fields`,
      );
    }
  });

  test("a READABLE external-revenue surface still must describe its payload", () => {
    for (const provenance of ["probe-derived", "chain-verified"] as const) {
      assert.equal(
        validate(manifest({ role: "external-revenue", provenance })),
        false,
        `${provenance} must still require currency/grain/fields`,
      );
    }
  });

  test("the currency/grain requirement applies only to external-revenue", () => {
    // A miner-payout or proxy surface has nothing to denominate, so demanding a
    // currency there would push contributors into inventing one.
    for (const role of ["usage-proxy", "miner-payout", "not-revenue"]) {
      assert.equal(
        validate(manifest({ role, provenance: "operator-attested" })),
        true,
        `${role} should not require currency/grain/fields`,
      );
    }
  });

  test("rejects unknown keys inside the block", () => {
    assert.equal(
      validate(manifest({ ...CHUTES_REVENUE, estimated_arr: 4260000 })),
      false,
      "an estimate has no place in a block whose whole point is observed provenance",
    );
  });

  test("circularity documents unknown as its default rather than external", () => {
    const def = manifestSchema.$defs.revenue.properties.circularity;
    assert.equal(def.default, "unknown");
    assert.ok(!def.enum.includes("external-assumed"));
  });
});

describe("subnet-level revenue_search (#10543)", () => {
  function manifestWith(search?: Json): Json {
    const doc = manifest() as Record<string, unknown>;
    if (search !== undefined) doc.revenue_search = search;
    return doc as Json;
  }
  const GOOD: Json = {
    searched_at: "2026-08-10T00:00:00Z",
    outcome: "none-found",
    checked: ["website", "docs", "source-repo"],
  };

  test("accepts a complete search record", () => {
    assert.equal(
      validate(manifestWith(GOOD)),
      true,
      errorsFor(manifestWith(GOOD)).join("; "),
    );
  });

  test("stays optional", () => {
    assert.equal(validate(manifestWith()), true);
  });

  test("all three of searched_at, outcome and checked are required", () => {
    for (const key of ["searched_at", "outcome", "checked"]) {
      const partial = { ...(GOOD as Record<string, unknown>) };
      delete partial[key];
      assert.equal(
        validate(manifestWith(partial as Json)),
        false,
        `accepted a record missing ${key}`,
      );
    }
  });

  test("`checked` may not be empty", () => {
    // An empty list would let a subnet claim it was searched while naming
    // nowhere it looked — unfalsifiable, and the exact thing this field is for.
    assert.equal(
      validate(
        manifestWith({
          ...(GOOD as Record<string, unknown>),
          checked: [],
        } as Json),
      ),
      false,
    );
  });

  test("rejects an outcome or source outside the vocabulary", () => {
    assert.equal(
      validate(
        manifestWith({
          ...(GOOD as Record<string, unknown>),
          outcome: "maybe",
        } as Json),
      ),
      false,
    );
    assert.equal(
      validate(
        manifestWith({
          ...(GOOD as Record<string, unknown>),
          checked: ["vibes"],
        } as Json),
      ),
      false,
    );
  });
});
