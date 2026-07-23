import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

// #6274: exchange_listings is additive registry metadata on the subnet manifest,
// following the links[]/social pattern (an array of structured objects, no
// probe/verification machinery). These validate the new field's shape against
// the real schema.

const schema = JSON.parse(
  readFileSync(
    path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
    "utf8",
  ),
);
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validate = ajv.compile(schema);

// A minimal manifest carrying every required field, so a test only exercises the
// exchange_listings field it overrides.
function manifest(overrides = {}) {
  return {
    schema_version: 1,
    netuid: 1,
    name: "Example",
    slug: "example",
    status: "active",
    categories: [],
    surfaces: [],
    ...overrides,
  };
}

describe("subnet-manifest schema: exchange_listings (#6274)", () => {
  test("accepts valid entries (exchange + url, optional pair)", () => {
    const ok = validate(
      manifest({
        exchange_listings: [
          { exchange: "MEXC", url: "https://www.mexc.com/x", pair: "TAO/USDT" },
          { exchange: "Kraken", url: "https://pro.kraken.com/app/trade/x" },
        ],
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  test("is optional/additive — a manifest without it still validates", () => {
    assert.equal(validate(manifest()), true, JSON.stringify(validate.errors));
    assert.equal(validate(manifest({ exchange_listings: [] })), true);
  });

  test("requires both exchange and url on each entry", () => {
    assert.equal(
      validate(manifest({ exchange_listings: [{ url: "https://x.com" }] })),
      false,
    );
    assert.equal(
      validate(manifest({ exchange_listings: [{ exchange: "MEXC" }] })),
      false,
    );
  });

  test("rejects a non-uri url, an empty exchange, and unknown properties", () => {
    assert.equal(
      validate(
        manifest({ exchange_listings: [{ exchange: "MEXC", url: "nope" }] }),
      ),
      false,
    );
    assert.equal(
      validate(
        manifest({
          exchange_listings: [{ exchange: "", url: "https://x.com" }],
        }),
      ),
      false,
    );
    assert.equal(
      validate(
        manifest({
          exchange_listings: [
            { exchange: "MEXC", url: "https://x.com", ticker: "TAO" },
          ],
        }),
      ),
      false,
    );
  });
});
