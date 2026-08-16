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
// `BUDGETS` is per top-level directory and each entry may only fall. A PR that
// adds one fails, and a PR that removes one without lowering the budget ALSO
// fails, so every number tracks reality rather than intent. Four of the five
// areas are at zero; `scripts` ratchets down from where #11368 left it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { repoRoot } from "./lib.ts";

/**
 * The budget per area, which may only fall.
 *
 * `src`, `workers`, `schemas-src` and `packages` are at ZERO and stay there:
 * #11339 and #11361 drove them there, and a regression in any of them is a
 * plain failure rather than a number to negotiate.
 *
 * `scripts` is a RATCHET at its current real count. The remaining sites are
 * mostly third-party shapes -- ajv's plugin interop, GraphQL's type unions, a
 * Durable Object's state -- where the fix is a per-library helper rather than a
 * sweep, so a ceiling that only falls beats pretending the number is zero or
 * exempting the directory entirely. An exemption list stops being read the
 * moment it is longer than a screen (see validate-untyped-db-reads.ts's note);
 * a number cannot hide anything.
 *
 * `tests` is NOT scanned, and that is a judgement rather than an oversight: a
 * unit process cannot construct a `KVNamespace`, `Hyperdrive`,
 * `ExecutionContext` or `R2Bucket`, so there the assertion is the mechanism.
 * The useful discipline for fixtures is to centralise it -- see
 * scripts/lib/worker-env.ts, whose key-checked parameter is what caught four
 * fixtures still setting a binding retired two releases ago.
 */
export const BUDGETS: Readonly<Record<string, number>> = {
  src: 0,
  workers: 0,
  "schemas-src": 0,
  packages: 0,
  scripts: 21,
};

const SCANNED_DIRS = Object.keys(BUDGETS);

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

/** Which budget a finding counts against -- its top-level directory. */
export function areaOf(file: string): string {
  return file.split("/")[0] ?? file;
}

function main(): void {
  const found = scanRepository();
  const counts = new Map<string, number>(
    Object.keys(BUDGETS).map((area) => [area, 0]),
  );
  for (const cast of found) {
    const area = areaOf(cast.file);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const errors: string[] = [];
  for (const [area, budget] of Object.entries(BUDGETS)) {
    const n = counts.get(area) ?? 0;
    if (n > budget) {
      for (const cast of found.filter((c) => areaOf(c.file) === area)) {
        console.error(
          `${cast.file}:${cast.line}  [${cast.kind}]  ${cast.text}`,
        );
      }
      errors.push(
        `${area}: ${n} double assertion(s), budget ${budget}. Routing through ` +
          "`unknown` (or `never`) erases every relationship the compiler could " +
          "have checked. Fix the TYPE that made it necessary: widen an " +
          "over-strict parameter, narrow with a real guard, or parse the value " +
          "against a schema in schemas-src/.",
      );
    } else if (n < budget) {
      // The other half of the ratchet. A budget above the real count is a
      // budget nobody is holding, and the next addition slides in under it.
      errors.push(
        `${area}: ${n} remain but the budget is ${budget}. Lower BUDGETS["${area}"] ` +
          `to ${n} in the same change that removed them.`,
      );
    }
  }
  if (errors.length) {
    console.error(
      `\nvalidate:double-assertions FAILED:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `validate:double-assertions OK — ${Object.entries(BUDGETS)
      .map(([a, b]) => `${a} ${counts.get(a) ?? 0}/${b}`)
      .join(", ")}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
