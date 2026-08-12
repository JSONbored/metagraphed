// Producers that write null into a field the contract declares NON-NULL
// (#10786).
//
// ## Why production cannot answer this
//
// `report:graphql-tightening-evidence` asks production and reports "0 answered
// NULL". That is true and it is not proof: PRODUCTION IS NOT DEGRADED WHEN YOU
// ASK IT. Every finding this issue names lives on a cold-tier or zeroed-card
// path -- the arm taken when a store is unreachable -- and a probe against a
// healthy deployment never reaches one. The evidence covers the happy path and
// says so.
//
// ## The two sides of the join, and why each is the one it is
//
// EXPECTED is `buildGeneratedSchema()`: the schema the Zod components build,
// which is what the #10214 cutover installs and therefore what graphql-js will
// enforce AT EXECUTION -- one null in a non-null field nulls the whole
// surrounding object and attaches an error. Reading the PUBLISHED SDL instead
// would ask a weaker question and get a flattering answer: the hand-written SDL
// is looser than the components in 289 places, which is the entire reason that
// cutover is blocked on this issue. It is also the contract REST and MCP serve,
// so a `.nullable()` decided here fixes all three surfaces at once.
//
// ACTUAL is the TypeScript checker, over `rootValue` -- the object graphql-js
// resolves the root fields against. The walk descends the producer and the
// contract in lockstep: root field -> the generated `Query` field of that name
// -> the object literal the resolver returns -> that type's field of that name,
// through conditionals, `??`/`||` arms, array literals, `.map(row => ({...}))`
// callbacks, and calls to the local card builders where the zeroed shapes live.
// At every property it asks the checker whether the written expression can
// produce null, and the schema whether the field admits one.
//
// Nothing is matched by name across components and nothing is inferred from a
// key set. An earlier spelling of this report joined `?? null` sites to
// `openapi.json` by the enclosing literal's keys and reported 61 findings; the
// join was wrong twice over -- it read a REST component for an MCP producer,
// and it treated an OPTIONAL OpenAPI property (absent from `required`) as
// non-null. Every finding here is anchored to the exact field the executor
// will read.
//
// ## What it does not claim
//
// A property whose expression the checker types as `any`, or whose target this
// walk cannot resolve (a spread of an untyped bag, a field the generated schema
// does not declare), is counted as UNDECIDED rather than clean -- and since
// #10867 an undecided SPREAD fails the validator unless it carries a
// `DECLARED_PASSTHROUGHS` entry naming where its guarantee actually lives.
// The honest edge of the measurement stays visible either way; it is no
// longer allowed to be a quiet number.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  isObjectType,
} from "graphql";
import type { GraphQLOutputType } from "graphql";
import { buildGeneratedSchema } from "../schemas-src/graphql/build-schema.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";
import { createRepoProgram } from "./report-type-duplicates.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The object graphql-js resolves the root fields against. */
const ROOT_VALUE_FILE = "src/graphql.ts";
const ROOT_VALUE_NAME = "rootValue";
const OPENAPI_PATH = "public/metagraph/openapi.json";

/** One field a producer nulls against a declaration that does not admit null. */
export interface OverPromise {
  /** `SubnetYield.total_stake_alpha` -- the field graphql-js executes. */
  path: string;
  file: string;
  line: number;
}

/** A property this walk could not decide, and why. */
export interface Undecided {
  path: string;
  file: string;
  line: number;
  reason: "spread" | "undeclared-field" | "any-typed";
}

/** A declared artifact/builder passthrough the walk counts, not skips. */
export interface Passthrough {
  path: string;
  file: string;
  line: number;
}

const ARTIFACT_PASSTHROUGH =
  "an artifact passthrough: the spread republishes a document a typed " +
  "builder produced against the SAME Zod component this GraphQL type was " +
  "generated from (one schema source, #10214), so the non-null guarantee is " +
  "tsc's on the build side; graphql-js re-enforces it at execution, which " +
  "also covers the residual this walk cannot -- a stored artifact predating " +
  "a tightening.";

/**
 * Spreads this walk counts as DECIDED-ELSEWHERE, each with the evidence.
 *
 * The walker cannot type a spread of parsed JSON, and chasing it
 * interprocedurally dead-ends at `readArtifact`'s `unknown` -- deciding the
 * fields off the component there would judge the schema against itself
 * (#10867). The guarantee these sites rely on is real and lives in two other
 * compilations: the artifact BUILDER is tsc-checked against the same Zod
 * component the GraphQL type derives from, and the executor enforces the
 * published nullability on every request. An entry here declares exactly
 * that, per owner type; `validate:nullable-overpromises` FAILS on a spread
 * with no entry and on an entry with no spread, so the list can only
 * describe what exists.
 */
export const DECLARED_PASSTHROUGHS: Readonly<Record<string, string>> = {
  // subnetNode spreads the subnet row the subnets/detail artifacts carry.
  Subnet: ARTIFACT_PASSTHROUGH,
  // The shared list composer lifts envelope fields off the list artifact.
  SubnetList: ARTIFACT_PASSTHROUGH,
  // validatorNode spreads metagraph rows that deliberately carry more
  // columns than the type exposes; the declared columns are the builder's.
  Validator: ARTIFACT_PASSTHROUGH,
  // providerNode spreads the ProvidersArtifact row.
  Provider: ARTIFACT_PASSTHROUGH,
  // Each window's delta object off the trajectory artifact's deltas record.
  SubnetTrajectoryDelta: ARTIFACT_PASSTHROUGH,
  // loadSurfacesList's envelope, with `surfaces` renamed to `items` beside
  // the spread.
  SurfaceList: ARTIFACT_PASSTHROUGH,
  // loadChangelog's document, with the coverage_delta lift beside it.
  Changelog: ARTIFACT_PASSTHROUGH,
  // The evidence ledger document behind the incidents filter.
  GlobalIncidents: ARTIFACT_PASSTHROUGH,
  // buildGlobalHealth's rollup -- built IN THIS COMPILATION by
  // src/global-operational-health.ts, so the guarantee is local tsc; the
  // spread is still untypeable to the walker because `(result.global || {})`
  // widens through the fallback arm.
  GlobalHealth:
    "a passthrough of buildGlobalHealth's rollup, typed in this compilation " +
    "(src/global-operational-health.ts); the `|| {}` fallback arm widens the " +
    "spread past what the walker can read, and the executor enforces the " +
    "published nullability on every request either way.",
  // The shared stake-quote calculator's quote, typed in this compilation.
  SubnetStakeQuote:
    "a passthrough of the shared stake-quote calculator's `quote`, typed in " +
    "this compilation; `schema_version` is written beside the spread and the " +
    "executor enforces the published nullability on every request.",
};

export interface NullabilityReport {
  findings: OverPromise[];
  undecided: Undecided[];
  /** Declared passthrough spreads, counted against `DECLARED_PASSTHROUGHS`. */
  passthroughs: Passthrough[];
  /** Declared passthrough owners the walk never saw a spread on -- stale. */
  stalePassthroughs: string[];
  /** Property writes compared against a declared field. */
  examined: number;
  /** Root fields reached from `rootValue`. */
  fields: number;
  /**
   * Every `Type.field` this walk DECIDED, in the schema-diff's own spelling.
   *
   * The distinction that makes this usable as evidence: a field in here and
   * not in `findings` is one the compiler has PROVED no producer can null --
   * which is a stronger statement than a probe's silence, and it is the only
   * kind of statement available for the degraded arms. A field absent from
   * both sets is one the walk never reached, and the honest answer there is
   * still "no evidence".
   */
  decided: Set<string>;
}

function relative(file: ts.SourceFile): string {
  return path.relative(repoRoot, file.fileName).split(path.sep).join("/");
}

function lineOf(node: ts.Node): number {
  const source = node.getSourceFile();
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Does this type produce `null`, or the `undefined` that reaches a field as one? */
function producesNull(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(producesNull);
  return (
    (type.flags &
      (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !==
    0
  );
}

/** `any` answers every question, so it answers none of them. */
function isAny(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

/** The object type behind a field, past its non-null and list wrappers. */
function objectBehind(type: GraphQLOutputType): GraphQLObjectType | null {
  let current: GraphQLOutputType = type;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList) {
    current = current.ofType as GraphQLOutputType;
  }
  return isObjectType(current) ? current : null;
}

/** The `rootValue` object literal, or a throw -- an empty walk proves nothing. */
function rootValueLiteral(program: ts.Program): ts.ObjectLiteralExpression {
  const source = program
    .getSourceFiles()
    .find((candidate) => relative(candidate) === ROOT_VALUE_FILE);
  if (!source) throw new Error(`${ROOT_VALUE_FILE} is not in the program.`);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === ROOT_VALUE_NAME &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`${ROOT_VALUE_FILE} declares no ${ROOT_VALUE_NAME} literal.`);
}

/** Strip the wrappers that do not change which value reaches the field. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

/**
 * A function-like node that HAS a body.
 *
 * `ts.isFunctionLike` narrows to `SignatureDeclaration`, which does not -- an
 * overload signature is function-like and has nothing to walk.
 */
function bodiedFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Every `return` in this function's OWN body -- not a nested closure's. */
function ownReturns(body: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression)
      out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

export function findOverPromises(
  program: ts.Program,
  queryType: GraphQLObjectType,
  // Injectable so a test can drive the ratchet with a MUTATED declaration --
  // a gate only ever run against a passing tree proves it runs, not that it
  // can fail (the same rule buildGeneratedSchema's declarations follow).
  declaredPassthroughs: Readonly<
    Record<string, string>
  > = DECLARED_PASSTHROUGHS,
): NullabilityReport {
  const checker = program.getTypeChecker();
  const findings: OverPromise[] = [];
  const undecided: Undecided[] = [];
  const passthroughs: Passthrough[] = [];
  const decided = new Set<string>();
  let examined = 0;
  let fields = 0;

  /** Guards mutual recursion between a card builder and its own helpers. */
  const seen = new Set<string>();

  /**
   * Check one expression against the object type whose shape it fills.
   *
   * Only object types are followed: a leaf's nullability is decided at the
   * property that writes it, by its own field declaration.
   */
  const descend = (expression: ts.Expression, expected: GraphQLObjectType) => {
    const node = unwrap(expression);
    if (ts.isObjectLiteralExpression(node)) {
      checkLiteral(node, expected);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      descend(node.whenTrue, expected);
      descend(node.whenFalse, expected);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      descend(node.left, expected);
      descend(node.right, expected);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) {
        if (!ts.isSpreadElement(item)) descend(item, expected);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      // `rows.map(row => ({ ... }))` -- the callback builds the list item, so
      // the element type is what its body has to satisfy.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "map" ||
          node.expression.name.text === "flatMap")
      ) {
        const callback = node.arguments[0];
        if (callback) descendFunction(callback, expected);
        return;
      }
      // A local card builder -- `accountSummaryNode(data, ss58)`. Its returns
      // fill this field, so they answer to this field's type. These are
      // exactly the zeroed-card shapes this issue is about.
      descendFunction(node.expression, expected);
      return;
    }
  };

  const descendFunction = (node: ts.Node, expected: GraphQLObjectType) => {
    let fn: ts.Node | undefined = node;
    if (!bodiedFunction(fn)) {
      const symbol = ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)
        : undefined;
      fn = symbol?.valueDeclaration;
      if (fn && ts.isVariableDeclaration(fn) && fn.initializer) {
        fn = unwrap(fn.initializer);
      }
    }
    if (!fn || !bodiedFunction(fn) || !fn.body) return;
    const key = `${fn.getSourceFile().fileName}:${fn.pos}:${expected.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (ts.isBlock(fn.body)) {
      for (const returned of ownReturns(fn.body)) descend(returned, expected);
    } else {
      descend(fn.body, expected);
    }
  };

  function checkLiteral(
    literal: ts.ObjectLiteralExpression,
    owner: GraphQLObjectType,
  ): void {
    const declared = owner.getFields();
    const file = relative(literal.getSourceFile());
    for (const member of literal.properties) {
      if (ts.isSpreadAssignment(member)) {
        // A declared passthrough is COUNTED, not skipped -- the entry names
        // where the guarantee lives (see DECLARED_PASSTHROUGHS). Anything
        // else stays undecided, and the validator fails on it: type the
        // source or declare it with evidence, no third state.
        if (owner.name in declaredPassthroughs) {
          passthroughs.push({ path: owner.name, file, line: lineOf(member) });
        } else {
          undecided.push({
            path: owner.name,
            file,
            line: lineOf(member),
            reason: "spread",
          });
        }
        continue;
      }
      const isShorthand = ts.isShorthandPropertyAssignment(member);
      if (!ts.isPropertyAssignment(member) && !isShorthand) continue;
      const name = member.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
      const field = declared[name.text];
      if (!field) {
        // The generated schema does not build this field. It is either a drop
        // the SDL declares over the component or a value nothing selects --
        // either way this report cannot decide it.
        undecided.push({
          path: `${owner.name}.${name.text}`,
          file,
          line: lineOf(member),
          reason: "undeclared-field",
        });
        continue;
      }
      const value = ts.isPropertyAssignment(member)
        ? member.initializer
        : member.name;
      const actual = checker.getTypeAtLocation(value);
      examined += 1;
      if (isAny(actual)) {
        undecided.push({
          path: `${owner.name}.${name.text}`,
          file,
          line: lineOf(member),
          reason: "any-typed",
        });
      } else if (field.type instanceof GraphQLNonNull && producesNull(actual)) {
        findings.push({
          path: `${owner.name}.${name.text}`,
          file,
          line: lineOf(member),
        });
      } else {
        decided.add(`${owner.name}.${name.text}`);
      }
      const nested = objectBehind(field.type);
      if (nested && ts.isPropertyAssignment(member)) {
        descend(member.initializer, nested);
      }
    }
  }

  const rootFields = queryType.getFields();
  for (const member of rootValueLiteral(program).properties) {
    const name = member.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name)))
      continue;
    const field = rootFields[name.text];
    if (!field) continue;
    const payload = objectBehind(field.type);
    if (!payload) continue;
    fields += 1;
    if (ts.isMethodDeclaration(member)) descendFunction(member, payload);
    else if (ts.isPropertyAssignment(member)) {
      descendFunction(unwrap(member.initializer), payload);
    }
  }

  // A field with one clean write and one dirty one is NOT proved -- the dirty
  // write is the arm that executes when the tier is sick, which is the whole
  // question. Findings win over the clean sites they share a name with.
  for (const finding of findings) decided.delete(finding.path);
  // An entry with no spread is stale: the passthrough it excused is gone, so
  // the excuse must go with it -- the shrink-only rule every declared list
  // here follows.
  const matched = new Set(passthroughs.map((p) => p.path));
  const stalePassthroughs = Object.keys(declaredPassthroughs).filter(
    (name) => !matched.has(name),
  );
  return {
    findings,
    undecided,
    passthroughs,
    stalePassthroughs,
    examined,
    fields,
    decided,
  };
}

/** The tightened contract: the schema the Zod components build. */
export function generatedQueryType(): GraphQLObjectType {
  const { schema } = buildGeneratedSchema(
    JSON.parse(
      readFileSync(path.join(repoRoot, OPENAPI_PATH), "utf8"),
    ) as OpenApiParameters,
  );
  const query = schema.getQueryType();
  if (!query) throw new Error("the generated schema declares no Query type.");
  return query;
}

function main(): void {
  const report = findOverPromises(createRepoProgram(), generatedQueryType());
  console.log(
    `nullable-overpromises: ${report.fields} root field(s) walked, ` +
      `${report.examined} property write(s) compared against the field the ` +
      `components declare; ${report.findings.length} write null into a ` +
      `NON-NULL field; ${report.undecided.length} could not be decided; ` +
      `${report.passthroughs.length} declared passthrough(s) over ` +
      `${Object.keys(DECLARED_PASSTHROUGHS).length} entr(ies).`,
  );
  if (report.findings.length) {
    console.log(
      "\nOVER-PROMISES -- graphql-js nulls the whole surrounding object on these:",
    );
    for (const finding of report.findings) {
      console.log(`  ${finding.file}:${finding.line} ${finding.path}`);
    }
  }
  const byReason = new Map<string, number>();
  for (const entry of report.undecided) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  if (byReason.size) {
    console.log(
      `\nUNDECIDED (not counted clean; a spread here must be typed or declared -- #10867): ` +
        [...byReason].map(([reason, n]) => `${reason} ${n}`).join(", "),
    );
  }
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
