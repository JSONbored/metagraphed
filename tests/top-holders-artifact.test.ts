// The artifact IS the final run of the live route SQL, so the property under
// test is fidelity: rows flow through the SAME buildTopHoldersList formatter
// with the caller's sort/limit, and anything that is not the expected
// artifact declines rather than being half-served.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadTopHoldersFromArtifact,
  TOP_HOLDERS_ARTIFACT_KEY,
} from "../src/top-holders-artifact.ts";

function row(ss58: string, free: number, delegated: number) {
  return {
    ss58,
    free_tao: String(free),
    delegated_tao: String(delegated),
    captured_at: "1785680000000",
  };
}

function bucketWith(body: unknown, opts: { missing?: boolean } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (opts.missing) return null;
          return { json: async () => body };
        },
      },
    } as unknown as Env,
  };
}

describe("loadTopHoldersFromArtifact", () => {
  test("serves the artifact through the shared formatter, sorted and sliced", async () => {
    const { env, gets } = bucketWith({
      schema_version: 1,
      rows: [row("5A", 10, 0), row("5B", 5, 100), row("5C", 50, 0)],
    });
    const data = await loadTopHoldersFromArtifact(env, {
      sort: "free_tao",
      limit: 2,
    });
    assert.equal(gets[0], TOP_HOLDERS_ARTIFACT_KEY);
    assert.equal(data!.sort, "free_tao");
    const accounts = data!.accounts as { ss58: string }[];
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0]!.ss58, "5C");
    assert.equal(accounts[1]!.ss58, "5A");
  });

  test("a different sort reorders the same rows — the formatter owns sorting", async () => {
    const { env } = bucketWith({
      schema_version: 1,
      rows: [row("5A", 10, 0), row("5B", 5, 100)],
    });
    const data = await loadTopHoldersFromArtifact(env, {
      sort: "delegated_tao",
      limit: 5,
    });
    assert.equal((data!.accounts as { ss58: string }[])[0]!.ss58, "5B");
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadTopHoldersFromArtifact({} as never, { sort: "total_tao" }),
      null,
    );
    assert.equal(
      await loadTopHoldersFromArtifact(null, { sort: "total_tao" }),
      null,
    );
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(
      await loadTopHoldersFromArtifact(env, { sort: "total_tao" }),
      null,
    );
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, rows: [] },
      { schema_version: 1, rows: "not-an-array" },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadTopHoldersFromArtifact(env, { sort: "total_tao" }),
        null,
        JSON.stringify(body),
      );
    }
  });

  test("a throwing store declines instead of failing the request", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("r2 down");
        },
      },
    } as unknown as Env;
    assert.equal(
      await loadTopHoldersFromArtifact(env, { sort: "total_tao" }),
      null,
    );
  });
});
