// Published install instructions must select bounded discovery while keeping
// every capability and the explicit common/full catalog alternatives available.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import type { Row } from "./row-type.ts";

const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const DISCOVERY = "https://api.metagraph.sh/mcp";
const FULL = `${DISCOVERY}?catalog=full`;

/** The install line an agent copies, wherever it is published. */
const INSTALL = /claude mcp add --transport http metagraphed (\S+)/g;

describe("every published install snippet names the discovery profile", () => {
  for (const file of [
    "public/llms.txt",
    "public/agent.md",
    "public/skills/bittensor/SKILL.md",
  ]) {
    test(file, () => {
      const urls = [...read(file).matchAll(INSTALL)].map((m) => m[1]);
      assert.ok(urls.length > 0, `no install snippet found in ${file}`);
      for (const url of urls) {
        // Trailing punctuation/backticks are stripped by the capture already;
        // compare on the URL itself.
        assert.equal(
          url.replace(/[`.,]+$/, ""),
          DISCOVERY,
          `${file} must recommend bounded discovery`,
        );
      }
    });
  }
});

describe("the MCP Registry listing", () => {
  const manifest = JSON.parse(read("server.json")) as Row;

  test("connects a first-time installer to discovery", () => {
    assert.equal((manifest.remotes as Row[])[0]!.url, DISCOVERY);
  });

  test("still declares streamable-http", () => {
    assert.equal((manifest.remotes as Row[])[0]!.type, "streamable-http");
  });
});

describe("the full endpoint stays reachable and documented", () => {
  // Clients that require eager discovery can still choose the full catalog.
  test("llms.txt still names it", () => {
    assert.ok(read("public/llms.txt").includes(FULL));
  });

  test("agent.md and SKILL.md say what the trade is", () => {
    for (const file of [
      "public/agent.md",
      "public/skills/bittensor/SKILL.md",
    ]) {
      const text = read(file);
      assert.ok(
        text.includes("/mcp?catalog=full"),
        `${file} must name the full catalog`,
      );
      assert.ok(
        text.includes("/mcp/core"),
        `${file} must name the common-tool profile`,
      );
      // Normalised before matching, because two things about these files are
      // formatting rather than meaning: they are hand-wrapped (so the
      // sentence straddles a newline in agent.md and not in SKILL.md), and
      // prettier rewrites `*listing*` to `_listing_`. Pinning either would
      // make this test fail on a reflow that changed nothing it cares about.
      const normalised = text.replace(/\s+/g, " ").replace(/[*_]/g, "");
      assert.match(
        normalised,
        /filters (the tool )?listing, never dispatch/,
        `${file} must preserve access to every tool`,
      );
    }
  });
});
