// #11567: the privacy policy states retention numbers, and a privacy policy
// that is WRONG is worse than one that is missing -- it is a claim a reader
// relies on and a directory reviewer checks.
//
// apps/ui cannot import the server constants (they are not part of the
// published client package, and widening that package's public surface for a
// prose page would be the wrong trade), so the page restates them. This test is
// what stops the restatement drifting: it reads the page source and asserts the
// numbers still equal what the server enforces.
//
// The same discipline auth.md now uses (#11566), applied where a direct import
// is not available.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS,
  SURFACE_CREDENTIAL_MAX_TTL_SECONDS,
} from "../src/mcp-surface-credentials.ts";

const PRIVACY_PAGE = fileURLToPath(
  new URL("../apps/ui/src/routes/-privacy-page.tsx", import.meta.url),
);
const TERMS_PAGE = fileURLToPath(
  new URL("../apps/ui/src/routes/-terms-page.tsx", import.meta.url),
);

const privacy = readFileSync(PRIVACY_PAGE, "utf8");
const terms = readFileSync(TERMS_PAGE, "utf8");

const SECONDS_PER_DAY = 86_400;

function declaredDays(source: string, name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
  assert.ok(match, `${name} must be declared in the page`);
  return Number(match[1]);
}

describe("the privacy policy's retention numbers match what the server enforces", () => {
  test("the default credential lifetime", () => {
    assert.equal(
      declaredDays(privacy, "CREDENTIAL_DEFAULT_TTL_DAYS") * SECONDS_PER_DAY,
      SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS,
    );
  });

  test("the maximum credential lifetime", () => {
    assert.equal(
      declaredDays(privacy, "CREDENTIAL_MAX_TTL_DAYS") * SECONDS_PER_DAY,
      SURFACE_CREDENTIAL_MAX_TTL_SECONDS,
    );
  });

  test("the stated maximum is genuinely above the default", () => {
    // A positive control: the two assertions above would both pass if someone
    // set the constants equal, and the page's "at most" sentence would then be
    // describing a ceiling that is not one.
    assert.ok(
      SURFACE_CREDENTIAL_MAX_TTL_SECONDS >
        SURFACE_CREDENTIAL_DEFAULT_TTL_SECONDS,
    );
  });
});

describe("the pages state the things a directory review checks for", () => {
  // The Connectors Directory rejects on a missing or incomplete privacy
  // policy, and names the sections it must cover. These assert the SUBSTANCE
  // is present, not that particular prose survives editing.
  test("the privacy policy covers collection, use, sharing, retention and contact", () => {
    for (const [claim, pattern] of [
      ["collection", /Every request is logged/i],
      ["ip handling", /salted SHA-256 hash of your IP/i],
      ["agent-supplied text", /free-text context your agent chose to send/i],
      ["third-party sharing", /Who else processes it/i],
      ["retention", /Retention/],
      ["deletion route", /delete your account/i],
      ["contact", /open an issue/i],
    ] as const) {
      assert.match(privacy, pattern, `privacy policy must cover ${claim}`);
    }
  });

  test("the privacy policy names every processor we actually use", () => {
    // Naming a processor we do not use would be false; omitting one we do is
    // the failure that matters. Each of these appears in the deployed config.
    for (const processor of [
      "Cloudflare",
      "Neon",
      "PostHog",
      "Unkey",
      "GitHub",
    ]) {
      assert.match(privacy, new RegExp(processor), processor);
    }
  });

  test("the terms disclaim financial advice and warranty", () => {
    assert.match(terms, /Nothing here is financial advice/i);
    assert.match(terms, /without warranty/i);
    assert.match(terms, /non-custodial/i);
  });

  test("each page links to the other, so neither is a dead end", () => {
    assert.match(privacy, /to="\/terms"/);
    assert.match(terms, /to="\/privacy"/);
  });
});
