import assert from "node:assert/strict";
import { test } from "vitest";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import { contractStaleness, contractVersion } from "../workers/responses.ts";
import { mockEnv } from "./row-type.ts";

test("contractVersion returns env override when METAGRAPH_CONTRACT_VERSION is set", () => {
  assert.equal(
    contractVersion(mockEnv({ METAGRAPH_CONTRACT_VERSION: "2099-01-01.1" })),
    "2099-01-01.1",
  );
});

test("contractVersion falls back to CONTRACT_VERSION when env override is absent", () => {
  assert.equal(contractVersion(mockEnv()), CONTRACT_VERSION);
  assert.equal(
    contractVersion(mockEnv({ METAGRAPH_CONTRACT_VERSION: undefined })),
    CONTRACT_VERSION,
  );
  assert.equal(
    contractVersion(mockEnv({ METAGRAPH_CONTRACT_VERSION: "" })),
    CONTRACT_VERSION,
  );
});

test("contractStaleness returns null when builtUnderVersion is falsy", () => {
  const env = mockEnv({ METAGRAPH_CONTRACT_VERSION: "2026-06-07.1" });
  assert.equal(contractStaleness(env, null), null);
  assert.equal(contractStaleness(env, undefined), null);
  assert.equal(contractStaleness(env, ""), null);
});

test("contractStaleness flags artifacts built under an older contract date", () => {
  const env = mockEnv({ METAGRAPH_CONTRACT_VERSION: "2026-06-07.1" });
  assert.deepEqual(contractStaleness(env, "2026-06-06.9"), {
    built_under: "2026-06-06.9",
    live: "2026-06-07.1",
  });
});

test("contractStaleness returns null when builtUnder matches or exceeds live", () => {
  const live = (v: string) => mockEnv({ METAGRAPH_CONTRACT_VERSION: v });
  assert.equal(contractStaleness(live("2026-06-06.1"), "2026-06-06.1"), null);
  assert.equal(contractStaleness(live("2026-06-06.1"), "2026-06-07.1"), null);
  assert.equal(contractStaleness(live("2026-06-06.10"), "2026-06-06.11"), null);
});

test("contractStaleness compares revisions numerically on the same date", () => {
  const env = mockEnv({ METAGRAPH_CONTRACT_VERSION: "2026-06-06.10" });
  assert.deepEqual(contractStaleness(env, "2026-06-06.2"), {
    built_under: "2026-06-06.2",
    live: "2026-06-06.10",
  });
  assert.equal(contractStaleness(env, "2026-06-06.11"), null);
});

test("contractStaleness uses CONTRACT_VERSION when env override is unset", () => {
  assert.deepEqual(contractStaleness(mockEnv(), "2020-01-01.1"), {
    built_under: "2020-01-01.1",
    live: CONTRACT_VERSION,
  });
});
