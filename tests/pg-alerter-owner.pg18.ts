import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgAlerterOwner } from "../src/pg-alerter-owner.ts";
import {
  createNativeAlerter,
  type NativeAlerterOptions,
} from "../src/native-alerter.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime,
  ownSchema = false;
const services: Awaited<ReturnType<typeof createNativeAlerter>>[] = [];
describe("native alerter owner on PostgreSQL18", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    ownSchema =
      (
        await control.query(
          "SELECT 1 FROM pg_namespace WHERE nspname='realtime'",
        )
      ).rowCount === 0;
    await control.query(
      readFileSync(
        new URL(
          "../migrations/postgres/0037_alerter_owner.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError() {},
    });
  });
  beforeEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    await control.query("TRUNCATE realtime.alerter_owner");
  });
  after(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    await runtime.close();
    if (ownSchema) await control.query("DROP SCHEMA realtime CASCADE");
    else await control.query("DROP TABLE realtime.alerter_owner");
    await control.end();
  });
  it("serializes claims, refuses expired ownership and fences stale release", async () => {
    const a = await createPgAlerterOwner(runtime, 60000),
      b = await createPgAlerterOwner(runtime, 60000);
    const leases = await Promise.all([a.acquire(), b.acquire()]);
    assert.equal(leases.filter(Boolean).length, 1);
    const lease = leases.find((value) => value !== null)!;
    await control.query("UPDATE realtime.alerter_owner SET lease_until_ms=0");
    await assert.rejects(a.renew(lease), /ownership was lost/);
    const replacement = await b.acquire();
    assert.ok(replacement);
    assert.notEqual(replacement.token, lease.token);
    await a.release(lease);
    assert.equal(
      (
        await control.query(
          "SELECT owner_token::text FROM realtime.alerter_owner",
        )
      ).rows[0].owner_token,
      replacement.token,
    );
    await b.release(replacement);
  });
  it("reuses source delivery counts with synthetic I/O and no retained transaction", async () => {
    let deliveries = 0;
    const options: NativeAlerterOptions = {
      dataApi: {
        async fetch(request) {
          assert.equal(
            (
              await control.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
              )
            ).rows[0].n,
            0,
          );
          return new Response(
            JSON.stringify(
              new URL(request.url).pathname.endsWith("alert-triggers-active")
                ? {
                    triggers: [
                      {
                        id: "1",
                        tableFilter: null,
                        netuid: 7,
                        eventKind: null,
                        account: null,
                        minAmountTao: null,
                        channel: "webhook",
                        destination: "https://example.com/fixture",
                      },
                    ],
                  }
                : {},
            ),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
      outbound: {
        async resolve() {
          return [{ address: "93.184.216.34", family: 4 }];
        },
        async send(_request, _addresses, beforeSend) {
          beforeSend();
          deliveries++;
          assert.equal(
            (
              await control.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
              )
            ).rows[0].n,
            0,
          );
          return new Response(null, { status: 204 });
        },
      },
      secrets: { ALERT_TRIGGERS_INTERNAL_TOKEN: "fixture-only" },
      maxConcurrentEvaluations: 2,
      maxConcurrentInternal: 4,
      maxConcurrentOutbound: 2,
      maxRequestBytes: 4096,
      maxInternalResponseBytes: 65536,
      maxOutboundRequestBytes: 8192,
      maxOutboundResponseBytes: 4096,
      leaseMilliseconds: 60000,
      renewIntervalMillis: 10000,
      executionTimeoutMillis: 5000,
      drainTimeoutMillis: 1000,
      onBackgroundError() {},
    };
    const service = await createNativeAlerter(runtime, options);
    services.push(service);
    const request = () =>
      new Request("https://fixture.invalid/evaluate", {
        method: "POST",
        body: JSON.stringify({ table: "account_events", netuid: 7 }),
      });
    assert.deepEqual(await (await service.fetch(request())).json(), {
      matched: 1,
      trigger_ids: ["1"],
      delivered: 1,
      rate_limited: 0,
    });
    assert.deepEqual(await (await service.fetch(request())).json(), {
      matched: 1,
      trigger_ids: ["1"],
      delivered: 0,
      rate_limited: 1,
    });
    assert.equal(deliveries, 1);
    await control.query(
      "UPDATE realtime.alerter_owner SET owner_token='00000000-0000-4000-8000-000000000002'::uuid",
    );
    assert.equal((await service.fetch(request())).status, 503);
    assert.equal(deliveries, 1);
  });
});
