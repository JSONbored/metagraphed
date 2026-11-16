// The process-profile manifests (infra#882): the public serving composition
// declares exactly the user-state relations it writes; the trusted producer
// composition keeps today's full write surface. What this pins: the serving
// write set stays a subset of the declared relations, the derived access modes
// are right (a no-write source is "read", which makes its transactions READ
// ONLY), and the trusted default is byte-compatible with the pre-#882 shape so
// existing compositions change nothing.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  NATIVE_SERVING_WRITES,
  NATIVE_SOURCE_RELATIONS,
  nativeSourceDefinitions,
  type NativeSchemaName,
} from "../src/native-source-manifest.ts";

const owners = {
  app: "owner",
  auth: "owner",
  jobs: "owner",
  realtime: "owner",
  retained: "owner",
  search: "owner",
};

test("every declared serving write is a declared relation of its schema", () => {
  for (const [schema, writes] of Object.entries(NATIVE_SERVING_WRITES)) {
    const relations = NATIVE_SOURCE_RELATIONS[schema as NativeSchemaName] ?? [];
    const unknown = writes.filter((write) => !relations.includes(write));
    assert.deepEqual(
      unknown,
      [],
      `${schema} serving writes name relations the schema does not declare`,
    );
  }
});

test("the serving profile reads everywhere and writes only the pinned user state", () => {
  const definitions = nativeSourceDefinitions(owners, "serving");
  for (const definition of definitions) {
    const schema =
      definition.name === "retained_views"
        ? ([] as readonly string[])
        : NATIVE_SERVING_WRITES[definition.schema as NativeSchemaName];
    if (schema.length === 0) {
      assert.equal(definition.access, "read", definition.name);
      assert.equal(definition.writable, undefined, definition.name);
    } else {
      assert.equal(definition.access, "read-write", definition.name);
      assert.deepEqual(definition.writable, schema, definition.name);
    }
  }
  // The split is real: serving reads retained history and search but writes
  // neither, and the app schema's write set is a strict subset.
  const app = definitions.find((definition) => definition.name === "app")!;
  assert.ok(app.writable!.length < app.relations.length);
  for (const readOnly of ["retained", "retained_views", "search"])
    assert.equal(
      definitions.find((definition) => definition.name === readOnly)!.access,
      "read",
    );
});

test("the trusted default is unchanged: full write surface, no writable pin", () => {
  for (const explicit of [
    nativeSourceDefinitions(owners),
    nativeSourceDefinitions(owners, "trusted"),
  ]) {
    for (const definition of explicit) {
      assert.equal(
        definition.access,
        definition.name === "retained_views" ? "read" : "read-write",
        definition.name,
      );
      assert.equal(definition.writable, undefined, definition.name);
    }
  }
});
