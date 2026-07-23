import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const PUB = "2026-06-11T12:00:00.000Z";

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
  test("overlays the real publish time onto the body's generated_at + a header", async () => {
    const { res, body } = await rawSubnets(envWithPointer());
    assert.equal(res.headers.get("x-metagraph-published-at"), PUB);
    // The body's generated_at is served LIVE as the real publish time (serve-time
    // overlay) so a raw fetcher sees the true date, not the baked epoch marker
    // (the artifact on disk stays the deterministic epoch — issue #349).
    assert.equal(body.generated_at, PUB);
  });

  test("omits the header when there is no latest pointer", async () => {
    const { res, body } = await rawSubnets(createLocalArtifactEnv());
    assert.equal(res.headers.get("x-metagraph-published-at"), null);
    // body unchanged (not overlaid), timestamp-value-agnostic
    assert.notEqual(body.generated_at, PUB);
  });
});
