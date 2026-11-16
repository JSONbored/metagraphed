// The capability-split validation arms (infra#882), driven through a stub
// store so the branch logic is pinned without a database; the real-grant
// behavior is qualified separately in tests/native-capability-split.pg18.ts.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  verifyNativeSourceCapabilities,
  type NativeSourceDefinition,
  type NativeStore,
} from "../src/native-api-process.ts";
import { assertNativeSequencePrivileges } from "../src/native-source-manifest.ts";
import type { NativeSource } from "../src/native-api-process.ts";

interface PrivilegeRow {
  relation: string;
  owner: string;
  schema_usable: boolean;
  readable: boolean;
  insertable: boolean;
  updatable: boolean;
  deletable: boolean;
}

const row = (
  relation: string,
  writes: boolean,
  overrides: Partial<PrivilegeRow> = {},
): PrivilegeRow => ({
  relation,
  owner: "owner",
  schema_usable: true,
  readable: true,
  insertable: writes,
  updatable: writes,
  deletable: writes,
  ...overrides,
});

function stubStore(rows: PrivilegeRow[], calls: unknown[][] = []) {
  return {
    read: {
      async query<Row>(_text: string, values: unknown[] = []) {
        calls.push(values);
        return rows as Row[];
      },
      async first() {
        return null;
      },
    },
  } as unknown as NativeStore;
}

const definition = (
  overrides: Partial<NativeSourceDefinition> = {},
): NativeSourceDefinition => ({
  name: "fixture",
  schema: "app",
  owner: "owner",
  relations: ["user_state", "history"],
  access: "read-write",
  writable: ["user_state"],
  ...overrides,
});

test("a write declaration outside the capability is refused before any query", async () => {
  const calls: unknown[][] = [];
  const store = stubStore([], calls);
  for (const broken of [
    definition({ access: "read", writable: ["user_state"] }),
    definition({ writable: [] }),
    definition({ writable: ["user_state", "undeclared"] }),
  ])
    await assert.rejects(
      verifyNativeSourceCapabilities(store, [broken]),
      /writes outside its capability/,
    );
  assert.equal(calls.length, 0, "validation must precede the privilege read");
});

test("privileges are required exactly where writes are declared", async () => {
  // Write grants only on the declared relation: ready.
  await verifyNativeSourceCapabilities(
    stubStore([row("user_state", true), row("history", false)]),
    [definition()],
  );
  // The pinned subset is the requirement even when broader grants exist.
  await verifyNativeSourceCapabilities(
    stubStore([row("user_state", true), row("history", true)]),
    [definition()],
  );
  // A declared write without its grant names the relation.
  await assert.rejects(
    verifyNativeSourceCapabilities(
      stubStore([row("user_state", true), row("history", false)]),
      [definition({ writable: ["user_state", "history"] })],
    ),
    /not ready for history/,
  );
  // Absent `writable` on read-write still means every relation (trusted).
  await assert.rejects(
    verifyNativeSourceCapabilities(
      stubStore([row("user_state", true), row("history", false)]),
      [definition({ writable: undefined })],
    ),
    /not ready for history/,
  );
  // A read source needs no write privilege anywhere.
  await verifyNativeSourceCapabilities(
    stubStore([row("user_state", false), row("history", false)]),
    [definition({ access: "read", writable: undefined })],
  );
});

test("sequence readiness follows the declared write set", async () => {
  const calls: unknown[][] = [];
  const base = {
    ...definition(),
    ...stubStore([], calls),
  } as unknown as NativeSource;
  const sources = new Map<string, NativeSource>();
  for (const name of [
    "app",
    "auth",
    "jobs",
    "realtime",
    "retained",
    "retained_views",
    "search",
  ])
    sources.set(name, {
      ...base,
      name,
      // A hand-built read-write source with an empty write set is skipped
      // without a query; the app source pins that the query is bounded to
      // the declared writes, not the whole relation list.
      ...(name === "app"
        ? { writable: ["user_state"] }
        : name === "auth"
          ? { access: "read-write" as const, writable: [] }
          : { access: "read" as const, writable: undefined }),
    });
  await assertNativeSequencePrivileges(sources);
  assert.deepEqual(calls, [["app", ["user_state"]]]);
});
