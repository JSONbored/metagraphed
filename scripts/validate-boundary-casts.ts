// Every read of an untrusted boundary is PARSED, not cast (#11194).
//
// ## What this gate is for
//
// `const body = (await request.json()) as { sessionId: string }` compiles, and
// it is a lie. The value came from outside this program -- a request body,
// another Worker's response, a `JSON.parse`, a Durable Object's own storage
// written by a previous deploy -- and TypeScript checked nothing about it. The
// failure is never a crash at the cast: it is `undefined` flowing into a Set,
// a `Number` that was a string reaching a comparison that is false for every
// threshold, or a stored string handed to `new Set(...)` and iterated BY
// CHARACTER. Each of those produces a component that looks alive and does
// nothing, which is the exact failure this repo keeps paying to find.
//
// The rule is not "no casts". It is: **at a boundary, either parse it or admit
// you do not know what it is.** `as unknown`, `as Record<string, unknown>` and
// friends admit it -- every field must still be narrowed before use, and the
// compiler enforces that. A concrete type does not.
//
// ## Why the AST, not a regex
//
// Measured while writing this: a regex over the same tree missed sites it could
// not see through -- `(await env.KV.get(k, "json")) as T`, which the formatter
// wraps across three lines, and any cast whose type argument contains a
// newline. A gate that reads source as text goes blind the moment the formatter
// moves one, which is the same lesson as #10914's silent revert.
//
// The AST also makes the JUDGEMENT possible at all. Deciding whether `as Row`
// is a claim or an admission means resolving `Row`, and 113 of the sites this
// found were `Record<string, unknown>` under an alias -- the most common
// correct pattern in the repo. A gate that flagged those would have grown an
// exemption list within a week, and an exemption list is the thing that hides
// what it names.
//
// ## The ratchet
//
// `MAX_BOUNDARY_CASTS` may only ever fall. It is not a target to sit at: it is
// the proof that the number cannot quietly grow back while nobody is counting.
// A PR that adds one fails; a PR that removes one and forgets to lower the
// budget ALSO fails, so the number tracks reality rather than intent.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { repoRoot } from "./lib.ts";

/**
 * The budget, which may only fall.
 *
 * Lower it in the same PR that removes a site. Raising it is not a fix.
 */
export const MAX_BOUNDARY_CASTS = 0;

/** Directories whose code serves or consumes untrusted input. */
const SCANNED_DIRS = ["src", "workers"] as const;

/**
 * Calls that return a value from outside this program.
 *
 * Matched on the CALLEE NAME, deliberately, rather than on the receiver: the
 * receiver is `request`, `upstream`, `res`, `this.state.storage`, `env.KV` and
 * a dozen other spellings, and enumerating them is how a check ends up
 * covering the sites that existed the day it was written.
 */
const BOUNDARY_CALLS = new Set([
  "json", // Request/Response bodies -- ours and everyone else's
  "parse", // JSON.parse, narrowed to that receiver below
]);

/**
 * Storage reads, which are a boundary for a reason easy to miss: the value was
 * written by a PREVIOUS deploy of this same code, so its shape is whatever the
 * schema was then, not what the types say now.
 */
const STORAGE_RECEIVERS = new Set(["storage", "KV", "METAGRAPH_CONTROL"]);

export interface BoundaryCast {
  file: string;
  line: number;
  text: string;
}

/**
 * Does this type annotation ADMIT that the value is unvalidated?
 *
 * `unknown`, `any`, and any object type whose every member is one of those, at
 * any depth reachable by the compiler's own syntax -- so
 * `Record<string, unknown>`, `{ sessionId?: unknown }` and
 * `Array<Record<string, unknown>>` all pass, while `{ sessionId: string }`
 * does not. A union passes only if EVERY arm does: `string | unknown` collapses
 * to unknown anyway, but `{a: string} | unknown` would be a concrete claim on
 * one arm and must not slip through.
 *
 * `null` and `undefined` arms are ignored rather than counted: `as T | null` is
 * the same claim as `as T` about the non-null case, and treating the null arm
 * as an admission would let every concrete cast through by adding `| null`.
 */
export function admitsUnknown(
  node: ts.TypeNode,
  /**
   * Repo-wide `type X = …` declarations, so `as Row` is judged by what `Row`
   * IS rather than by its spelling. Without this the gate flags 113 sites that
   * are `Record<string, unknown>` under an alias -- the single most common
   * correct pattern in this repo -- and a gate that fires on correct code is a
   * gate that gets an exemption list bolted onto it.
   *
   * A name resolves to an admission only when EVERY declaration of it agrees.
   * One concrete declaration anywhere makes the name concrete: two files may
   * legitimately both call something `Row`, and the safe reading of an
   * ambiguous name is the strict one.
   */
  aliases: ReadonlyMap<string, boolean> = new Map(),
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    node.kind === ts.SyntaxKind.AnyKeyword
  ) {
    return true;
  }
  const recurse = (child: ts.TypeNode) => admitsUnknown(child, aliases, seen);
  if (ts.isParenthesizedTypeNode(node)) return recurse(node.type);
  if (ts.isUnionTypeNode(node)) {
    const meaningful = node.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.NullKeyword &&
        !(
          ts.isLiteralTypeNode(t) &&
          t.literal.kind === ts.SyntaxKind.NullKeyword
        ) &&
        t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    return meaningful.length > 0 && meaningful.every(recurse);
  }
  if (ts.isTypeReferenceNode(node)) {
    // `Record<string, unknown>`, `Array<unknown>`, `Promise<Row>` -- the claim
    // is about the LAST type argument, which is the element/value in every
    // generic this repo casts to.
    const args = node.typeArguments;
    if (args && args.length > 0) return recurse(args[args.length - 1]);
    // A bare name: resolve it through the alias map, guarding the cycle a
    // self-referential alias would otherwise spin on.
    const name = node.typeName.getText();
    if (seen.has(name)) return false;
    return aliases.get(name) ?? false;
  }
  if (ts.isArrayTypeNode(node)) return recurse(node.elementType);
  // `as typeof body`, where `body` was declared `let body: { x?: unknown }`.
  // The idiom names the annotation instead of repeating it, so the claim is
  // whatever that annotation says -- resolved through the same alias map,
  // keyed by `typeof <name>` so it cannot collide with a real type name.
  if (ts.isTypeQueryNode(node)) {
    return aliases.get(`typeof ${node.exprName.getText()}`) ?? false;
  }
  // `{ sessionId?: unknown; netuid?: unknown }` -- an object literal type whose
  // every member is a property with an unknown-admitting type.
  if (ts.isTypeLiteralNode(node)) {
    return (
      node.members.length > 0 &&
      node.members.every(
        (member) =>
          ts.isPropertySignature(member) &&
          member.type !== undefined &&
          recurse(member.type),
      )
    );
  }
  return false;
}

/**
 * Every `type X = …` in the scanned tree, as "does X admit unknown".
 *
 * Built in one pass before any file is judged, because an alias is routinely
 * declared in one module and cast to in another (`type Row` lives in
 * src/mcp-list-query.ts and is imported by a dozen readers).
 */
export function collectTypeAliases(
  sources: ReadonlyArray<{ path: string; text: string }>,
): Map<string, boolean> {
  const declarations = new Map<string, ts.TypeNode[]>();
  for (const { path: filePath, text } of sources) {
    const file = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.ESNext,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        declarations.set(name, [...(declarations.get(name) ?? []), node.type]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Resolved in two passes so an alias defined in terms of another alias
  // (`type Rows = Row[]`) sees the first pass's answer. Two is enough for the
  // depth this repo actually uses; anything deeper stays strict, which is the
  // safe direction.
  const resolved = new Map<string, boolean>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [name, nodes] of declarations) {
      resolved.set(
        name,
        nodes.every((node) => admitsUnknown(node, resolved, new Set([name]))),
      );
    }
  }
  return resolved;
}

/** Is this expression a read from outside the program? */
function isBoundaryRead(expr: ts.Expression): boolean {
  let node: ts.Expression = expr;
  // `(await x.json())` and `(x.json())` are the same read.
  while (true) {
    if (ts.isAwaitExpression(node)) node = node.expression;
    else if (ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (name === "parse") {
    // JSON.parse only. `zodSchema.parse(x)` is the opposite of this problem.
    return (
      ts.isIdentifier(callee.expression) && callee.expression.text === "JSON"
    );
  }
  if (BOUNDARY_CALLS.has(name)) return true;
  if (name === "get" || name === "list") {
    // `this.state.storage.get(...)`, `env.KV.get(k, "json")`.
    const receiver = callee.expression;
    const receiverName = ts.isPropertyAccessExpression(receiver)
      ? receiver.name.text
      : ts.isIdentifier(receiver)
        ? receiver.text
        : "";
    return STORAGE_RECEIVERS.has(receiverName);
  }
  return false;
}

/** Every concrete cast over a boundary read in one file. */
export function findBoundaryCasts(
  relativePath: string,
  source: string,
  aliases: ReadonlyMap<string, boolean> = new Map(),
): BoundaryCast[] {
  const found: BoundaryCast[] = [];
  const file = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  // Annotated variables in THIS file, so `as typeof body` is judged by what
  // `body` was declared to be. Per file, never repo-wide: `body` is declared in
  // a dozen modules with a dozen meanings, and one concrete `const body:
  // R2SqlBody` would otherwise make every other module's
  // `let body: { x?: unknown }` read as a concrete claim.
  const locals = new Map<string, boolean>(aliases);
  const collectLocals = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.type
    ) {
      const key = `typeof ${node.name.text}`;
      const admits = admitsUnknown(node.type, aliases);
      // Same rule as the alias map: one concrete declaration of a name makes
      // the name concrete, so an ambiguous `body` is read strictly.
      locals.set(key, (locals.get(key) ?? true) && admits);
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(file);

  const visit = (node: ts.Node): void => {
    if (
      ts.isAsExpression(node) &&
      !admitsUnknown(node.type, locals) &&
      isBoundaryRead(node.expression)
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push({
        file: relativePath,
        line: line + 1,
        text: node.getText(file).replace(/\s+/g, " ").slice(0, 120),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every `.ts` under `dir`, excluding generated ambient declarations. */
function walkTypeScript(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export function scanRepository(): BoundaryCast[] {
  const sources = SCANNED_DIRS.flatMap((dir) =>
    walkTypeScript(path.join(repoRoot, dir)).map((absolute) => ({
      path: path.relative(repoRoot, absolute),
      text: readFileSync(absolute, "utf8"),
    })),
  );
  const aliases = collectTypeAliases(sources);
  const found: BoundaryCast[] = [];
  for (const { path: relative, text } of sources) {
    found.push(...findBoundaryCasts(relative, text, aliases));
  }
  return found.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

function main(): void {
  const found = scanRepository();
  for (const cast of found) {
    console.error(`${cast.file}:${cast.line}  ${cast.text}`);
  }
  if (found.length > MAX_BOUNDARY_CASTS) {
    console.error(
      `\nvalidate:boundary-casts FAILED: ${found.length} concrete cast(s) over ` +
        `an untrusted boundary, budget ${MAX_BOUNDARY_CASTS}.\n` +
        "Parse the value against a schema in schemas-src/, or cast to " +
        "`unknown` and narrow every field before use.",
    );
    process.exit(1);
  }
  // The other half of the ratchet. A budget above the real count is a budget
  // nobody is holding, and the next addition slides in under it unnoticed.
  if (found.length < MAX_BOUNDARY_CASTS) {
    console.error(
      `\nvalidate:boundary-casts FAILED: ${found.length} cast(s) remain but the ` +
        `budget is ${MAX_BOUNDARY_CASTS}. Lower MAX_BOUNDARY_CASTS to ` +
        `${found.length} in the same change that removed them.`,
    );
    process.exit(1);
  }
  console.log(
    `validate:boundary-casts OK — ${found.length} concrete cast(s) over an ` +
      `untrusted boundary (budget ${MAX_BOUNDARY_CASTS}).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
