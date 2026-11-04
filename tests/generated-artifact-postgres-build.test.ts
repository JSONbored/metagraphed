import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readGeneratedArtifactPostgres } from "../scripts/generated-artifact-postgres.ts";
import { readGeneratedStoreJson } from "../scripts/r2-rest.ts";

const mock = vi.hoisted(() => ({
  factory: vi.fn(),
  first: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../src/pg-store-runtime.ts", () => ({
  createPgStoreRuntime: mock.factory,
}));

beforeEach(() => {
  mock.first.mockReset().mockResolvedValue({ payload: '{"value":1}' });
  mock.close.mockReset().mockResolvedValue(undefined);
  mock.factory
    .mockReset()
    .mockImplementation(() => ({
      producer: { first: mock.first },
      close: mock.close,
    }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a build bounds and closes its PostgreSQL read", async () => {
  assert.deepEqual(
    await readGeneratedArtifactPostgres(
      "key",
      "postgresql://fixture.invalid/db",
      1000,
    ),
    { value: 1 },
  );
  const options = mock.factory.mock.calls[0][0];
  assert.equal(options.maxConnections, 1);
  assert.equal(options.connectionTimeoutMillis, 500);
  assert.equal(options.statementTimeoutMillis, 500);
  options.onIdleError(new Error("synthetic idle error"));
  assert.equal(mock.close.mock.calls.length, 1);
  mock.first.mockRejectedValueOnce(new Error("query failed"));
  assert.equal(
    await readGeneratedArtifactPostgres(
      "key",
      "postgresql://fixture.invalid/db",
      1000,
    ),
    null,
  );
  assert.equal(mock.close.mock.calls.length, 2);
  mock.close.mockRejectedValueOnce(new Error("close failed"));
  await assert.rejects(
    readGeneratedArtifactPostgres(
      "key",
      "postgresql://fixture.invalid/db",
      1000,
    ),
    /close failed/,
  );
  for (const timeout of [0, 1, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(
      readGeneratedArtifactPostgres(
        "key",
        "postgresql://fixture.invalid/db",
        timeout,
      ),
      /budget/,
    );
  }
});

test("native build selection uses the same key without falling back to Cloudflare", async () => {
  vi.stubEnv(
    "METAGRAPH_GENERATED_ARTIFACT_DATABASE_URL",
    "postgresql://fixture.invalid/db",
  );
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-token");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  assert.deepEqual(await readGeneratedStoreJson("generated/link-status.json"), {
    value: 1,
  });
  assert.deepEqual(mock.first.mock.calls[0][1], ["generated/link-status.json"]);
  for (const payload of ["[]", "null", "{", "1"]) {
    mock.first.mockResolvedValueOnce({ payload });
    assert.equal(await readGeneratedStoreJson("key"), null);
  }
  mock.factory.mockImplementationOnce(() => {
    throw new Error("invalid configuration");
  });
  assert.equal(await readGeneratedStoreJson("key"), null);
  assert.equal(fetchMock.mock.calls.length, 0);
});
