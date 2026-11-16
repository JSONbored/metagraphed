// The evm-associations serving family (#13165): the pure builder, the native
// store seam, and the PostgreSQL store module behind the /evm/address/{h160}
// storage-first path (tests/address-mapping.test.ts exercises the composed
// loader; the real PostgreSQL schema is proven by
// tests/pg-evm-associations.pg18.ts).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildEvmAssociations,
  formatEvmAssociation,
  loadEvmAssociations,
} from "../src/evm-associations.ts";
import { selectedEvmAssociationsStore } from "../src/evm-associations-store.ts";
import {
  createPgEvmAssociationsStore,
  EVM_ASSOCIATIONS_ROW_CAP,
} from "../src/pg-evm-associations.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();
const H160 = `0x${"ab".repeat(20)}`;

function associationRow(overrides: Row = {}): Row {
  return {
    ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    netuid: 64,
    uid: 7,
    associated_at: "9000000",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildEvmAssociations", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildEvmAssociations(rows), {
        // Never 0: an empty list is "the association capture has not run",
        // not a measured never-associated key.
        association_count: null,
        associations: [],
      });
    }
  });

  test("formats rows, dropping any without a subnet/uid identity", () => {
    const built = buildEvmAssociations([
      associationRow(),
      associationRow({ netuid: null }),
      associationRow({ netuid: 70000 }),
      associationRow({ uid: "" }),
      associationRow({ uid: 65536 }),
    ]);
    assert.equal(built.association_count, 1);
    assert.deepEqual(built.associations, [
      {
        ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        netuid: 64,
        uid: 7,
        associated_at: 9_000_000,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("soft cells degrade to null, never fabricated", () => {
    const built = buildEvmAssociations([
      associationRow({
        ss58: "",
        associated_at: "not-a-block",
        captured_at: null,
      }),
      // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
      associationRow({ uid: 8, captured_at: 9_000_000_000_000_000 }),
    ]);
    assert.deepEqual(built.associations[0], {
      ss58: null,
      netuid: 64,
      uid: 7,
      associated_at: null,
      captured_at: null,
    });
    assert.equal((built.associations[1] as Row).captured_at, null);
  });
});

describe("formatEvmAssociation", () => {
  test("a non-numeric capture stamp is not a stamp", () => {
    assert.equal(
      (formatEvmAssociation(associationRow({ captured_at: "abc" })) as Row)
        .captured_at,
      null,
    );
  });

  test("a blank associated_at is not a block", () => {
    assert.equal(
      (formatEvmAssociation(associationRow({ associated_at: "" })) as Row)
        .associated_at,
      null,
    );
  });
});

describe("selectedEvmAssociationsStore / loadEvmAssociations", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedEvmAssociationsStore({}), null);
    assert.equal(selectedEvmAssociationsStore(null), null);
    assert.equal(await loadEvmAssociations({}, H160), null);
  });

  test("a bound store serves its rows, lowercasing the key", async () => {
    const asked: string[] = [];
    const env = {
      EVM_ASSOCIATIONS_STORE: {
        byH160: async (h160: string) => {
          asked.push(h160);
          return [associationRow()];
        },
      },
    };
    assert.deepEqual(
      await loadEvmAssociations(env, H160.toUpperCase().replace("0X", "0x")),
      [associationRow()],
    );
    assert.deepEqual(asked, [H160]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      EVM_ASSOCIATIONS_STORE: {
        byH160: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadEvmAssociations(env, H160), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () => selectedEvmAssociationsStore({ EVM_ASSOCIATIONS_STORE: store }),
        /Invalid native evm associations store/,
      );
    }
  });
});

describe("createPgEvmAssociationsStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgEvmAssociationsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [associationRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one key's associations newest-first, capped", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.byH160(H160), [associationRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.evm_associations/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC, netuid, uid/);
    assert.match(
      calls[0].sql,
      new RegExp(`LIMIT ${EVM_ASSOCIATIONS_ROW_CAP}$`),
    );
    assert.deepEqual(calls[0].params, [H160]);
  });

  test("refuses an identity no EVM key can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const h160 of [
      "not-an-address",
      "0x1234",
      `0x${"AB".repeat(20)}`,
      7 as unknown as string,
    ]) {
      await assert.rejects(
        store.byH160(h160),
        /Invalid native evm association identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});
