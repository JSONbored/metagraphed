import { parseJsonBody } from "./row-type.ts";
import {
  ErrorEnvelopeSchema,
  successEnvelopeSchema,
} from "../schemas-src/envelope.ts";
import { SubnetDetailArtifactSchema } from "../schemas-src/routes/subnet-detail.ts";
import { SubnetProfileArtifactSchema } from "../schemas-src/routes/subnet-profiles.ts";
import { SubnetsArtifactSchema } from "../schemas-src/routes/subnets.ts";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";

const env = createLocalArtifactEnv();
const get = (path: string) =>
  handleRequest(
    new Request(`https://metagraph.sh${path}`),
    env as unknown as Env,
    {},
  );

describe("subnet slug aliases", () => {
  test("resolves /api/v1/subnets/allways to netuid 7", async () => {
    const res = await get("/api/v1/subnets/allways");
    assert.equal(res.status, 200);
    const body = await parseJsonBody(
      res,
      successEnvelopeSchema(SubnetDetailArtifactSchema),
    );
    assert.equal(body.ok, true);
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("resolves a slug sub-route (/profile)", async () => {
    const res = await get("/api/v1/subnets/allways/profile");
    assert.equal(res.status, 200);
    const body = await parseJsonBody(
      res,
      successEnvelopeSchema(SubnetProfileArtifactSchema),
    );
    assert.equal(body.ok, true);
  });

  test("a numeric netuid still works unchanged", async () => {
    const res = await get("/api/v1/subnets/7");
    assert.equal(res.status, 200);
    const body = await parseJsonBody(
      res,
      successEnvelopeSchema(SubnetDetailArtifactSchema),
    );
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("slug lookup is case-insensitive", async () => {
    const res = await get("/api/v1/subnets/ALLWAYS");
    assert.equal(res.status, 200);
    const body = await parseJsonBody(
      res,
      successEnvelopeSchema(SubnetDetailArtifactSchema),
    );
    assert.equal(body.data.subnet.netuid, 7);
  });

  test("an unknown slug returns 404 subnet_not_found", async () => {
    const res = await get("/api/v1/subnets/definitely-not-a-subnet");
    assert.equal(res.status, 404);
    const body = await parseJsonBody(res, ErrorEnvelopeSchema);
    assert.equal(body.error.code, "subnet_not_found");
  });

  test("a malformed percent-encoded slug returns 404 subnet_not_found", async () => {
    for (const path of ["/api/v1/subnets/%E0%A4%A", "/api/v1/subnets/%"]) {
      const res = await get(path);
      assert.equal(res.status, 404);
      const body = await parseJsonBody(res, ErrorEnvelopeSchema);
      assert.equal(body.error.code, "subnet_not_found");
    }
  });

  test("the subnets list route is unaffected", async () => {
    const res = await get("/api/v1/subnets?limit=2");
    assert.equal(res.status, 200);
    const body = await parseJsonBody(
      res,
      successEnvelopeSchema(SubnetsArtifactSchema),
    );
    assert.equal(body.ok, true);
  });
});
