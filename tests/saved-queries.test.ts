import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
// Side-effect only: workers/api.mjs calls configureAnalyticsRoutes() at load
// time, which composeLeaderboardsData (used by the subnet-leaderboard
// template) requires before it can run.
import "../workers/api.mjs";
import {
  SAVED_QUERY_TEMPLATES,
  SAVED_QUERY_HANDLERS,
  assertSavedQueryRegistryIntegrity,
  findSavedQueryTemplate,
  runSavedQuery,
  savedQueryError,
} from "../src/saved-queries.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

type TemplateT = (typeof SAVED_QUERY_TEMPLATES)[number];
type HandlerT = (typeof SAVED_QUERY_HANDLERS)[string];

const SCHEMA = JSON.parse(
  readFileSync(
    new URL("../schemas/saved-query.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateTemplate = new Ajv2020({ strict: false }).compile(SCHEMA);

describe("saved-queries", () => {
  test("savedQueryError is shaped for MCP toolError handling", () => {
    const err = savedQueryError("not_found", "missing");
    assert.equal(err.code, "not_found");
    assert.equal(err.toolError, true);
    assert.equal(err.message, "missing");
  });

  test("every template validates against schemas/saved-query.schema.json", () => {
    for (const template of SAVED_QUERY_TEMPLATES) {
      assert.ok(
        validateTemplate(template),
        `${template.id}: ${JSON.stringify(validateTemplate.errors)}`,
      );
    }
  });

  test("every template has exactly one matching handler", () => {
    const templateIds = SAVED_QUERY_TEMPLATES.map((t) => t.id).sort();
    const handlerIds = Object.keys(SAVED_QUERY_HANDLERS).sort();
    assert.deepEqual(templateIds, handlerIds);
  });

  test("template ids are unique", () => {
    const ids = SAVED_QUERY_TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("findSavedQueryTemplate looks up by id", () => {
    assert.equal(
      findSavedQueryTemplate("subnet-leaderboard")?.id,
      "subnet-leaderboard",
    );
    assert.equal(findSavedQueryTemplate("no-such-template"), undefined);
  });

  test("runSavedQuery rejects an unknown query_id", async () => {
    await assert.rejects(
      () => runSavedQuery(mockEnv(), "no-such-template", {}),
      (err: Row) =>
        err.code === "not_found" &&
        err.toolError === true &&
        /no-such-template/.test(err.message),
    );
  });

  test("runSavedQuery rejects an unknown param", async () => {
    await assert.rejects(
      () =>
        runSavedQuery(mockEnv(), "subnet-leaderboard", {
          not_a_real_param: "x",
        }),
      (err: Row) =>
        err.code === "invalid_params" && /not_a_real_param/.test(err.message),
    );
  });

  test("runSavedQuery rejects a bad enum value", async () => {
    await assert.rejects(
      () =>
        runSavedQuery(mockEnv(), "subnet-leaderboard", {
          board: "not-a-board",
        }),
      (err: Row) =>
        err.code === "invalid_params" && /must be one of/.test(err.message),
    );
  });

  test("runSavedQuery rejects a non-integer limit", async () => {
    await assert.rejects(
      () =>
        runSavedQuery(mockEnv(), "subnet-leaderboard", {
          limit: "not-a-number",
        }),
      (err: Row) =>
        err.code === "invalid_params" && /must be an integer/.test(err.message),
    );
  });

  test("runSavedQuery rejects an over-maximum limit", async () => {
    await assert.rejects(
      () => runSavedQuery(mockEnv(), "subnet-leaderboard", { limit: "500" }),
      (err: Row) =>
        err.code === "invalid_params" && /must be <= 100/.test(err.message),
    );
  });

  test("runSavedQuery rejects an under-minimum limit", async () => {
    await assert.rejects(
      () => runSavedQuery(mockEnv(), "subnet-leaderboard", { limit: "0" }),
      (err: Row) =>
        err.code === "invalid_params" && /must be >= 1/.test(err.message),
    );
  });

  test("assertSavedQueryRegistryIntegrity accepts a matched registry", () => {
    assert.doesNotThrow(() =>
      assertSavedQueryRegistryIntegrity(
        [{ id: "a" }, { id: "b" }] as unknown as TemplateT[],
        {
          a: (() => {}) as unknown as HandlerT,
          b: (() => {}) as unknown as HandlerT,
        },
      ),
    );
  });

  test("assertSavedQueryRegistryIntegrity throws on a template with no handler", () => {
    assert.throws(
      () =>
        assertSavedQueryRegistryIntegrity(
          [{ id: "a" }] as unknown as TemplateT[],
          {},
        ),
      /have drifted/,
    );
  });

  test("assertSavedQueryRegistryIntegrity throws on a handler with no template", () => {
    assert.throws(
      () =>
        assertSavedQueryRegistryIntegrity([], {
          a: (() => {}) as unknown as HandlerT,
        }),
      /have drifted/,
    );
  });

  test("assertSavedQueryRegistryIntegrity throws on a duplicate template id", () => {
    assert.throws(
      () =>
        assertSavedQueryRegistryIntegrity(
          [{ id: "a" }, { id: "a" }] as unknown as TemplateT[],
          {
            a: (() => {}) as unknown as HandlerT,
          },
        ),
      /have drifted/,
    );
  });

  test('an unknown param on a no-param template reports "(none)"', async () => {
    const template = {
      id: "__test_no_params__",
      name: "test",
      description: "test",
      category: "chain-activity",
      params: [],
    };
    SAVED_QUERY_TEMPLATES.push(template as unknown as TemplateT);
    SAVED_QUERY_HANDLERS[template.id] = async () => ({});
    try {
      await assert.rejects(
        () => runSavedQuery(mockEnv(), template.id, { extra: "x" }),
        (err: Row) =>
          err.code === "invalid_params" && /\(none\)/.test(err.message),
      );
    } finally {
      SAVED_QUERY_TEMPLATES.pop();
      delete SAVED_QUERY_HANDLERS[template.id];
    }
  });

  test("the real registry is self-consistent", () => {
    assert.doesNotThrow(() =>
      assertSavedQueryRegistryIntegrity(
        SAVED_QUERY_TEMPLATES,
        SAVED_QUERY_HANDLERS,
      ),
    );
  });

  test("an optional param with no explicit default falls back to null", async () => {
    // chain-registrations-window's own params both declare a default, so
    // exercise the null-fallback branch (board on subnet-leaderboard has no
    // declared default) via an explicitly-blank value.
    const result = (await runSavedQuery(mockEnv(), "subnet-leaderboard", {
      board: "",
    })) as Row;
    assert.equal(result.params.board, null);
  });

  test("runSavedQuery rejects a missing required param", async () => {
    // None of the shipped templates declare a required param today -- register
    // a synthetic one to exercise coerceAndValidateParams' required branch.
    const template = {
      id: "__test_required_param__",
      name: "test",
      description: "test",
      category: "chain-activity",
      params: [{ name: "netuid", type: "integer", required: true }],
    };
    SAVED_QUERY_TEMPLATES.push(template as unknown as TemplateT);
    SAVED_QUERY_HANDLERS[template.id] = async (_env, params) => params;
    try {
      await assert.rejects(
        () => runSavedQuery(mockEnv(), template.id, {}),
        (err: Row) =>
          err.code === "invalid_params" &&
          /requires param "netuid"/.test(err.message),
      );
      const result = await runSavedQuery(mockEnv(), template.id, { netuid: 7 });
      assert.deepEqual(result.params, { netuid: 7 });
    } finally {
      SAVED_QUERY_TEMPLATES.pop();
      delete SAVED_QUERY_HANDLERS[template.id];
    }
  });

  test("subnet-leaderboard applies defaults and coerces string params", async () => {
    const env = mockEnv();
    const calls: Row[] = [];
    const original = SAVED_QUERY_HANDLERS["subnet-leaderboard"];
    SAVED_QUERY_HANDLERS["subnet-leaderboard"] = async (e, params) => {
      calls.push(params);
      return { boards: {} };
    };
    try {
      const result = await runSavedQuery(env, "subnet-leaderboard", {
        board: "highest-emission",
        limit: "5",
      });
      assert.deepEqual(calls[0], { board: "highest-emission", limit: 5 });
      assert.equal(result.query_id, "subnet-leaderboard");
      assert.deepEqual(result.params, { board: "highest-emission", limit: 5 });
      assert.deepEqual(result.data, { boards: {} });
    } finally {
      SAVED_QUERY_HANDLERS["subnet-leaderboard"] = original;
    }
  });

  test("subnet-leaderboard omits board and limit to their defaults", async () => {
    const result = (await runSavedQuery(
      mockEnv(),
      "subnet-leaderboard",
      {},
    )) as Row;
    assert.equal(result.params.board, null);
    assert.equal(result.params.limit, 20);
  });

  test("chain-registrations-window falls back to buildChainRegistrations cold", async () => {
    const result = (await runSavedQuery(
      mockEnv(),
      "chain-registrations-window",
      {
        window: "30d",
        limit: 10,
      },
    )) as Row;
    assert.equal(result.query_id, "chain-registrations-window");
    assert.equal(result.params.window, "30d");
    assert.equal(result.params.limit, 10);
    assert.equal(result.data.schema_version, 1);
    assert.equal(result.data.window, "30d");
    assert.deepEqual(result.data.subnets, []);
  });

  test("chain-registrations-window defaults window and limit", async () => {
    const result = (await runSavedQuery(
      mockEnv(),
      "chain-registrations-window",
      {},
    )) as Row;
    assert.equal(result.params.window, "7d");
    assert.equal(result.params.limit, 20);
  });
});
