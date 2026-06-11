import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const PUB = "2026-06-11T12:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";

function envWithPointer() {
  return createLocalArtifactEnv({
    METAGRAPH_CONTROL: {
      get: async (key) =>
        key === "metagraph:latest" ? { published_at: PUB } : null,
    },
  });
}

async function rawSubnets(env) {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/metagraph/subnets.json"),
    env,
    {},
  );
  return { res, body: JSON.parse(await res.text()) };
}

describe("raw artifact published_at header", () => {
  test("exposes the real publish time as a header without changing the body", async () => {
    const { res, body } = await rawSubnets(envWithPointer());
    assert.equal(res.headers.get("x-metagraph-published-at"), PUB);
    // The body stays byte-identical to the committed artifact: generated_at is
    // the deterministic epoch content marker by design, not overwritten.
    assert.equal(body.generated_at, EPOCH);
  });

  test("omits the header when there is no latest pointer", async () => {
    const { res, body } = await rawSubnets(createLocalArtifactEnv());
    assert.equal(res.headers.get("x-metagraph-published-at"), null);
    assert.equal(body.generated_at, EPOCH);
  });
});
