import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  ErrorEnvelopeSchema,
  successEnvelopeSchema,
} from "../schemas-src/envelope.ts";
import { AccountEventsArtifactSchema } from "../schemas-src/routes/account-events-feed.ts";
import { SubnetEventsArtifactSchema } from "../schemas-src/routes/subnet-events.ts";
import { handleRequest } from "../workers/api.ts";
import * as feeds from "../src/indexed-account-feeds.ts";
import { nativeAccountRow } from "./helpers/native-account-row.ts";
import { parseJsonBody } from "./row-type.ts";

const PAYER = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

for (const kind of ["TransactionFeePaid", "TransactionFeePaidWithAlpha"]) {
  for (const scope of ["account", "subnet"]) {
    test(`REST ${scope} events accept exact ${kind} filters without valuing fees`, async () => {
      const netuid = kind === "TransactionFeePaid" ? null : 7;
      // Standard fees have no subnet attribution; alpha fees retain their netuid.
      const rows =
        scope === "account" || netuid != null
          ? [
              nativeAccountRow({
                event_kind: kind,
                hotkey: null,
                coldkey: PAYER,
                netuid,
                amount_tao: null,
                alpha_amount: null,
              }),
            ]
          : [];
      const read = vi
        .spyOn(feeds, "loadIndexedAccountFeedPage")
        .mockResolvedValue(rows);
      try {
        const path =
          scope === "account"
            ? `/api/v1/accounts/${PAYER}/events`
            : "/api/v1/subnets/7/events";
        const subnetFilter =
          scope === "account" && netuid != null ? "&netuid=7" : "";
        const response = await handleRequest(
          new Request(
            `https://api.metagraph.sh${path}?kind=${kind}${subnetFilter}&block_start=10&block_end=200&limit=2`,
          ),
          {} as Env,
          {},
        );
        assert.equal(response.status, 200);
        const body = await parseJsonBody(
          response,
          successEnvelopeSchema(
            scope === "account"
              ? AccountEventsArtifactSchema
              : SubnetEventsArtifactSchema,
          ),
        );
        assert.equal(body.data.event_count, rows.length);
        if (rows.length) {
          const [event] = body.data.events;
          assert.equal(event.event_kind, kind);
          assert.equal(event.hotkey, null);
          assert.equal(event.coldkey, PAYER);
          assert.equal(event.netuid, netuid);
          assert.equal(event.amount_tao, null);
          assert.equal(event.alpha_amount, null);
          assert.equal(event.price_at_tx, null);
          assert.equal(event.price_basis, null);
        } else {
          assert.deepEqual(body.data.events, []);
        }
        assert.equal(read.mock.calls.length, 1);
        const filters = {
          kind,
          netuid: scope === "account" ? netuid : 7,
          blockStart: 10,
          blockEnd: 200,
          cursor: null,
        };
        assert.deepEqual(
          read.mock.lastCall?.[1],
          scope === "account"
            ? ["hotkey", "coldkey"].map((side) => ({
                ...filters,
                side,
                account: PAYER,
              }))
            : [{ ...filters, side: "all", account: "*" }],
        );
        assert.equal(read.mock.lastCall?.[2], 2);
      } finally {
        read.mockRestore();
      }
    });
  }
}

test("REST event feeds reject fee-kind lookalikes before the indexed read", async () => {
  const read = vi.spyOn(feeds, "loadIndexedAccountFeedPage");
  try {
    for (const path of [
      `/api/v1/accounts/${PAYER}/events`,
      "/api/v1/subnets/7/events",
    ]) {
      for (const kind of [
        "TransactionFeePaidWithBeta",
        "transactionFeePaid",
        "TransactionFeePaidWithAlphaExtra",
      ]) {
        const response = await handleRequest(
          new Request(`https://api.metagraph.sh${path}?kind=${kind}`),
          {} as Env,
          {},
        );
        assert.equal(response.status, 400);
        const body = await parseJsonBody(response, ErrorEnvelopeSchema);
        assert.equal(body.error.code, "invalid_query");
        assert.equal(body.meta.parameter, "kind");
      }
    }
    assert.equal(read.mock.calls.length, 0);
  } finally {
    read.mockRestore();
  }
});
