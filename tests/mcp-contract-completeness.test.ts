// ONE PLACE THAT SAYS WHAT A COMPLETE MCP TOOL LOOKS LIKE (#9663).
//
// The 2026-08 sweep found the same shape of defect five times over: a field
// that is part of the published contract, that nothing required, and that
// therefore nobody filled. 773 parameters carried one description between
// them. 1,083 output integers published a range nobody chose. `cursor` was
// accepted and ignored. Each was fixed with its own gate, which is correct --
// a gate belongs next to the thing it guards -- but it left no single answer
// to "what does a new tool have to provide".
//
// This is that answer. Every assertion here is derived from
// listToolDefinitions(), so a tool registered tomorrow is covered tonight
// without anyone remembering to add it -- the same construction the enum and
// `required` gates use, and the reason those two have never gone stale.
//
// WHAT THIS FILE IS NOT. It does not re-check what a focused gate already
// owns: the enum/required enforcement (mcp-schema-enforcement), annotation
// correctness (mcp-tool-annotations), auth declarations
// (mcp-tool-auth-declaration), sentinel bounds and per-parameter
// description/example/format (mcp-input-schema). Duplicating an assertion
// would mean two places to update and one of them silently wrong. This covers
// the tool-LEVEL fields those files leave alone, and states the completeness
// contract in prose for the next person adding a tool.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const tools = () => listToolDefinitions() as Row[];

/** Guards every assertion below: a walker that found nothing passes vacuously. */
function assertFullCatalogue(rows: unknown[]) {
  assert.ok(
    rows.length > 200,
    `expected the full tool catalogue, saw ${rows.length}`,
  );
}

describe("every published tool is contract-complete (#9663)", () => {
  test("declares a name, title and description", () => {
    const all = tools();
    assertFullCatalogue(all);
    const incomplete = all
      .filter(
        (t) =>
          !String(t.name ?? "").trim() ||
          !String(t.title ?? "").trim() ||
          !String(t.description ?? "").trim(),
      )
      .map((t) => String(t.name ?? "<unnamed>"));
    assert.deepEqual(incomplete, []);
  });

  // A description is what an agent reads to decide whether a tool is the right
  // one at all, before it ever looks at a parameter. The floor is deliberately
  // low -- this catches a placeholder, not a short-but-real sentence. The
  // catalogue's median is ~568 characters, so nothing near this bound is
  // accidental.
  test("no tool ships a placeholder description", () => {
    const thin = tools()
      .filter((t) => String(t.description ?? "").trim().length < 80)
      .map((t) => `${t.name} (${String(t.description ?? "").trim().length})`);
    assert.deepEqual(thin, []);
  });

  // #9654 normalises outputSchema, which only matters because every tool has
  // one. The spec makes it optional; this project's contract does not, because
  // a structuredContent response with no schema cannot be validated by the
  // client the spec tells to validate it.
  test("declares an outputSchema, not just an inputSchema", () => {
    const all = tools();
    assertFullCatalogue(all);
    const missing = all
      .filter((t) => !t.inputSchema || !t.outputSchema)
      .map((t) => String(t.name));
    assert.deepEqual(missing, []);
  });

  // The shape the spec recommends for a no-parameter tool, and the one
  // validateToolArguments relies on to reject an unknown key. A tool that
  // omitted it would silently accept anything.
  test("every inputSchema is a closed object", () => {
    const open = tools()
      .filter((t) => {
        const s = t.inputSchema as Row;
        return s?.type !== "object" || s?.additionalProperties !== false;
      })
      .map((t) => String(t.name));
    assert.deepEqual(open, []);
  });

  // #9642. Carried by every tool because it is injected once at MCP_TOOLS
  // construction rather than per tool -- if this fails, that injection has been
  // moved somewhere only the advertise path sees, which is the exact bug the
  // injection point was chosen to prevent.
  test("every tool accepts the intent argument", () => {
    const all = tools();
    assertFullCatalogue(all);
    const missing = all
      .filter((t) => !(t.inputSchema as Row)?.properties?.context)
      .map((t) => String(t.name));
    assert.deepEqual(missing, []);
  });

  // Tool names are the identifier an agent types. The spec's own guidance is
  // 1-128 characters from [A-Za-z0-9_.-]; ours are snake_case throughout, and a
  // stray camelCase or space would be a silent inconsistency in a namespace
  // agents pattern-match against.
  test("tool names are snake_case and unique", () => {
    const names = tools().map((t) => String(t.name));
    const malformed = names.filter((n) => !/^[a-z][a-z0-9_]{0,127}$/.test(n));
    assert.deepEqual(malformed, []);
    assert.equal(
      new Set(names).size,
      names.length,
      "a duplicate name makes one of the two unreachable",
    );
  });
});
