import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import {
  buildSubnetMetagraph,
  buildSubnetValidators,
} from "../src/metagraph-neurons.ts";
import { handleRequest } from "../workers/api.ts";
import {
  canonicalSubnetMetagraphCachePath,
  canonicalSubnetValidatorsCachePath,
} from "../workers/request-handlers/entities.ts";
import { jsonBody } from "./row-type.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture(route: "metagraph" | "validators") {
  const store = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      async match(request: Request) {
        return store.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        store.set(request.url, response.clone());
      },
    },
  });
  let reads = 0;
  const row = {
    netuid: 7,
    uid: 3,
    hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    coldkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    active: 1,
    validator_permit: 1,
    stake_tao: 100,
    emission_tao: 1,
    captured_at: 1_790_119_572_836,
    block_number: 9_126_000,
  };
  const data =
    route === "metagraph"
      ? buildSubnetMetagraph([row], 7)
      : buildSubnetValidators([row], 7);
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_NEURONS_SOURCE: "data-api",
    METAGRAPH_AUDIT_RESPONSES: "enforce",
    METAGRAPH_CONTROL: {
      async get(key: string) {
        return key === "health:meta"
          ? { last_run_at: "2026-09-22T23:46:12.836Z" }
          : null;
      },
    },
    DATA_API: {
      async fetch() {
        reads += 1;
        return Response.json(data);
      },
    },
  };
  const pending: Promise<unknown>[] = [];
  return {
    store,
    get reads() {
      return reads;
    },
    async request(search = "", init?: RequestInit) {
      const response = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/subnets/7/${route}${search}`,
          init,
        ),
        env as unknown as Env,
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending.splice(0));
      return response;
    },
  };
}

for (const route of ["metagraph", "validators"] as const) {
  describe(`${route} projection cache isolation`, () => {
    const key = route === "metagraph" ? "neurons" : "validators";
    const canonical =
      route === "metagraph"
        ? canonicalSubnetMetagraphCachePath
        : canonicalSubnetValidatorsCachePath;

    test("canonical keys preserve field order, normalize duplicates, and validate before CSV reuse", async () => {
      const path = `/api/v1/subnets/7/${route}`;
      const url = (query: string) =>
        new URL(`https://api.metagraph.sh${path}${query}`);
      assert.equal(
        canonical(url("?fields=uid,%20hotkey,uid&format=json")),
        canonical(url("?fields=uid,hotkey")),
      );
      assert.notEqual(
        canonical(url("?fields=hotkey,uid")),
        canonical(url("?fields=uid,hotkey")),
      );
      for (const fields of ["", "stake", "1x"]) {
        const raw = `?fields=${fields}`;
        assert.equal(canonical(url(raw)), path + raw);
      }
      const f = fixture(route);
      const csv = await f.request("?format=csv&fields=uid");
      const csvText = await csv.text();
      assert.match(csvText, /coldkey/);
      const equivalent = await f.request("?fields=hotkey", {
        headers: { accept: "text/csv" },
      });
      assert.equal(equivalent.headers.get("x-metagraph-cache"), "hit");
      assert.equal(await equivalent.text(), csvText);
      const invalid = await f.request("?format=csv&fields=stake");
      assert.equal(invalid.status, 400);
      const json = await f.request("?format=json&fields=uid", {
        headers: { accept: "text/csv" },
      });
      assert.deepEqual(Object.keys((await jsonBody(json)).data[key][0]), [
        "uid",
      ]);
    });
    for (const projectedFirst of [true, false]) {
      test(`projected/full requests remain distinct, projected first: ${projectedFirst}`, async () => {
        const f = fixture(route);
        for (const search of projectedFirst
          ? ["?fields=uid,hotkey", ""]
          : ["", "?fields=uid,hotkey"]) {
          const response = await f.request(search);
          assert.equal(response.status, 200);
          const body = await jsonBody(response);
          assert.equal(body.data[key].length, 1);
          if (search) {
            assert.deepEqual(Object.keys(body.data[key][0]), ["uid", "hotkey"]);
            assert.deepEqual(body.meta.projection.fields, ["uid", "hotkey"]);
          } else {
            assert.ok(Object.keys(body.data[key][0]).length > 2);
            assert.equal(body.meta.projection, undefined);
          }
        }
        assert.equal(f.reads, 2);
        for (const search of ["", "?fields=uid,hotkey"]) {
          const hit = await f.request(search);
          assert.equal(hit.status, 200);
          assert.equal(hit.headers.get("x-metagraph-cache"), "hit");
        }
        assert.equal(f.reads, 2);
      });
    }

    test("multiple projections, invalid fields, HEAD and conditional responses stay isolated", async () => {
      const f = fixture(route);
      const projected = await f.request("?fields=uid,hotkey");
      const etag = projected.headers.get("etag")!;
      const other = await jsonBody(await f.request("?fields=hotkey"));
      assert.deepEqual(Object.keys(other.data[key][0]), ["hotkey"]);
      const full = await f.request("", { headers: { "if-none-match": etag } });
      assert.equal(full.status, 200);
      const conditional = await f.request("?fields=uid,hotkey", {
        headers: { "if-none-match": etag },
      });
      assert.equal(conditional.status, 304);
      const head = await f.request("?fields=uid", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      const get = await jsonBody(await f.request("?fields=uid"));
      assert.deepEqual(Object.keys(get.data[key][0]), ["uid"]);
      const reads = f.reads;
      for (const fields of ["stake", "", "1x"]) {
        const invalid = await f.request(`?fields=${fields}`);
        assert.equal(invalid.status, 400);
      }
      assert.equal(f.reads, reads);
    });
  });
}

test("validator-permit filtering retains its own projected cache key", async () => {
  const f = fixture("metagraph");
  for (const query of [
    "?fields=uid",
    "?validator_permit=true&fields=uid",
    "?validator_permit=true",
  ]) {
    const response = await f.request(query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-metagraph-cache"), "miss");
  }
  assert.equal(f.reads, 3);
  assert.equal(f.store.size, 3);
});
