import assert from "node:assert/strict";
import { test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function identityHistoryEnv(rows = []) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async all() {
                if (!/subnet_identity_history/.test(sql)) {
                  return { results: [] };
                }
                if (/ORDER BY observed_at DESC, id DESC LIMIT/.test(sql)) {
                  return { results: rows.filter((row) => row.id != null) };
                }
                if (/netuid IN/.test(sql)) {
                  return {
                    results: rows.filter((row) => params.includes(row.netuid)),
                  };
                }
                if (/GROUP BY subnet_name/.test(sql)) {
                  return {
                    results: rows.map(
                      ({ netuid, subnet_name, observed_at }) => ({
                        netuid,
                        subnet_name,
                        observed_at,
                      }),
                    ),
                  };
                }
                return { results: rows };
              },
            };
          },
        };
      },
    },
  };
}

function dbWith({ identityHistory } = {}) {
  return identityHistoryEnv(identityHistory || []);
}

const ROW = {
  id: 1,
  block_number: 100,
  observed_at: 1_700_000_000_000,
  subnet_name: "MIAO",
  symbol: "α",
  description: "sound AI",
  github_repo: null,
  subnet_url: null,
  discord: null,
  logo_url: null,
  identity_hash: "hash-1",
};

test("GET /subnets/{netuid}/identity-history returns the identity timeline (#1647)", async () => {
  const env = dbWith({ identityHistory: [ROW] });
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 1);
  assert.equal(body.data.entries[0].subnet_name, "MIAO");
});

test("GET /subnets/{netuid}/identity-history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /subnets/{netuid}/identity-history is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 0);
  assert.deepEqual(body.data.entries, []);
});

test("GET /subnets/{netuid} overlays previously_known_as on the subnet detail", async () => {
  const env = createLocalArtifactEnv({
    ...identityHistoryEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/subnets/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.subnet?.previously_known_as, ["Old Allways"]);
});

test("GET /agent-catalog overlays previously_known_as on index entries", async () => {
  const env = createLocalArtifactEnv({
    ...identityHistoryEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/agent-catalog"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const subnet = body.data.subnets.find((entry) => entry.netuid === 7);
  assert.ok(subnet);
  assert.deepEqual(subnet.previously_known_as, ["Old Allways"]);
});

test("GET /agent-catalog/{netuid} overlays previously_known_as on the detail entry", async () => {
  const env = createLocalArtifactEnv({
    ...identityHistoryEnv([
      { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
    ]),
  });
  const res = await handleRequest(req("/api/v1/agent-catalog/7"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.previously_known_as, ["Old Allways"]);
});
