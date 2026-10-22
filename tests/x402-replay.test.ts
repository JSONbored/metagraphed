import { expect, test, vi } from "vitest";
import {
  paymentRequirements,
  resolveX402Config,
  verifyAndSettle,
} from "../src/x402.ts";
import type {
  X402Attempt,
  X402AttemptStore,
} from "../src/x402-attempt-store.ts";
import { mockEnv } from "./row-type.ts";

const config = resolveX402Config(
  mockEnv({
    X402_PAY_TO: "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f",
    X402_NETWORK: "eip155:8453",
    X402_FACILITATOR_URL: "https://facilitator.payai.network",
  }),
)!;
const offers = paymentRequirements(config, "10000");
const payload = {
  x402Version: 2,
  accepted: offers[0],
  payload: {
    signature: "signed",
    authorization: {
      from: "0x" + "a".repeat(40),
      nonce: "0x" + "b".repeat(64),
    },
  },
};
const request = (
  value: unknown = payload,
  url = "https://api.metagraph.sh/api/v1/ask",
  body = "{}",
) =>
  new Request(url, {
    method: "POST",
    headers: { "payment-signature": btoa(JSON.stringify(value)) },
    body,
  });
function store() {
  const attempts = new Map<string, X402Attempt>();
  const api: X402AttemptStore = {
    get: vi.fn(async (key: string) => attempts.get(key) ?? null),
    bind: vi.fn(async (input) => {
      if (!attempts.has(input.identityKey))
        attempts.set(input.identityKey, {
          ...input,
          state: "pending",
          receipt: null,
        });
      return { ...attempts.get(input.identityKey)! };
    }),
    consume: vi.fn(async (key, fingerprint, receipt) => {
      const attempt = attempts.get(key)!;
      if (
        attempt.state !== "pending" ||
        attempt.requestFingerprint !== fingerprint
      )
        return false;
      attempts.set(key, {
        ...attempt,
        state: "consumed",
        receipt,
        envelope: null,
      });
      return true;
    }),
  };
  return { ...api, attempts };
}
const facilitator = (
  settlement: unknown = { success: true, transaction: "0xtx" },
  status = 200,
) =>
  vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith("/verify")
        ? { isValid: true, payer: "0xpayer" }
        : settlement,
      { status: String(url).endsWith("/verify") ? 200 : status },
    ),
  );
const run = (
  db: X402AttemptStore | null,
  fetcher = facilitator(),
  value = request(),
  offered: Parameters<typeof verifyAndSettle>[2] = offers,
) => verifyAndSettle(config, value, offered, fetcher, db);

test("mainnet cannot settle without its native durable owner or a signed transfer identity", async () => {
  const fetcher = facilitator();
  expect((await run(null, fetcher)).outcome).toBe("unavailable");
  expect(
    (await verifyAndSettle(config, request(), offers, fetcher)).outcome,
  ).toBe("unavailable");
  expect((await run(store(), fetcher, request({}))).outcome).toBe("malformed");
  expect(
    (
      await run(
        store(),
        fetcher,
        request(payload, undefined, "x".repeat(65_537)),
      )
    ).outcome,
  ).toBe("malformed");
  expect(fetcher).not.toHaveBeenCalled();
});

test("a verified payment authorizes paid work once and retains its receipt", async () => {
  const db = store();
  const fetcher = facilitator();
  const first = await run(db, fetcher);
  expect(first).toMatchObject({ outcome: "settled", payer: "0xpayer" });
  expect(await run(db, fetcher)).toEqual({
    outcome: "consumed",
    responseHeader: "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4dHgifQ==",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect([...db.attempts.values()][0]).toMatchObject({
    state: "consumed",
    envelope: null,
  });
});

test.each([
  "https://api.metagraph.sh/api/v1/ask?other=1",
  "https://api.metagraph.sh/api/v1/blocks",
])("one signed transfer cannot buy a different URL: %s", async (url) => {
  const db = store();
  const fetcher = facilitator();
  await run(db, fetcher);
  expect((await run(db, fetcher, request(payload, url))).outcome).toBe(
    "conflict",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("overlapping settlements authorize one execution", async () => {
  const db = store();
  const fetcher = facilitator();
  const outcomes = await Promise.all([
    run(db, fetcher),
    run(db, fetcher),
    run(db, fetcher),
  ]);
  expect(outcomes.filter((value) => value.outcome === "settled")).toHaveLength(
    1,
  );
  expect(outcomes.filter((value) => value.outcome === "consumed")).toHaveLength(
    2,
  );
});

test.each([
  [
    200,
    {
      success: false,
      errorReason: "settlement_pending",
      transaction: "broadcast",
    },
  ],
  [
    400,
    {
      success: false,
      errorReason: "duplicate_settlement",
      transaction: "broadcast",
    },
  ],
  [429, { success: false, errorReason: "rate_limited" }],
  [500, { success: true, transaction: "uncertain" }],
])(
  "ambiguous settlement %i retains a receipt, never grants work or a new quote",
  async (status, body) => {
    const db = store();
    const result = await run(db, facilitator(body, status));
    expect(result).toMatchObject({ outcome: "pending" });
    if (result.outcome === "pending")
      expect(JSON.parse(atob(result.responseHeader!))).toEqual(body);
    expect([...db.attempts.values()][0].state).toBe("pending");
    expect(db.consume).not.toHaveBeenCalled();
  },
);

test.each(["network", "not-json", "oversize", "null", "array"])(
  "ambiguous settlement transport %s preserves the bound envelope for retry",
  async (failure) => {
    const db = store();
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/verify"))
        return Response.json({ isValid: true });
      if (failure === "network") throw new Error("timeout after broadcast");
      return new Response(
        failure === "oversize"
          ? " ".repeat(65_537)
          : failure === "array"
            ? "[]"
            : failure === "null"
              ? "null"
              : "bad-json",
      );
    });
    expect((await run(db, fetcher)).outcome).toBe("pending");
    const original = [...db.attempts.values()][0];
    const changedConfig = {
      ...config,
      facilitatorUrl: "https://replacement.example",
    };
    const currentOffers = vi.fn(async () => {
      throw new Error("capability service down");
    });
    const retry = facilitator();
    expect(
      (
        await verifyAndSettle(
          changedConfig,
          request({ ...payload, unsignedMetadata: "changed" }),
          currentOffers,
          retry,
          db,
        )
      ).outcome,
    ).toBe("settled");
    expect(currentOffers).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledExactlyOnceWith(
      "https://facilitator.payai.network/settle",
      expect.objectContaining({ body: original.envelope }),
    );
  },
);

test("invalid signatures never allocate durable rows; non-2xx verify reasons survive", async () => {
  const db = store();
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(
      { isValid: false, invalidReason: "invalid_signature" },
      { status: 400 },
    ),
  );
  expect(await run(db, fetcher)).toEqual({
    outcome: "rejected",
    reason: "invalid_signature",
  });
  expect(db.bind).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([429, 500])(
  "verification %i is unavailable before any binding or settlement",
  async (status) => {
    const db = store();
    expect(
      (
        await run(
          db,
          vi.fn<typeof fetch>(async () =>
            Response.json({ isValid: true }, { status }),
          ),
        )
      ).outcome,
    ).toBe("unavailable");
    expect(db.bind).not.toHaveBeenCalled();
  },
);

test("discovery and store failures fail closed without payment submission", async () => {
  const db = store();
  const fetcher = facilitator();
  expect((await run(db, fetcher, request(), async () => null)).outcome).toBe(
    "unavailable",
  );
  expect(
    (
      await run(db, fetcher, request(), async () => {
        throw new Error("discovery offline");
      })
    ).outcome,
  ).toBe("unavailable");
  vi.mocked(db.get).mockRejectedValueOnce(new Error("D1 offline"));
  expect((await run(db, fetcher)).outcome).toBe("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
  vi.mocked(db.bind).mockRejectedValueOnce(new Error("write unavailable"));
  expect((await run(db, fetcher)).outcome).toBe("unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a lost execution-claim acknowledgement cannot authorize a second execution", async () => {
  const safeDb = store();
  const originalConsume = safeDb.consume.bind(safeDb);
  const adapter: X402AttemptStore = {
    ...safeDb,
    consume: async (...args) => {
      await originalConsume(...args);
      throw new Error("ack lost");
    },
  };
  expect((await run(adapter)).outcome).toBe("pending");
  expect((await run(safeDb)).outcome).toBe("consumed");
});

test("a declined durable claim and missing reread stay pending", async () => {
  const db = store();
  vi.mocked(db.consume).mockResolvedValue(false);
  vi.mocked(db.get).mockResolvedValue(null);
  expect((await run(db)).outcome).toBe("pending");
});

test("an impossible pending record without its envelope cannot settle", async () => {
  const db = store();
  const fetcher = facilitator();
  await run(db, facilitator({ success: false }));
  const attempt = [...db.attempts.values()][0];
  db.attempts.set(attempt.identityKey, { ...attempt, envelope: null });
  expect((await run(db, fetcher)).outcome).toBe("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

test("oversized signature headers are malformed without decoding or settlement", async () => {
  const req = new Request("https://api.metagraph.sh/api/v1/ask", {
    headers: { "payment-signature": "a".repeat(32_769) },
  });
  expect((await run(store(), facilitator(), req)).outcome).toBe("malformed");
});

test("changing the body cannot reuse a signed transfer", async () => {
  const db = store();
  await run(db);
  expect(
    (await run(db, facilitator(), request(payload, undefined, '{"other":1}')))
      .outcome,
  ).toBe("conflict");
});

test("a successful settlement cannot authorize work while the durable claim is unavailable", async () => {
  const db = store();
  vi.mocked(db.consume).mockRejectedValue(new Error("D1 write unavailable"));
  expect((await run(db)).outcome).toBe("pending");
  expect([...db.attempts.values()][0].state).toBe("pending");
});

test("the native mainnet guard also covers Solana with no store argument", async () => {
  const svm = resolveX402Config(
    mockEnv({
      X402_PAY_TO_SOLANA: "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87",
      X402_NETWORK_SOLANA: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    }),
  )!;
  const accepted = paymentRequirements(svm, "10000")[0];
  const transaction = btoa(
    String.fromCharCode(1) + "s".repeat(64) + "signed-message",
  );
  const fetcher = facilitator();
  const result = await verifyAndSettle(
    svm,
    request({ x402Version: 2, accepted, payload: { transaction } }),
    [accepted],
    fetcher,
  );
  expect(result.outcome).toBe("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

test("an interrupted request body cannot reach payment verification", async () => {
  const interrupted = request();
  interrupted.clone = () => {
    throw new Error("request body unavailable");
  };
  const fetcher = facilitator();
  expect((await run(store(), fetcher, interrupted)).outcome).toBe(
    "unavailable",
  );
  expect(fetcher).not.toHaveBeenCalled();
});
