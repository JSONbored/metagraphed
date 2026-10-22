import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  x402PaymentIdentity,
  x402RequestFingerprint,
} from "../src/x402-identity.ts";

const from = "0xA123456789012345678901234567890123456789";
const nonce = "0x" + "A1".repeat(32);
const asset = "0xA333333333333333333333333333333333333333";
const solanaAsset = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function evm() {
  return {
    accepted: { network: "eip155:8453", asset },
    payload: { authorization: { from, nonce } },
  };
}
function svm(transaction: string) {
  return {
    accepted: { network: "solana:mainnet", asset: solanaAsset },
    payload: { transaction },
  };
}
function transaction(message: readonly number[], signature = 0, prefix = [2]) {
  return Buffer.concat([
    Buffer.from(prefix),
    Buffer.alloc(64),
    Buffer.alloc(64, signature),
    Buffer.from(message),
  ]).toString("base64");
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("EVM identity is the normalized chain, token, signer and authorization nonce", async () => {
  const payment = evm();
  const identity = await x402PaymentIdentity(payment);
  assert.equal(
    identity,
    digest([
      payment.accepted.network,
      asset.toLowerCase(),
      `${from.toLowerCase()}:${nonce.toLowerCase()}`,
    ]),
  );
  assert.equal(
    await x402PaymentIdentity({
      ...payment,
      resource: { url: "https://changed.example/another-call" },
      accepted: { ...payment.accepted, asset: asset.toLowerCase(), amount: "999" },
      payload: {
        authorization: { from: from.toLowerCase(), nonce: nonce.toLowerCase() },
        signature: "a-different-serialization",
      },
    }),
    identity,
  );
  for (const changed of [
    { ...payment, accepted: { ...payment.accepted, network: "eip155:84532" } },
    { ...payment, accepted: { ...payment.accepted, asset: "0xother-token" } },
    {
      ...payment,
      payload: { authorization: { from, nonce: "0x" + "b2".repeat(32) } },
    },
    {
      ...payment,
      payload: { authorization: { from: "0x" + "b".repeat(40), nonce } },
    },
  ]) {
    assert.notEqual(await x402PaymentIdentity(changed), identity);
  }
});

test("Solana identity binds the entire signed message, not its unsigned fee-payer slot", async () => {
  const original = svm(transaction([0x80, 2, 0, 1, 3, 4], 1));
  const identity = await x402PaymentIdentity(original);
  assert.equal(
    identity,
    digest([original.accepted.network, solanaAsset, "800200010304"]),
  );
  assert.notEqual(
    await x402PaymentIdentity(svm(transaction([0x80, 2, 0, 1, 3, 5], 1))),
    identity,
    "different signed messages must not collide on a zero-filled first signature",
  );
  assert.equal(
    await x402PaymentIdentity({
      ...original,
      resource: { url: "https://changed.example" },
      payload: { transaction: transaction([0x80, 2, 0, 1, 3, 4], 2) },
    }),
    identity,
    "signature slots and unsigned metadata cannot create a new execution identity",
  );
  assert.notEqual(
    await x402PaymentIdentity({
      ...original,
      accepted: { ...original.accepted, asset: solanaAsset.toLowerCase() },
    }),
    identity,
    "Solana mint addresses are case-sensitive",
  );
});

test("compact-count encodings frame the same Solana message consistently", async () => {
  const message = [0x80, 2, 0, 1];
  const identity = await x402PaymentIdentity(svm(transaction(message)));
  assert.equal(
    await x402PaymentIdentity(svm(transaction(message, 0, [0x82, 0]))),
    identity,
  );
  assert.equal(
    await x402PaymentIdentity(svm(transaction(message, 0, [0x82, 0x80, 0]))),
    identity,
  );
  assert.notEqual(
    await x402PaymentIdentity(
      svm(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]).toString("base64")),
    ),
    null,
  );
});

test.each([
  null,
  undefined,
  false,
  true,
  0,
  "not-an-object",
  [],
  {},
  { accepted: [] },
  { accepted: { network: 1, asset }, payload: {} },
  { accepted: { network: "eip155:8453", asset: 1 }, payload: {} },
  { accepted: { network: "eip155:8453", asset }, payload: [] },
  { accepted: { network: "unknown:1", asset }, payload: {} },
  { ...evm(), payload: {} },
  { ...evm(), payload: { authorization: [] } },
  { ...evm(), payload: { authorization: { from: 1, nonce } } },
  { ...evm(), payload: { authorization: { from: "0xwrong", nonce } } },
  { ...evm(), payload: { authorization: { from, nonce: 1 } } },
  { ...evm(), payload: { authorization: { from, nonce: "0xshort" } } },
  { ...svm(""), payload: { transaction: 1 } },
])("malformed payment identity fails closed: %j", async (payment) => {
  assert.equal(await x402PaymentIdentity(payment), null);
});

test.each([
  "!!!",
  "",
  Buffer.alloc(1_233).toString("base64"),
  Buffer.from([0x80]).toString("base64"),
  Buffer.from([0x80, 0x80]).toString("base64"),
  Buffer.from([0x80, 0x80, 0x80]).toString("base64"),
  Buffer.from([0]).toString("base64"),
  Buffer.from([33]).toString("base64"),
  Buffer.from([0xff, 0xff, 0x7f]).toString("base64"),
  Buffer.concat([Buffer.from([1]), Buffer.alloc(64)]).toString("base64"),
])("malformed Solana transaction framing fails closed: %s", async (wire) => {
  assert.equal(await x402PaymentIdentity(svm(wire)), null);
});

const url = "https://api.metagraph.sh/api/v1/ask?depth=1";
function post(body: BodyInit, headers: HeadersInit = {}) {
  return new Request(url, { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

test("a request fingerprint binds method, exact URL and raw body without consuming it", async () => {
  const request = post('{"question":"hello"}');
  const bodyHex = Buffer.from('{"question":"hello"}').toString("hex");
  const fingerprint = await x402RequestFingerprint(request);
  assert.equal(fingerprint, digest(["POST", url, bodyHex]));
  assert.equal(await x402RequestFingerprint(request), fingerprint);
  assert.equal(request.bodyUsed, false);
  assert.equal(await request.text(), '{"question":"hello"}');
  for (const changed of [
    new Request(url, { method: "PUT", body: '{"question":"hello"}' }),
    new Request(url + "&other=true", { method: "POST", body: '{"question":"hello"}' }),
    post('{"question":"changed"}'),
  ]) {
    assert.notEqual(await x402RequestFingerprint(changed), fingerprint);
  }
  assert.equal(
    await x402RequestFingerprint(new Request(url)),
    digest(["GET", url, ""]),
  );
});

test("different raw bodies remain distinct despite UTF-8 replacement and BOM handling", async () => {
  const fingerprints = await Promise.all(
    [
      Buffer.from([0x80]),
      Buffer.from([0x81]),
      Buffer.from("\uFFFD"),
      Buffer.from([0xef, 0xbb, 0xbf, 0x41]),
      Buffer.from("A"),
      Buffer.from([0x41, 0]),
    ].map((body) => x402RequestFingerprint(post(body))),
  );
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test("fingerprinting accepts exactly 64 KiB and rejects a lying oversized body", async () => {
  const exact = post(Buffer.alloc(65_536, 0xff));
  assert.match((await x402RequestFingerprint(exact))!, /^[0-9a-f]{64}$/);
  await exact.arrayBuffer();
  const headerCases: HeadersInit[] = [{}, { "content-length": "0" }];
  for (const headers of headerCases) {
    const oversized = post(Buffer.alloc(65_537), headers);
    assert.equal(await x402RequestFingerprint(oversized), null);
    await oversized.body!.cancel();
  }
});

test("an oversized declared body is refused without consuming it", async () => {
  const request = post("small", { "content-length": "65537" });
  assert.equal(await x402RequestFingerprint(request), null);
  assert.equal(request.bodyUsed, false);
  assert.equal(await request.text(), "small");
});

test("chunk boundaries do not change the request fingerprint", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from([0xc3]));
      controller.enqueue(Buffer.from([0xa9, 0]));
      controller.close();
    },
  });
  const request = post(stream);
  assert.equal(
    await x402RequestFingerprint(request),
    await x402RequestFingerprint(post(Buffer.from([0xc3, 0xa9, 0]))),
  );
  await request.arrayBuffer();
});

test("interrupted body reads propagate rather than produce an execution fingerprint", async () => {
  const request = post(new ReadableStream({
    start(controller) {
      controller.error(new Error("request interrupted"));
    },
  }));
  await assert.rejects(x402RequestFingerprint(request), /request interrupted/);
});

test("oversize rejection releases its reader even if cancellation fails", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(65_537));
    },
    cancel() {
      throw new Error("cancel cleanup failed");
    },
  });
  const request = post("unused");
  request.clone = () => ({ body: stream }) as Request;
  assert.equal(await x402RequestFingerprint(request), null);
  await Promise.resolve();
  assert.equal(stream.locked, false);
});
