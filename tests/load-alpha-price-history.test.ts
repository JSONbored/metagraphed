// The alpha-price history loader reads D1 over the HTTP door, because the
// Postgres it used to read was destroyed with the box. What these tests pin is
// the failure contract: this loader is ALLOWED to return null (the bake then
// emits null change fields, which is schema-stable), so every path that cannot
// produce real history must return null rather than an empty map -- an empty
// map is a confident "no price moved", and it is indistinguishable downstream
// from the truth. That confusion is exactly what served null change fields on
// /api/v1/economics for a day after the wipe.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  SUBNET_SNAPSHOTS_D1_DATABASE_ID,
  alphaPriceHistoryQuery,
  loadAlphaPriceHistoryByNetuid,
} from "../scripts/lib/load-alpha-price-history.ts";

const CREDS = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "token",
};

/** A D1 HTTP door that answers with `body`, recording what it was asked. */
function d1Fetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function okBody(rows: Record<string, unknown>[]) {
  return { success: true, result: [{ results: rows }] };
}

describe("alphaPriceHistoryQuery", () => {
  test("uses SQLite date arithmetic, not Postgres INTERVAL", () => {
    const sql = alphaPriceHistoryQuery();
    // date('now','-40 days') is the D1 spelling; CURRENT_DATE - INTERVAL is
    // the Postgres one and would be a syntax error here.
    assert.match(
      sql,
      new RegExp(
        `date\\('now','-${ALPHA_PRICE_HISTORY_LOOKBACK_DAYS} days'\\)`,
      ),
    );
    assert.ok(!sql.includes("INTERVAL"));
    assert.match(sql, /ORDER BY netuid ASC, snapshot_date ASC/);
  });

  test("truncates a fractional lookback rather than emitting a broken literal", () => {
    assert.match(alphaPriceHistoryQuery(7.9), /-7 days/);
  });
});

describe("loadAlphaPriceHistoryByNetuid", () => {
  test("indexes the D1 rows by netuid", async () => {
    const { impl, calls } = d1Fetch(
      okBody([
        { netuid: 1, snapshot_date: "2026-08-01", alpha_price_tao: 0.5 },
        { netuid: 1, snapshot_date: "2026-08-02", alpha_price_tao: 0.6 },
        { netuid: 2, snapshot_date: "2026-08-02", alpha_price_tao: 0.1 },
      ]),
    );
    const history = await loadAlphaPriceHistoryByNetuid(CREDS, impl);
    assert.ok(history);
    assert.equal(history.size, 2);
    assert.deepEqual(history.get(1), [
      // #9449: captured_at rides along so the window arithmetic downstream
      // measures elapsed time instead of subtracting calendar dates.
      { snapshot_date: "2026-08-01", alpha_price_tao: 0.5, captured_at: null },
      { snapshot_date: "2026-08-02", alpha_price_tao: 0.6, captured_at: null },
    ]);
    // The bounded D1 database, and the token as the only credential.
    assert.ok(calls[0].url.includes(SUBNET_SNAPSHOTS_D1_DATABASE_ID));
    assert.ok(calls[0].url.includes("/accounts/acct/d1/database/"));
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer token",
    );
  });

  test("an explicit database id overrides the default", async () => {
    const { impl, calls } = d1Fetch(okBody([]));
    await loadAlphaPriceHistoryByNetuid(
      { ...CREDS, METAGRAPH_D1_DATABASE_ID: "other-db" },
      impl,
    );
    assert.ok(calls[0].url.includes("/d1/database/other-db/query"));
  });

  test("an empty result set is a real answer, not a failure", async () => {
    const { impl } = d1Fetch(okBody([]));
    const history = await loadAlphaPriceHistoryByNetuid(CREDS, impl);
    assert.ok(history);
    assert.equal(history.size, 0);
  });

  test("missing credentials return null without touching the network", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;
    assert.equal(await loadAlphaPriceHistoryByNetuid({}, impl), null);
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(
        { CLOUDFLARE_ACCOUNT_ID: "acct" },
        impl,
      ),
      null,
    );
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(
        { CLOUDFLARE_API_TOKEN: "token" },
        impl,
      ),
      null,
    );
    assert.equal(called, false);
  });

  test("an HTTP failure, an error envelope, and a shapeless body all decline", async () => {
    const http = d1Fetch(okBody([]), { ok: false, status: 500 });
    assert.equal(await loadAlphaPriceHistoryByNetuid(CREDS, http.impl), null);

    const errored = d1Fetch({
      success: false,
      errors: [{ message: "no such table: subnet_snapshots" }],
    });
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, errored.impl),
      null,
    );

    // A body we do not understand must NOT read as "no history": an empty map
    // would bake confident nulls from a response we failed to parse.
    const shapeless = d1Fetch({ success: true, result: [] });
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, shapeless.impl),
      null,
    );

    const errorless = d1Fetch({ success: false });
    assert.equal(
      await loadAlphaPriceHistoryByNetuid(CREDS, errorless.impl),
      null,
    );
  });

  test("a thrown transport error declines instead of propagating", async () => {
    const impl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    assert.equal(await loadAlphaPriceHistoryByNetuid(CREDS, impl), null);
  });
});
