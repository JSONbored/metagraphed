import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { artifactContentHash, sha256Hex } from "../scripts/lib.mjs";

const buf = (obj) => Buffer.from(JSON.stringify(obj), "utf8");

describe("artifactContentHash (R2 delta-skip hash)", () => {
  test("ignores generated_at — same data + different build stamp ⇒ same hash", () => {
    const a = buf({
      generated_at: "2026-06-20T00:00:00.000Z",
      netuid: 7,
      x: 1,
    });
    const b = buf({
      generated_at: "2026-06-21T11:22:33.000Z",
      netuid: 7,
      x: 1,
    });
    assert.equal(
      artifactContentHash("subnets/7.json", a),
      artifactContentHash("subnets/7.json", b),
    );
  });

  test("ignores generated_at even when key order / whitespace differs", () => {
    const a = Buffer.from(
      '{"generated_at":"2026-06-20T00:00:00.000Z","x":1,"y":2}',
      "utf8",
    );
    const b = Buffer.from(
      '{\n  "y": 2,\n  "x": 1,\n  "generated_at": "2026-06-29T09:09:09.000Z"\n}',
      "utf8",
    );
    assert.equal(
      artifactContentHash("a.json", a),
      artifactContentHash("a.json", b),
    );
  });

  test("a real data change ⇒ different hash", () => {
    const a = buf({ generated_at: "2026-06-20T00:00:00.000Z", value: 1 });
    const b = buf({ generated_at: "2026-06-20T00:00:00.000Z", value: 2 });
    assert.notEqual(
      artifactContentHash("a.json", a),
      artifactContentHash("a.json", b),
    );
  });

  test("captured_at is NOT normalized — a re-snapshot ⇒ different hash (freshness preserved)", () => {
    const a = buf({
      generated_at: "x",
      captured_at: "2026-06-20T00:00:00.000Z",
    });
    const b = buf({
      generated_at: "x",
      captured_at: "2026-06-21T00:00:00.000Z",
    });
    assert.notEqual(
      artifactContentHash("economics.json", a),
      artifactContentHash("economics.json", b),
    );
  });

  test("nested generated_at is normalized too", () => {
    const a = buf({ meta: { generated_at: "2026-06-20T00:00:00.000Z" }, n: 1 });
    const b = buf({ meta: { generated_at: "2026-06-25T00:00:00.000Z" }, n: 1 });
    assert.equal(
      artifactContentHash("a.json", a),
      artifactContentHash("a.json", b),
    );
  });

  test("non-JSON artifacts hash their raw bytes (== integrity sha256)", () => {
    const svg = Buffer.from("<svg>badge</svg>", "utf8");
    assert.equal(artifactContentHash("badge.svg", svg), sha256Hex(svg));
  });

  test("unparseable .json falls back to the raw-byte hash", () => {
    const broken = Buffer.from("{not json", "utf8");
    assert.equal(artifactContentHash("a.json", broken), sha256Hex(broken));
  });
});
