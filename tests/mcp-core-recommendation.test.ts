// #11164: the core profile has to be the one an agent is TOLD to install.
//
// `/mcp/core` has existed and been served for a while, and it appeared in
// exactly one published artifact -- `core_endpoint` on the server card.
// llms.txt, agent.md, SKILL.md and the MCP Registry listing all pointed at
// `/mcp`, so every reader was handed the 243-tool endpoint.
//
// Measured against production 2026-08-22: /mcp lists 243 tools at ~396,000
// tokens, /mcp/core lists 23 at ~44,500. Most clients hold tool definitions in
// model context, so the difference is nine tenths of a large context window
// spent before the caller asks anything. Anthropic's connector-directory
// criteria require a server to be "frugal with their use of tokens".
//
// This is not a reduced install, and that is the load-bearing fact: the
// profile filters `tools/list` and NEVER dispatch. A core session can
// `tools/call` all 243.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import type { Row } from "./row-type.ts";

const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const CORE = "https://api.metagraph.sh/mcp/core";
const FULL = "https://api.metagraph.sh/mcp";

/** The install line an agent copies, wherever it is published. */
const INSTALL = /claude mcp add --transport http metagraphed (\S+)/g;

describe("every published install snippet names the core profile", () => {
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
          CORE,
          `${file} tells the reader to install the 243-tool endpoint`,
        );
      }
    });
  }
});

describe("the MCP Registry listing", () => {
  const manifest = JSON.parse(read("server.json")) as Row;

  test("connects a first-time installer to core", () => {
    assert.equal((manifest.remotes as Row[])[0]!.url, CORE);
  });

  test("still declares streamable-http", () => {
    assert.equal((manifest.remotes as Row[])[0]!.type, "streamable-http");
  });
});

describe("the full endpoint stays reachable and documented", () => {
  // Recommending core must never read as removing /mcp. A reader who wants
  // every tool enumerated has to be able to find out how.
  test("llms.txt still names it", () => {
    assert.ok(read("public/llms.txt").includes(FULL));
  });

  test("agent.md and SKILL.md say what the trade is", () => {
    for (const file of [
      "public/agent.md",
      "public/skills/bittensor/SKILL.md",
    ]) {
      const text = read(file);
      assert.ok(text.includes(FULL), `${file} must still name ${FULL}`);
      // Normalised before matching, because two things about these files are
      // formatting rather than meaning: they are hand-wrapped (so the
      // sentence straddles a newline in agent.md and not in SKILL.md), and
      // prettier rewrites `*listing*` to `_listing_`. Pinning either would
      // make this test fail on a reflow that changed nothing it cares about.
      const normalised = text.replace(/\s+/g, " ").replace(/[*_]/g, "");
      assert.match(
        normalised,
        /filters (the tool )?listing, never dispatch/,
        `${file} must state that core can still call every tool`,
      );
    }
  });
});
