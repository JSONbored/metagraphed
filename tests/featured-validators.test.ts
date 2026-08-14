// The `featured` badge, which was served on every validator row and could
// never be true (#11080).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  featuredHotkeysFrom,
  render,
} from "../scripts/generate-featured-validators.ts";
import { FeaturedValidatorsFileSchema } from "../schemas-src/artifacts/featured-validators.ts";
import {
  FEATURED_HOTKEYS,
  FEATURED_HOTKEY_SET,
} from "../generated/featured-validators.ts";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
} from "../src/metagraph-neurons.ts";
import { repoRoot } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const VALID = JSON.stringify({
  schema_version: 1,
  featured: [
    {
      hotkey: "5Gjr7VuYJC8D58d9S2iZofu7FzFvRiRjpM4zpAaDdqb1Wy6V",
      featured_at: "2026-07-16T16:33:28Z",
      relationship: "partner",
    },
  ],
});

describe("featured-validators registry (#11080)", () => {
  test("the generated set mirrors the committed registry exactly", () => {
    // The original defect was a set that was always empty WHILE THE REGISTRY
    // SAID OTHERWISE. The non-vacuity of the parser is pinned on the two-entry
    // fixture below; this holds the emitted module to the committed file --
    // whatever its current size, including zero arrangements, which is a real
    // state: no arrangement means no badge anywhere.
    const committed = featuredHotkeysFrom(
      readFileSync(
        path.join(repoRoot, "registry/featured-validators.json"),
        "utf8",
      ),
    );
    assert.deepEqual([...FEATURED_HOTKEYS], committed);
    assert.equal(FEATURED_HOTKEY_SET.size, FEATURED_HOTKEYS.length);
  });

  test("the parser is not vacuous: the fixture yields its entry", () => {
    assert.equal(featuredHotkeysFrom(VALID).length, 1);
  });

  test("hotkeys are sorted, so the emit is stable", () => {
    assert.deepEqual([...FEATURED_HOTKEYS], [...FEATURED_HOTKEYS].sort());
  });

  test("a duplicate hotkey is rejected rather than silently deduped", () => {
    // The Set the worker builds would swallow it, leaving two registry entries
    // for one relationship and no way to tell which is current.
    const dupe = JSON.stringify({
      schema_version: 1,
      featured: [
        {
          hotkey: "5A",
          featured_at: "2026-07-16T16:33:28Z",
          relationship: "partner",
        },
        {
          hotkey: "5A",
          featured_at: "2026-08-01T00:00:00Z",
          relationship: "sponsor",
        },
      ],
    });
    assert.throws(() => featuredHotkeysFrom(dupe), /duplicate hotkey/);
  });

  test("an unknown field is rejected", () => {
    const extra = JSON.stringify({
      schema_version: 1,
      featured: [
        {
          hotkey: "5A",
          featured_at: "2026-07-16T16:33:28Z",
          relationship: "partner",
          note: "handshake deal",
        },
      ],
    });
    assert.throws(() => featuredHotkeysFrom(extra));
  });

  test("an unknown relationship is rejected", () => {
    const bad = JSON.stringify({
      schema_version: 1,
      featured: [
        {
          hotkey: "5A",
          featured_at: "2026-07-16T16:33:28Z",
          relationship: "friend",
        },
      ],
    });
    assert.throws(() => featuredHotkeysFrom(bad));
  });

  test("featured_at must be a real instant", () => {
    const bad = JSON.stringify({
      schema_version: 1,
      featured: [
        {
          hotkey: "5A",
          featured_at: "sometime in July",
          relationship: "partner",
        },
      ],
    });
    assert.throws(() => featuredHotkeysFrom(bad));
  });

  test("the committed registry file parses against its schema", () => {
    const raw = FeaturedValidatorsFileSchema.parse(JSON.parse(VALID));
    assert.equal(raw.featured[0]?.relationship, "partner");
  });

  test("render is deterministic", () => {
    const hotkeys = featuredHotkeysFrom(VALID);
    assert.equal(render(hotkeys), render(hotkeys));
  });
});

describe("the badge actually flips (#11080)", () => {
  const row = (hotkey: string): Row => ({
    hotkey,
    uid: 1,
    netuid: 7,
    stake_tao: 1,
    validator_permit: true,
  });

  test("a featured hotkey is marked, an unfeatured one is not", () => {
    // A local set, not the generated one: the marking logic is what is under
    // test, and the committed registry may legitimately hold zero
    // arrangements.
    const featured = "5FixtureFeaturedHotkey00000000000000000000000000";
    const out = buildSubnetValidators(
      [row(featured), row("5NotFeaturedAtAll")],
      7,
      { featuredHotkeys: new Set([featured]) },
    );
    const validators = out.validators as Row[];
    const byKey = new Map(validators.map((v) => [v.hotkey, v.featured]));
    assert.equal(byKey.get(featured), true, "a partner must be badged");
    assert.equal(byKey.get("5NotFeaturedAtAll"), false);
  });

  test("the field is still present when nothing is featured", () => {
    // The reason the empty Set existed: the frontend badge needs the field even
    // when the list is empty, so absent-vs-false never reaches a consumer.
    const out = buildSubnetValidators([row("5Anyone")], 7, {
      featuredHotkeys: new Set<string>(),
    });
    const first = (out.validators as Row[])[0];
    assert.ok(first && "featured" in first);
    assert.equal(first.featured, false);
  });
});

describe("the burn flag on metagraph rows (#11094)", () => {
  const mgRow = (over: Row = {}): Row => ({
    uid: 0,
    hotkey: "5HotA",
    coldkey: "5ColdA",
    validator_permit: false,
    incentive: 0.1,
    ...over,
  });

  test("the owner-hotkey UID is flagged when a burn hotkey resolves", () => {
    const out = buildSubnetMetagraph(
      [mgRow({ uid: 162, hotkey: "5OwnerHot" }), mgRow({ uid: 1 })],
      13,
      { burnHotkey: "5OwnerHot" },
    );
    const byUid = new Map(
      (out.neurons as Row[]).map((n) => [n.uid, n.is_burn_uid]),
    );
    assert.equal(byUid.get(162), true);
    assert.equal(byUid.get(1), false);
  });

  test("without the resolution the key is absent, keeping older shapes intact", () => {
    const out = buildSubnetMetagraph([mgRow()], 13, {});
    assert.ok(!("is_burn_uid" in (out.neurons as Row[])[0]));
  });
});
