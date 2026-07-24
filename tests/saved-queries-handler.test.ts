// Handler tests for GET /api/v1/queries/{id} (#6755/#6757).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleSavedQueryRequest,
  SAVED_QUERIES_PATH_PREFIX,
} from "../workers/request-handlers/saved-queries.ts";
import { handleRequest } from "../workers/api.ts";
import { SAVED_QUERY_HANDLERS } from "../src/saved-queries.ts";
import { mockEnv, type Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

async function json(res: Response, expectedStatus = 200): Promise<Row> {
  assert.equal(
    res.status,
    expectedStatus,
    `expected ${expectedStatus}, got ${res.status}`,
  );
  return res.json();
}

describe("handleSavedQueryRequest", () => {
  test("SAVED_QUERIES_PATH_PREFIX matches the documented route", () => {
    assert.equal(SAVED_QUERIES_PATH_PREFIX, "/api/v1/queries/");
  });

  test("runs a known template and returns the envelope", async () => {
    const body = await json(
      await handleSavedQueryRequest(
        req(
          "/api/v1/queries/subnet-leaderboard?board=highest-emission&limit=5",
        ),
        mockEnv(),
        new URL(
          "https://api.metagraph.sh/api/v1/queries/subnet-leaderboard?board=highest-emission&limit=5",
        ),
      ),
    );
    assert.equal(body.ok, true);
    assert.equal(body.data.query_id, "subnet-leaderboard");
    assert.deepEqual(body.data.params, { board: "highest-emission", limit: 5 });
    assert.equal(body.meta.contract_version.length > 0, true);
  });

  test("404s on an unknown query id", async () => {
    const body = await json(
      await handleSavedQueryRequest(
        req("/api/v1/queries/not-a-real-template"),
        mockEnv(),
        new URL("https://api.metagraph.sh/api/v1/queries/not-a-real-template"),
      ),
      404,
    );
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "not_found");
  });

  test("404s with no query id segment", async () => {
    const body = await json(
      await handleSavedQueryRequest(
        req("/api/v1/queries/"),
        mockEnv(),
        new URL("https://api.metagraph.sh/api/v1/queries/"),
      ),
      404,
    );
    assert.equal(body.error.code, "not_found");
  });

  test("400s on an invalid param", async () => {
    const body = await json(
      await handleSavedQueryRequest(
        req("/api/v1/queries/subnet-leaderboard?board=not-a-board"),
        mockEnv(),
        new URL(
          "https://api.metagraph.sh/api/v1/queries/subnet-leaderboard?board=not-a-board",
        ),
      ),
      400,
    );
    assert.equal(body.error.code, "invalid_params");
  });

  test("rejects non-GET/HEAD methods", async () => {
    const res = await handleSavedQueryRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/queries/subnet-leaderboard",
        {
          method: "POST",
        },
      ),
      mockEnv(),
      new URL("https://api.metagraph.sh/api/v1/queries/subnet-leaderboard"),
    );
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  });

  test("rethrows an unexpected (non-toolError) failure", async () => {
    const original = SAVED_QUERY_HANDLERS["subnet-leaderboard"];
    SAVED_QUERY_HANDLERS["subnet-leaderboard"] = async () => {
      throw new Error("boom");
    };
    try {
      await assert.rejects(
        () =>
          handleSavedQueryRequest(
            req("/api/v1/queries/subnet-leaderboard"),
            mockEnv(),
            new URL(
              "https://api.metagraph.sh/api/v1/queries/subnet-leaderboard",
            ),
          ),
        /boom/,
      );
    } finally {
      SAVED_QUERY_HANDLERS["subnet-leaderboard"] = original;
    }
  });

  test("full router dispatch reaches the saved-query handler", async () => {
    const body = await json(
      await handleRequest(
        req("/api/v1/queries/chain-registrations-window?window=30d"),
        {} as unknown as Env,
        {},
      ),
    );
    assert.equal(body.data.query_id, "chain-registrations-window");
    assert.equal(body.data.params.window, "30d");
  });
});
