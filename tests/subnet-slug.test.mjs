import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

const env = createLocalArtifactEnv();
const get = (path) =>
  handleRequest(new Request(`https://metagraph.sh${path}`), env, {});

describe("subnet slug aliases", () => {
  test("resolves /api/v1/subnets/allways to netuid 7", async () => {
    const res = await get("/api/v1/subnets/allways");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("resolves a slug sub-route (/profile)", async () => {
    const res = await get("/api/v1/subnets/allways/profile");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test("a numeric netuid still works unchanged", async () => {
    const res = await get("/api/v1/subnets/7");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.subnet.netuid, 7);
  });

  test("slug lookup is case-insensitive", async () => {
    const res = await get("/api/v1/subnets/ALLWAYS");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.subnet.netuid, 7);
  });

  test("an unknown slug returns 404 subnet_not_found", async () => {
    const res = await get("/api/v1/subnets/definitely-not-a-subnet");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "subnet_not_found");
  });

  test("a malformed percent-encoded slug returns 404 subnet_not_found", async () => {
    for (const path of ["/api/v1/subnets/%E0%A4%A", "/api/v1/subnets/%"]) {
      const res = await get(path);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "subnet_not_found");
    }
  });

  test("the subnets list route is unaffected", async () => {
    const res = await get("/api/v1/subnets?limit=2");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});
