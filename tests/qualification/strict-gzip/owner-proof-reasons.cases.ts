import assert from "node:assert/strict";
import test from "node:test";
import {
  OWNER_PROOF_REASON_CODES,
  OWNER_PROOF_REASON_REGISTRY,
} from "./owner-proof-reason-codes.ts";
import {
  ownerProofFailure,
  ownerProofReasonMarker,
  inheritOwnerProofReason,
  withOwnerProofReason,
  withOwnerProofReasonAsync,
  parseOwnerProofReasonMarker,
} from "./owner-proof-reasons.ts";
const first = OWNER_PROOF_REASON_CODES[0]!;
const second = OWNER_PROOF_REASON_CODES[1]!;
test("fixed reason registry is unique and deeply immutable", () => {
  assert.ok(Object.isFrozen(OWNER_PROOF_REASON_REGISTRY));
  assert.ok(Object.isFrozen(OWNER_PROOF_REASON_CODES));
  assert.equal(
    new Set(OWNER_PROOF_REASON_CODES).size,
    OWNER_PROOF_REASON_CODES.length,
  );
  for (const row of OWNER_PROOF_REASON_REGISTRY) {
    assert.ok(Object.isFrozen(row));
    assert.match(row.code, /^[a-z][a-z0-9-]{0,95}$/);
    assert.match(
      row.file,
      /^tests\/qualification\/strict-gzip\/[a-z0-9-]+\.ts$/,
    );
    assert.match(row.baselineSha256, /^[a-f0-9]{64}$/);
    assert.match(row.expressionSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(row.line) && row.line > 0);
    assert.ok(Number.isSafeInteger(row.column) && row.column > 0);
    assert.ok(row.description.length > 0 && row.description.length <= 256);
  }
});
for (const code of OWNER_PROOF_REASON_CODES)
  test("fixed reason roundtrip " + code, () => {
    const error = new Error("synthetic");
    assert.equal(ownerProofFailure(error, code), error);
    assert.equal(ownerProofReasonMarker(error), `[owner-proof-reason:${code}]`);
    assert.equal(
      parseOwnerProofReasonMarker(ownerProofReasonMarker(error)),
      code,
    );
  });
test("deepest failure branding wins and trusted wrappers inherit it", () => {
  const inner = ownerProofFailure(new Error("inner"), first);
  assert.equal(ownerProofFailure(inner, second), inner);
  assert.equal(ownerProofReasonMarker(inner), `[owner-proof-reason:${first}]`);
  const wrapper = new Error("wrapper", { cause: inner });
  assert.equal(inheritOwnerProofReason(wrapper, inner), wrapper);
  assert.equal(ownerProofReasonMarker(wrapper), ownerProofReasonMarker(inner));
  const branded = ownerProofFailure(new Error("already branded"), second);
  inheritOwnerProofReason(branded, inner);
  assert.equal(
    ownerProofReasonMarker(branded),
    `[owner-proof-reason:${second}]`,
  );
});
test("branding performs no proxy traps, accessor reads or error coercion", () => {
  let traps = 0;
  const poison = new Proxy(
    {},
    {
      get() {
        traps++;
        throw 0;
      },
      ownKeys() {
        traps++;
        throw 0;
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw 0;
      },
      getPrototypeOf() {
        traps++;
        throw 0;
      },
    },
  );
  assert.equal(ownerProofReasonMarker(poison), "");
  assert.equal(ownerProofFailure(poison, first), poison);
  assert.equal(ownerProofReasonMarker(poison), `[owner-proof-reason:${first}]`);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  ownerProofFailure(revoked.proxy, first);
  assert.equal(
    ownerProofReasonMarker(revoked.proxy),
    `[owner-proof-reason:${first}]`,
  );
  const accessor = Object.defineProperty({}, "message", {
    get() {
      traps++;
      throw 0;
    },
  });
  ownerProofFailure(accessor, first);
  assert.equal(
    ownerProofReasonMarker(accessor),
    `[owner-proof-reason:${first}]`,
  );
  assert.equal(traps, 0);
});
for (const value of [undefined, null, 1, true, "secret", Symbol("secret")])
  test("primitive thrown value retained " + typeof value, () => {
    assert.equal(ownerProofFailure(value, first), value);
    assert.equal(ownerProofReasonMarker(value), "");
    assert.equal(
      inheritOwnerProofReason(value, ownerProofFailure({}, first)),
      value,
    );
  });
test("sync/async wrappers preserve values, identity and deepest failures", async () => {
  const value = {};
  assert.equal(
    withOwnerProofReason(first, () => value),
    value,
  );
  assert.equal(
    await withOwnerProofReasonAsync(first, async () => value),
    value,
  );
  const error = {};
  assert.throws(
    () =>
      withOwnerProofReason(second, () =>
        withOwnerProofReason(first, () => {
          throw error;
        }),
      ),
    (cause) => cause === error,
  );
  assert.equal(ownerProofReasonMarker(error), `[owner-proof-reason:${first}]`);
  const asyncError = {};
  await assert.rejects(
    withOwnerProofReasonAsync(second, async () =>
      withOwnerProofReasonAsync(first, async () => {
        throw asyncError;
      }),
    ),
    (cause) => cause === asyncError,
  );
  assert.equal(
    ownerProofReasonMarker(asyncError),
    `[owner-proof-reason:${first}]`,
  );
});
const valid = `[owner-proof-reason:${first}]`;
for (const [name, text] of [
  ["unknown", "[owner-proof-reason:unknown]"],
  ["malformed", valid.slice(0, -1)],
  ["duplicate", valid + valid],
  ["conflicting", valid + `[owner-proof-reason:${second}]`],
  ["oversized", "x".repeat(65536) + valid],
  ["object", { message: valid }],
  ["secret", "[owner-proof-reason:https://private/secret]"],
])
  test("strict reason marker rejects " + name, () =>
    assert.equal(parseOwnerProofReasonMarker(text), null),
  );
test("runtime unregistered or non-string code cannot create a reason", () => {
  const error = {};
  ownerProofFailure(error, "not-registered" as any);
  assert.equal(ownerProofReasonMarker(error), "");
  ownerProofFailure(error, {
    toString() {
      throw 0;
    },
  } as any);
  assert.equal(ownerProofReasonMarker(error), "");
});
for (const malformed of [
  "[owner-proof-reason]",
  "[owner-proof-reasonX:secret]",
])
  test("reason parser rejects malformed accompanying marker " + malformed, () =>
    assert.equal(parseOwnerProofReasonMarker(malformed + valid), null),
  );
