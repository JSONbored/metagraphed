// The census: hand-written declarations that STRUCTURALLY MATCH a generated
// type (#10784).
//
// This is the first deliverable of that issue and it exists to size the rest.
// The instruction it follows is "do not mass-replace before the census": not
// every hand-written type is duplication -- options bags, internal accumulators
// and closure shapes are legitimately local -- so the work has to be MEASURED
// rather than guessed at from a grep.
//
// ## What "structurally match" means here
//
// The checker's own view of the type, not its text: every property name paired
// with the checker's rendering of that property's type, sorted, joined. Two
// declarations with the same signature describe the same shape whatever they
// are called and wherever they live.
//
// Read through `ts.Program` rather than by parsing source, because the question
// is about TYPES and a regex cannot resolve one. `scripts/validate-pg-json-binds.ts`
// established the idiom.
//
// ## What it deliberately does NOT count
//
// GENERIC declarations. A type parameter makes the signature depend on its
// instantiation, so `Page<T>` and a generated `PageOfSubnets` are not
// comparable by this method and calling them equal would be a guess.
//
// SINGLE-MEMBER shapes. `{ netuid: number }` matches by coincidence rather
// than by lineage, and a census that counted those would report duplication
// nobody should act on. They are reported separately as `coincidental` so the
// number stays honest rather than flattering.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Where a generated type comes from. Each is a generator's output. */
const GENERATED_SOURCES = [
  "generated/graphql/types.ts",
  "generated/db/types.ts",
  "generated/lakehouse/types.ts",
  "schemas-src/",
] as const;

/** Where hand-written declarations are counted. */
const HAND_WRITTEN_ROOTS = ["src/", "workers/"] as const;

/** A declaration and the shape the checker says it has. */
export interface Declared {
  name: string;
  file: string;
  line: number;
  /** Sorted `property:type` pairs -- the checker's view, not the source text. */
  signature: string;
  members: number;
}

export interface DuplicateFinding {
  hand: Declared;
  generated: Declared;
}

/** A generated type aliased and then widened -- a parallel shape with steps. */
export interface WidenedFinding {
  name: string;
  file: string;
  line: number;
  base: string;
}

export interface CensusReport {
  /** Hand-written declarations that match a generated type on >1 member. */
  duplicates: DuplicateFinding[];
  /** Single-member matches: coincidence rather than lineage, counted apart. */
  coincidental: DuplicateFinding[];
  handWritten: number;
  generated: number;
  /** Declarations skipped because a type parameter makes them incomparable. */
  generic: number;
  /** Declarations already DERIVED from a generated type -- not parallel shapes. */
  derived: number;
  /**
   * `type Foo = GeneratedFoo & { extra }`.
   *
   * Forbidden by #10784 and worth its own finding: an intersection that widens
   * a GENERATED type re-introduces the parallel shape with extra steps, and a
   * field a producer genuinely adds belongs in the schema. An intersection of
   * two LOCAL types is ordinary composition and is not counted.
   */
  widened: WidenedFinding[];
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function startsWithAny(file: string, prefixes: readonly string[]): boolean {
  const rel = relative(file);
  return prefixes.some((prefix) => rel.startsWith(prefix));
}

/**
 * The checker's view of an object type: every property, with its type.
 *
 * `undefined` for anything that is not an object shape -- a union, a primitive
 * alias, a function type. Those are real declarations and they are counted in
 * the totals, but "same set of members" is not a question that can be asked of
 * them.
 */
function signatureOf(
  type: ts.Type,
  checker: ts.TypeChecker,
): { signature: string; members: number } | undefined {
  // OBJECT TYPES ONLY, and this guard is load-bearing. `getPropertiesOfType`
  // on a union of string literals answers the APPARENT properties of `String`
  // -- 52 of them, `charAt` through `valueOf` -- so every `type X = "a" | "b"`
  // in the tree produced an identical 52-member signature and matched every
  // other one. The first run of this census reported 64 duplicates on exactly
  // that, which is the shape of finding this issue warns about: a measurement
  // that flatters itself is worse than no measurement.
  if (type.isUnion() || type.isIntersection()) return undefined;
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) return undefined;
  const parts: string[] = [];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) return undefined;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration,
    );
    const optional =
      (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
    parts.push(
      `${property.getName()}${optional}:${checker.typeToString(propertyType)}`,
    );
  }
  return { signature: parts.sort().join("|"), members: properties.length };
}

/**
 * Pair every hand-written shape with the generated one it reproduces.
 *
 * Pure over its inputs, so a test can drive it with synthetic declarations and
 * prove it actually reports a duplicate -- building the real program takes
 * tens of seconds, and a gate only ever run against a passing tree proves
 * nothing about what it would catch.
 *
 * A SINGLE-MEMBER match is separated rather than counted: `{ netuid: number }`
 * reproduces a generated shape by coincidence, not by lineage, and acting on
 * one would be churn.
 */
export function matchDuplicates(
  hand: readonly Declared[],
  generated: readonly Declared[],
): { duplicates: DuplicateFinding[]; coincidental: DuplicateFinding[] } {
  const bySignature = new Map<string, Declared>();
  for (const entry of generated) {
    if (!bySignature.has(entry.signature)) {
      bySignature.set(entry.signature, entry);
    }
  }
  const duplicates: DuplicateFinding[] = [];
  const coincidental: DuplicateFinding[] = [];
  for (const entry of hand) {
    const match = bySignature.get(entry.signature);
    if (!match) continue;
    (entry.members > 1 ? duplicates : coincidental).push({
      hand: entry,
      generated: match,
    });
  }
  return { duplicates, coincidental };
}

export function runCensus(program: ts.Program): CensusReport {
  const checker = program.getTypeChecker();
  const generated: Declared[] = [];
  const hand: Declared[] = [];
  let generic = 0;
  let derived = 0;
  const widened: WidenedFinding[] = [];

  /** Does this type node name a type a generator produced? */
  const referencesGenerated = (node: ts.TypeNode): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isTypeReferenceNode(child)) {
        const name = ts.isIdentifier(child.typeName)
          ? child.typeName
          : child.typeName.right;
        let symbol = checker.getSymbolAtLocation(name);
        // An IMPORTED name resolves to its import specifier, which lives in the
        // importing file -- so without this hop every `= GeneratedThing` read
        // as locally declared and the exclusion matched nothing.
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        const declarations = symbol?.declarations ?? [];
        for (const declaration of declarations) {
          const file = declaration.getSourceFile().fileName;
          if (startsWithAny(file, GENERATED_SOURCES)) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile && !source.fileName.includes("generated/")) {
      continue;
    }
    const isGenerated = startsWithAny(source.fileName, GENERATED_SOURCES);
    const isHand = startsWithAny(source.fileName, HAND_WRITTEN_ROOTS);
    if (!isGenerated && !isHand) continue;

    ts.forEachChild(source, (node) => {
      if (
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node)
      ) {
        return;
      }
      // A type parameter makes the shape depend on its instantiation, so the
      // signature would describe the uninstantiated form and match nothing
      // meaningfully. Counted, not compared.
      if (node.typeParameters && node.typeParameters.length > 0) {
        generic += 1;
        return;
      }
      // ALREADY DERIVED FROM A GENERATED TYPE, so not a parallel shape at all.
      // `type AccountIdentityD1Row = Pick<AccountIdentity, (typeof COLUMNS)[number]>`
      // matches its source structurally today only because the column list
      // currently covers every column -- and that is the point of writing it
      // that way. Replacing it with a bare alias would delete the tracking and
      // report a "duplicate" that is the correct code (#10784).
      if (
        isHand &&
        ts.isTypeAliasDeclaration(node) &&
        referencesGenerated(node.type)
      ) {
        if (ts.isIntersectionTypeNode(node.type)) {
          const base = node.type.types.find((member) =>
            referencesGenerated(member),
          );
          widened.push({
            name: node.name.text,
            file: relative(source.fileName),
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            base: base ? base.getText(source) : "a generated type",
          });
        }
        derived += 1;
        return;
      }
      const symbol = checker.getSymbolAtLocation(node.name);
      if (!symbol) return;
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      const shape = signatureOf(type, checker);
      if (!shape) return;
      const entry: Declared = {
        name: node.name.text,
        file: relative(source.fileName),
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        signature: shape.signature,
        members: shape.members,
      };
      if (isGenerated) generated.push(entry);
      else hand.push(entry);
    });
  }

  const { duplicates, coincidental } = matchDuplicates(hand, generated);

  return {
    duplicates,
    coincidental,
    handWritten: hand.length,
    generated: generated.length,
    generic,
    derived,
    widened,
  };
}

export function createRepoProgram(): ts.Program {
  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

function main(): void {
  const report = runCensus(createRepoProgram());
  console.log(
    `type-duplicates: ${report.handWritten} hand-written object declaration(s) in ` +
      `src/ + workers/ against ${report.generated} generated one(s); ` +
      `${report.generic} generic and ${report.derived} already-derived ` +
      `declaration(s) not comparable.`,
  );
  console.log(
    `\n  ${report.duplicates.length} STRUCTURAL DUPLICATE(S) -- a hand-written type ` +
      `that IS a generated one:`,
  );
  for (const finding of report.duplicates
    .slice()
    .sort((a, b) => b.hand.members - a.hand.members)) {
    console.log(
      `    ${finding.hand.file}:${finding.hand.line} ${finding.hand.name} ` +
        `(${finding.hand.members} members) == ${finding.generated.name} ` +
        `[${finding.generated.file}]`,
    );
  }
  console.log(
    `\n  ${report.widened.length} generated type(s) aliased and then WIDENED:`,
  );
  for (const finding of report.widened) {
    console.log(
      `    ${finding.file}:${finding.line} ${finding.name} = ${finding.base} & { ... }`,
    );
  }
  console.log(
    `\n  ${report.coincidental.length} single-member match(es), counted apart: a one-property ` +
      `shape matches by coincidence, not lineage.`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
