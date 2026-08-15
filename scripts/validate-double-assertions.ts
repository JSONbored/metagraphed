// `x as unknown as T` -- the cast that switches the compiler off entirely.
//
// ## What this is, and why it is separate from validate-boundary-casts
//
// That gate asks a narrower question: is a value read from OUTSIDE this program
// -- a request body, a KV read, a Durable Object's own storage -- given a
// concrete type without being parsed. It is the right question for a boundary.
//
// This one asks about a spelling, anywhere. `a as unknown as B` is not a claim
// about untrusted data; it is a claim that TypeScript has no basis to check,
// because routing through `unknown` erases every relationship between the two
// types. A single `as B` at least fails when `A` and `B` do not overlap. The
// double hop never fails, which is precisely why it accumulates -- and #11339
// found 325 of them, four of which were hiding live defects:
//
//   - two GraphQL resolvers handing their loaders a context with NO artifact
//     reader at all, hidden by a cast that bolted the field on at 33 sites;
//   - `withSpotPrice(row as never)`, which made ANY value satisfy the
//     parameter, so a renamed column would have computed a published price
//     from `undefined`;
//   - a watchdog declaring a bucket's `get` required while its own code
//     guarded for the absence of it;
//   - a rate-limiter lookup that could not tell an unbound binding name from
//     a wrong one, where the wrong one throws mid-request as a 500.
//
// `as never` is included for the same reason, one step worse: it makes a value
// assignable to EVERYTHING, so it also silences the arguments beside it at the
// same call.
//
// ## Why the AST rather than a regex
//
// The same lesson validate-boundary-casts.ts records: the formatter wraps a
// cast across lines the moment its type argument is long, and a gate reading
// source as text goes blind on exactly the sites most worth catching. It also
// lets this skip casts inside comments and strings for free -- a grep for
// `as never` in this repo matches prose like "than as never having reported".
//
// ## The ratchet
//
// `MAX_DOUBLE_ASSERTIONS` may only fall. It is at zero because #11339 drove it
// there; a PR that adds one fails, and a PR that removes one without lowering
// the budget ALSO fails, so the number tracks reality rather than intent.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { repoRoot } from "./lib.ts";

/** The budget, which may only fall. Raising it is not a fix. */
export const MAX_DOUBLE_ASSERTIONS = 0;

/** Directories this repo ships. Tests build fixtures for platform bindings a
 *  suite cannot construct, which is a different problem from this one. */
const SCANNED_DIRS = ["src", "workers"] as const;

export interface DoubleAssertion {
  file: string;
  line: number;
  text: string;
  kind: "unknown-hop" | "never";
}

/** Is this the `unknown` half of an `x as unknown as T` pair? */
function isUnknownAssertion(node: ts.Node): boolean {
  return (
    ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.UnknownKeyword
  );
}

export function findDoubleAssertions(
  relativePath: string,
  source: string,
): DoubleAssertion[] {
  const found: DoubleAssertion[] = [];
  const file = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node)) {
      const line =
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const text = node.getText(file).replace(/\s+/g, " ").slice(0, 120);
      // `x as unknown as T`: the OUTER assertion whose operand is `as unknown`.
      if (isUnknownAssertion(node.expression)) {
        found.push({ file: relativePath, line, text, kind: "unknown-hop" });
      } else if (node.type.kind === ts.SyntaxKind.NeverKeyword) {
        found.push({ file: relativePath, line, text, kind: "never" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

export function scanRepository(): DoubleAssertion[] {
  const found: DoubleAssertion[] = [];
  for (const dir of SCANNED_DIRS) {
    const root = path.join(repoRoot, dir);
    for (const file of walkTypeScript(root)) {
      found.push(
        ...findDoubleAssertions(
          path.relative(repoRoot, file),
          readFileSync(file, "utf8"),
        ),
      );
    }
  }
  return found;
}

function main(): void {
  const found = scanRepository();
  for (const cast of found) {
    console.error(`${cast.file}:${cast.line}  [${cast.kind}]  ${cast.text}`);
  }
  if (found.length > MAX_DOUBLE_ASSERTIONS) {
    console.error(
      `\nvalidate:double-assertions FAILED: ${found.length} double ` +
        `assertion(s), budget ${MAX_DOUBLE_ASSERTIONS}.\n` +
        "Routing through `unknown` (or `never`) erases every relationship the " +
        "compiler could have checked. Fix the TYPE that made it necessary: " +
        "widen an over-strict parameter, narrow with a real guard, or parse " +
        "the value against a schema in schemas-src/.",
    );
    process.exit(1);
  }
  if (found.length < MAX_DOUBLE_ASSERTIONS) {
    console.error(
      `\nvalidate:double-assertions FAILED: ${found.length} remain but the ` +
        `budget is ${MAX_DOUBLE_ASSERTIONS}. Lower MAX_DOUBLE_ASSERTIONS to ` +
        `${found.length} in the same change that removed them.`,
    );
    process.exit(1);
  }
  console.log(
    `validate:double-assertions OK — ${found.length} double assertion(s) ` +
      `(budget ${MAX_DOUBLE_ASSERTIONS}).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
