// #8703: the feed system must not be able to ship undocumented again.
//
// src/feeds.ts (#741) served SIX live feed families for a year with zero
// contract entries, zero OpenAPI paths, and zero autodiscovery tags. Nothing
// detected it, because nothing compared what the router serves against what the
// contract advertises. This file is that comparison.
//
// The expected set is DERIVED from src/feeds.ts' own FEED_TARGET_KINDS -- the
// same constant parseFeedPath dispatches on -- rather than restated here. A
// hand-written list would have to be updated twice to add a feed, and the
// second update is exactly the one that historically never happened.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FEED_PATH_SEGMENTS,
  FEED_TARGET_KINDS,
  parseFeedPath,
  WATCH_MAX_IDS,
} from "../src/feeds.ts";
import {
  buildContractsArtifact,
  FEED_CONTENT_TYPES_BY_FORMAT,
  FEED_ROUTES,
} from "../src/contracts.ts";

describe("feed routes are fully contracted (#8703)", () => {
  test("every kind the router serves has a contract entry", () => {
    const contracted = new Set(FEED_ROUTES.map((entry) => entry.kind));
    const missing = FEED_TARGET_KINDS.filter((kind) => !contracted.has(kind));
    assert.deepEqual(
      missing,
      [],
      `feed kind(s) with no FEED_ROUTES entry in src/contracts.ts: ${missing.join(", ")}`,
    );
  });

  test("no contract entry describes a feed the router cannot serve", () => {
    // The other direction: a stale entry advertising a removed feed is a
    // documented 404, which is worse than an undocumented 200.
    const served = new Set<string>(FEED_TARGET_KINDS);
    for (const entry of FEED_ROUTES) {
      assert.ok(
        served.has(entry.kind),
        `FEED_ROUTES advertises "${entry.kind}", which parseFeedPath does not serve`,
      );
    }
  });

  test("each contract path actually resolves to the kind it claims", () => {
    // Matching on `kind` rather than on the path string is what makes a path
    // rename safe: rename the path and this fails until the router agrees.
    for (const entry of FEED_ROUTES) {
      const concrete = entry.path.replace("{netuid}", "7");
      const target = parseFeedPath(concrete);
      assert.ok(target, `${entry.path} does not parse as a feed path`);
      assert.equal(
        target.kind,
        entry.kind,
        `${entry.path} resolves to "${target.kind}", contracted as "${entry.kind}"`,
      );
    }
  });

  test("every declared format suffix resolves to the same kind", () => {
    for (const entry of FEED_ROUTES) {
      const concrete = entry.path.replace("{netuid}", "7");
      for (const format of entry.formats) {
        const target = parseFeedPath(`${concrete}.${format}`);
        assert.equal(
          target?.kind,
          entry.kind,
          `${concrete}.${format} did not resolve to ${entry.kind}`,
        );
      }
    }
  });

  test("the contract artifact exposes feeds with real media types", () => {
    const artifact = buildContractsArtifact("2026-07-30T00:00:00.000Z") as {
      feeds: {
        kind: string;
        path: string;
        content_types: string[];
        query_parameters: { name: string }[];
      }[];
    };
    assert.equal(artifact.feeds.length, FEED_ROUTES.length);
    for (const feed of artifact.feeds) {
      // An agent reading get_contracts must learn it will receive XML, not the
      // success envelope every `routes` entry returns.
      assert.deepEqual(
        [...feed.content_types].sort(),
        [
          "application/atom+xml",
          "application/feed+json",
          "application/rss+xml",
        ],
        `${feed.path} advertises the wrong media types`,
      );
      // The window/tag filters are part of the contract, not folklore.
      const names = feed.query_parameters.map((parameter) => parameter.name);
      for (const expected of ["tag", "since", "until", "limit"]) {
        assert.ok(
          names.includes(expected),
          `${feed.path} does not document ?${expected}`,
        );
      }
    }
  });

  test("the watch feed documents its ids parameter, with the real cap", () => {
    const watch = FEED_ROUTES.find((entry) => entry.kind === "watch");
    const ids = watch?.query_parameters.find(
      (parameter) => parameter.name === "ids",
    );
    assert.ok(ids, "the watch feed is useless without ?ids");
    // The cap is a number the prose has to restate, so assert it against the
    // constant the router actually enforces. This caught the contract claiming
    // 20 while parseWatchIds 413s at 50.
    assert.match(
      String(ids.description),
      new RegExp(`\\b${WATCH_MAX_IDS}\\b`),
      `the ids description does not state the real ${WATCH_MAX_IDS}-id cap`,
    );
  });

  test("the subnet feed documents its netuid path parameter", () => {
    const subnet = FEED_ROUTES.find((entry) => entry.kind === "subnet");
    assert.deepEqual(
      subnet?.path_parameters.map((parameter) => parameter.name),
      ["netuid"],
    );
  });

  test("format list matches the serializers the router actually has", () => {
    // FEED_CONTENT_TYPES_BY_FORMAT is the contract's copy; drifting from the
    // three real serializations would document a format nobody can request.
    for (const entry of FEED_ROUTES) {
      assert.deepEqual([...entry.formats].sort(), ["atom", "json", "rss"]);
      for (const format of entry.formats) {
        assert.ok(
          FEED_CONTENT_TYPES_BY_FORMAT[
            format as keyof typeof FEED_CONTENT_TYPES_BY_FORMAT
          ],
          `no media type mapped for format "${format}"`,
        );
      }
    }
  });

  test("unparameterized segments and kinds stay in sync", () => {
    // FEED_TARGET_KINDS is FEED_PATH_SEGMENTS plus the one parameterized kind;
    // if that relationship ever breaks, the derivation above silently narrows.
    assert.deepEqual([...FEED_TARGET_KINDS], [...FEED_PATH_SEGMENTS, "subnet"]);
  });
});
