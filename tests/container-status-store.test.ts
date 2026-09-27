import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  readContainerStatuses,
  parseContainerStatus,
} from "../scripts/lib/container-status.ts";

afterEach(() => vi.unstubAllEnvs());

test("the CLI status census reads bounded D1 documents with exact identities", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-reader");
  vi.stubEnv(
    "CLOUDFLARE_D1_DATABASE_ID",
    "11111111-1111-1111-1111-111111111111",
  );
  const key = "metagraph/lakehouse/testnet/decode-run-status.json";
  const body = {
    status: "failed",
    detail: "source unavailable",
    updated_at: "2026-09-27T07:00:00Z",
  };
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.match(String(url), /\/d1\/database\//);
    const { batch } = JSON.parse(String(init?.body));
    assert.equal(batch.length, 1);
    assert.match(batch[0].sql, /LIMIT 65/);
    return Response.json({
      success: true,
      result: [
        {
          success: true,
          results: [
            {
              key: "container-status/v1/" + key,
              payload: JSON.stringify(body),
            },
          ],
        },
      ],
    });
  };
  assert.deepEqual(
    await readContainerStatuses(transport),
    new Map([[key, body]]),
  );
  assert.equal(calls, 1);
  for (const invalid of [
    null,
    "{",
    "[]",
    JSON.stringify({ detail: "x".repeat(65536) }),
  ])
    assert.throws(() => parseContainerStatus(invalid));
  await assert.rejects(
    readContainerStatuses(async () => new Response("failed", { status: 503 })),
  );
});
