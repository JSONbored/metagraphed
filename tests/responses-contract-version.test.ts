import assert from "node:assert/strict";
import { test } from "vitest";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import {
  contractStaleness,
  contractVersion,
  dataResponse,
} from "../workers/responses.ts";
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

test("dataResponse sends the contract version as a HEADER, not only in meta", async () => {
  // access-control-expose-headers advertises x-metagraph-contract-version on
  // every response, so a client is told to read it. envelopeResponse set it;
  // dataResponse put the value in the body and nothing in the headers, so the
  // ten routes built on it (semantic search, the ask/RPC proxies, the webhook
  // subscription CRUD) advertised a header they never sent. Caught against
  // production by the live smoke, not by a unit test -- hence this one.
  const env = mockEnv({ METAGRAPH_CONTRACT_VERSION: "2099-01-01.1" });
  const res = dataResponse(env, { hello: "world" });
  assert.equal(res.headers.get("x-metagraph-contract-version"), "2099-01-01.1");
  const body = (await res.json()) as { meta: { contract_version: string } };
  assert.equal(
    body.meta.contract_version,
    "2099-01-01.1",
    "the body value must still agree with the header",
  );
});

test("dataResponse stays no-store, and therefore carries no ETag", () => {
  // These responses are per-request. A validator for something no cache may
  // store validates nothing, and the live smoke asserts an ETag only where the
  // response is actually cacheable.
  const res = dataResponse(mockEnv(), { hello: "world" });
  assert.match(res.headers.get("cache-control") || "", /no-store/);
  assert.equal(res.headers.get("etag"), null);
});
