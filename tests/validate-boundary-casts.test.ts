// The boundary-cast gate's own judgement (#11194).
//
// This gate's whole value is the LINE it draws -- concrete claim vs admission --
// and that line is invisible from the repository count alone: a gate reporting
// zero is indistinguishable from a gate that finds nothing. So the cases below
// are fed to it directly, both the ones it must catch and the ones it must let
// through. The second set matters more: this repo's most common correct pattern
// is `as Row` where `type Row = Record<string, unknown>`, and a gate that
// flagged those would have been given an exemption list within a week.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  collectTypeAliases,
  findBoundaryCasts,
} from "../scripts/validate-boundary-casts.ts";

/** Judge one snippet, with `type Row = Record<string, unknown>` in scope. */
function scan(source: string): string[] {
  const sources = [
    { path: "aliases.ts", text: "type Row = Record<string, unknown>;\n" },
    { path: "snippet.ts", text: source },
  ];
  const aliases = collectTypeAliases(sources);
  return findBoundaryCasts("snippet.ts", source, aliases).map((c) => c.text);
}

describe("a concrete claim over a boundary read is caught", () => {
  test("a request body cast to a shape", () => {
    assert.equal(
      scan("const b = (await request.json()) as { sessionId: string };").length,
      1,
    );
  });

  test("a response body, a JSON.parse, and a storage read", () => {
    assert.equal(
      scan(`
        const a = (await upstream.json()) as { triggers: string[] };
        const b = JSON.parse(raw) as { head: string };
        const c = (await this.state.storage.get("k")) as { seq: number };
        const d = (await env.KV.get("k", "json")) as { flag: boolean };
      `).length,
      4,
    );
  });

  test("`| null` does not launder a concrete claim", () => {
    // Otherwise every cast in the repo could be exempted by adding two
    // characters, which is not a rule -- it is a spelling.
    assert.equal(
      scan("const b = (await res.json()) as { id: string } | null;").length,
      1,
    );
  });

  test("a union with one concrete arm is concrete", () => {
    assert.equal(
      scan("const b = (await res.json()) as unknown | { id: string };").length,
      1,
    );
  });
});

describe("an admission is not a claim, and is left alone", () => {
  test("unknown, and Record<string, unknown> under an alias", () => {
    assert.deepEqual(
      scan(`
        const a = (await request.json()) as unknown;
        const b = (await res.json()) as Row;
        const c = (await res.json()) as Record<string, unknown>;
        const d = (await res.json()) as Row[];
        const e = (await res.json()) as Array<Record<string, unknown>>;
      `),
      [],
    );
  });

  test("an object type whose every member is unknown", () => {
    assert.deepEqual(
      scan(
        "const b = (await request.json()) as { sessionId?: unknown; netuid?: unknown };",
      ),
      [],
    );
  });

  test("`as typeof body`, resolved through the variable's own annotation", () => {
    assert.deepEqual(
      scan(`
        let body: { buckets?: unknown };
        body = (await request.json()) as typeof body;
      `),
      [],
    );
  });

  test("the SAME name declared concretely elsewhere in the file reads strictly", () => {
    // Fail-closed on ambiguity: two functions in one module may both call a
    // local `body`, and the safe reading of a name that means two things is
    // the strict one.
    assert.equal(
      scan(`
        const body: { id: string } = seed;
        let body: { buckets?: unknown };
        body = (await request.json()) as typeof body;
      `).length,
      1,
    );
  });
});

describe("what is not a boundary read at all", () => {
  test("a cast over a plain value", () => {
    assert.deepEqual(scan("const a = value as { id: string };"), []);
  });

  test("a schema's own .parse(), which is the opposite of the problem", () => {
    assert.deepEqual(
      scan("const a = MySchema.parse(input) as { id: string };"),
      [],
    );
  });

  test("a `get` on something that is not a store", () => {
    assert.deepEqual(
      scan('const a = map.get("k") as { id: string };'),
      [],
      "a Map read is in-process; its contents are this program's own",
    );
  });
});
