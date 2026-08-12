// The nullability oracle, and proof that it reports a finding rather than only
// ever reporting zero (#10786).
//
// This epic has now met six CI gates that were green because they were looking
// at nothing, so a gate that reads `rootValue` and the generated schema has to
// be shown reading BOTH: driven with a producer that writes null into a
// non-null field, it must find it; driven with the same producer writing a
// value, it must not.
//
// The program here is SYNTHETIC and tiny. Building the repo's own `ts.Program`
// takes tens of seconds, and the question this file asks is about the matching
// rule, not about the tree. `scripts/validate-nullable-overpromises.ts` runs it
// against the real one on every CI run, which is where the tree is checked.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import ts from "typescript";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from "graphql";
import { findOverPromises } from "../scripts/report-nullable-overpromises.ts";

/** A payload with one non-null number and one that admits null. */
const Card = new GraphQLObjectType({
  name: "Card",
  fields: {
    total: { type: new GraphQLNonNull(GraphQLFloat) },
    optional_total: { type: GraphQLFloat },
    complete: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const Row = new GraphQLObjectType({
  name: "Row",
  fields: { uid: { type: new GraphQLNonNull(GraphQLInt) } },
});

const Listing = new GraphQLObjectType({
  name: "Listing",
  fields: {
    rows: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Row))),
    },
  },
});

const Query = new GraphQLObjectType({
  name: "Query",
  fields: {
    card: { type: new GraphQLNonNull(Card) },
    listing: { type: new GraphQLNonNull(Listing) },
  },
});

/**
 * A one-file program whose `src/graphql.ts` is `source`.
 *
 * The walk finds `rootValue` by name in that exact path, so the double has to
 * live there -- which is itself worth pinning: a rename that made the walk find
 * nothing would otherwise read as "zero over-promises".
 */
function programFor(source: string): ts.Program {
  // The REAL repo root, because the walk resolves a file's identity relative to
  // it -- a double parked under a made-up root reads as "src/graphql.ts is not
  // in the program", which is a throw and not a silent zero, but it is also not
  // the code path under test.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const file = path.join(repoRoot, "src/graphql.ts");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  // The REAL lib, not `noLib`. Without it `Record<string, unknown>` and
  // `Array.prototype.map` do not resolve, every read off the double is `any`,
  // and `any` is exactly what this walk counts as UNDECIDED -- so the suite
  // would have passed by looking at nothing, which is the failure mode it was
  // written to rule out.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === file) return parsed;
      const text = ts.sys.readFile(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    writeFile: () => {},
    getCurrentDirectory: () => repoRoot,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === file || ts.sys.fileExists(name),
    readFile: (name) => (name === file ? source : ts.sys.readFile(name)),
  };
  return ts.createProgram({
    rootNames: [file],
    options: {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
    },
    host,
  });
}

describe("findOverPromises", () => {
  test("a producer writing null into a non-null field is a finding", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { total: data.total ?? null, complete: true };
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.path, "Card.total");
    assert.equal(report.findings[0]!.file, "src/graphql.ts");
  });

  test("the same producer writing the schema's own zero is not", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { total: data.total ?? 0, complete: true };
          },
        };
      `),
      Query,
    );
    assert.deepEqual(report.findings, []);
    assert.equal(report.decided.has("Card.total"), true);
  });

  test("a field the SDL declares nullable may be nulled", () => {
    // The direction matters: this gate exists to stop a producer contradicting
    // its contract, not to stop it answering null where null is the contract.
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { optional_total: data.total ?? null, total: 0, complete: true };
          },
        };
      `),
      Query,
    );
    assert.deepEqual(report.findings, []);
  });

  test("a null in a CONDITIONAL arm is found, not only a `??` right side", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { total: data.total ? 1 : null, complete: true };
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.path, "Card.total");
  });

  test("both arms of a fallback chain are walked, not just the first", () => {
    // `a ?? b` reaches the field with EITHER value, and the degraded arm is
    // always the second one -- checking only the first would look at the happy
    // path, which is the failure mode this whole issue is about.
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { total: 1, complete: true } ?? { total: null, complete: true };
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
  });

  test("a list item built in `.map` is checked against the ELEMENT type", () => {
    const report = findOverPromises(
      programFor(`
        const rows: Record<string, unknown>[] = [];
        const rootValue = {
          listing() {
            return { rows: rows.map((row) => ({ uid: row.uid ?? null })) };
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.path, "Row.uid");
  });

  test("a local card builder's returns answer to the field that calls it", () => {
    // The zeroed-card shapes live in helpers, not inline, so a walk that
    // stopped at the call would miss exactly the arm it exists to read.
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        function cardNode() {
          return { total: data.total ?? null, complete: true };
        }
        const rootValue = {
          card() {
            return cardNode();
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.path, "Card.total");
  });

  test("one dirty write disqualifies a field its clean sibling would prove", () => {
    // `decided` is evidence that feeds report:graphql-tightening-evidence. A
    // field written cleanly on the happy path and nulled on the degraded one is
    // NOT proved -- the degraded arm is the question.
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        function cardNode() {
          return { total: data.total ?? null, complete: true };
        }
        const rootValue = {
          card() {
            return data.hot ? { total: 1, complete: true } : cardNode();
          },
        };
      `),
      Query,
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.decided.has("Card.total"), false);
  });

  test("a spread is reported UNDECIDED rather than counted clean", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { ...data, complete: true };
          },
        };
      `),
      Query,
    );
    assert.deepEqual(report.findings, []);
    assert.equal(report.undecided.length, 1);
    assert.equal(report.undecided[0]!.reason, "spread");
    // No declaration covers Card, so nothing counts as a passthrough -- and
    // every real declared owner is stale against this one-field double, which
    // is the shrink-only rule doing its job, not noise.
    assert.deepEqual(report.passthroughs, []);
  });

  test("a spread on a DECLARED owner is a counted passthrough, not undecided (#10867)", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const rootValue = {
          card() {
            return { ...data, complete: true };
          },
        };
      `),
      Query,
      { Card: "under test: the guarantee lives in this test's assertions" },
    );
    assert.deepEqual(report.findings, []);
    assert.deepEqual(
      report.undecided,
      [],
      "a declared spread must not stay undecided",
    );
    assert.equal(report.passthroughs.length, 1);
    assert.equal(report.passthroughs[0]!.path, "Card");
    assert.deepEqual(report.stalePassthroughs, []);
  });

  test("a literal fallback at a contract-field write is CENSUSED (#10868)", () => {
    const report = findOverPromises(
      programFor(`
        const data: Record<string, unknown> = {};
        const other: number | undefined = undefined;
        const rootValue = {
          card() {
            return {
              total: (data.total as number | undefined) ?? 0,
              optional_total: (data.maybe as number | undefined) ?? other ?? null,
              complete: (data.complete as boolean | undefined) || false,
            };
          },
        };
      `),
      Query,
    );
    // `?? 0` and `|| false` state defaults the schema does not; `?? other`
    // defers to another VALUE and states nothing, so only the trailing
    // `?? null` of that chain is recorded.
    assert.deepEqual(
      report.fallbacks.map((site) => [
        site.path,
        site.operator,
        site.fallback,
        site.fieldNullable,
      ]),
      [
        ["Card.total", "??", "0", false],
        ["Card.optional_total", "??", "null", true],
        ["Card.complete", "||", "false", false],
      ],
    );
  });

  test("a declared passthrough with no matching spread is STALE (#10867)", () => {
    const report = findOverPromises(
      programFor(`
        const rootValue = {
          card() {
            return { total: 1, optional_total: null, complete: true };
          },
        };
      `),
      Query,
      { Card: "the spread this excused is gone" },
    );
    assert.deepEqual(
      report.stalePassthroughs,
      ["Card"],
      "an excuse must not outlive what it excused",
    );
  });

  test("a root field `rootValue` does not answer is simply not walked", () => {
    const report = findOverPromises(programFor(`const rootValue = {};`), Query);
    assert.equal(report.fields, 0);
    assert.deepEqual(report.findings, []);
  });

  test("a file with no rootValue throws rather than reporting zero", () => {
    assert.throws(
      () => findOverPromises(programFor(`const other = {};`), Query),
      /declares no rootValue literal/,
    );
  });
});
