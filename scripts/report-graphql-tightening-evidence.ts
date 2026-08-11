// Which of the generator's non-null promises production has actually proved
// (#10214).
//
// `report:graphql-schema-diff` counts the fields the generated schema would
// TIGHTEN -- `X` in the published SDL, `X!` in the generator. That count is not
// a decision. Each one is a claim about a PRODUCER ("it cannot answer null"),
// and what the generator knows is a claim about a SCHEMA ("the Zod has no
// `.nullable()`"). The two are different, and where they disagree the served
// schema is the one that has been right: graphql-js enforces non-null at
// execution, so a single null nulls the whole surrounding object and attaches
// an error -- which is what `SelfHealthLane.detail` did on every self_health
// request until #10215.
//
// `conformance:graphql-nullability` already asks production the producer
// question, over both transports. What was missing is the JOIN: its answer
// covers every non-null leaf the generator promises, and only some of those
// are ones the cutover would CHANGE. Reporting the two separately meant the
// evidence for a tightening and the tightening itself were never in the same
// place, so "3176 of 3403 observed" got read as though it licensed all 300 --
// when the 300 are a different set, and the overlap is the whole question.
//
// This intersects them and reports three buckets:
//
//   PROVED       the tightening is in the observed set, seen with a value and
//                never null. Safe: the producer has answered, repeatedly.
//   NULLED       production answered null for a field the generator promises
//                non-null. NOT a tightening to make -- a bug to fix, in the
//                Zod or the producer.
//   UNPROVED     the probe never saw a value. No evidence either way, so the
//                honest thing is to leave the published nullable.
//
// #10786 ADDED A SECOND SOURCE, and it had to. The probe covers the HAPPY PATH:
// production is not degraded when you ask it, so no amount of probing reaches
// the cold-tier and zeroed-card arms where the `?? null` fallbacks live -- and
// those are exactly the arms a tightening would break, at exactly the moment a
// caller most needs the card. `report:nullable-overpromises` reads the
// PRODUCERS instead, through the TypeScript checker, and can therefore answer
// for an arm no request takes. Its verdict joins here:
//
//   COMPILED     the probe never saw a value, but the checker walked every
//                producer that writes this field and none of them can write
//                null. Safe on the degraded arms too, which is more than the
//                probe can say about anything.
//
// A field the compiler found writing null is folded into NULLED, not left as
// evidence-free -- a bug is a bug whichever oracle found it.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { checkNullability } from "./check-graphql-nullability.ts";
import { diffSchemas } from "./report-graphql-schema-diff.ts";
import { extractSdl } from "./validate-graphql-component-parity.ts";
import {
  findOverPromises,
  generatedQueryType,
} from "./report-nullable-overpromises.ts";
import { createRepoProgram } from "./report-type-duplicates.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";

const SDL_PATH = "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

export interface TighteningEvidence {
  /** Every field the cutover would promise non-null over a nullable one. */
  tightened: string[];
  /** Tightenings production has answered with a value, never null. */
  proved: string[];
  /** Tightenings production answered NULL for -- a bug, not a decision. */
  nulled: string[];
  /** Tightenings the compiler proved no producer can null (#10786). */
  compiled: string[];
  /** Tightenings NEITHER oracle can speak to. */
  unproved: string[];
}

/**
 * `Type.field -- X becomes X!` -> `Type.field`.
 *
 * The diff's line carries the transition for a human; the join needs the key.
 */
function fieldOf(line: string): string {
  return line.split(" -- ")[0];
}

export function joinEvidence(
  tightenedLines: readonly string[],
  observedFields: ReadonlySet<string>,
  nulledFields: ReadonlySet<string>,
  // The compiler's two answers, from `report:nullable-overpromises`. Defaulted
  // empty so a caller with only the probe still gets the original three
  // buckets rather than a silently better-looking number.
  compilerClean: ReadonlySet<string> = new Set(),
  compilerNulled: ReadonlySet<string> = new Set(),
): TighteningEvidence {
  const tightened = tightenedLines.map(fieldOf);
  const proved: string[] = [];
  const nulled: string[] = [];
  const compiled: string[] = [];
  const unproved: string[] = [];
  for (const field of tightened) {
    // Either oracle finding a null is a bug, and a bug outranks every kind of
    // silence. The probe is asked first only because it is the older evidence.
    if (nulledFields.has(field) || compilerNulled.has(field)) {
      nulled.push(field);
    } else if (observedFields.has(field)) proved.push(field);
    else if (compilerClean.has(field)) compiled.push(field);
    else unproved.push(field);
  }
  return { tightened, proved, nulled, compiled, unproved };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const openapi = JSON.parse(
    readFileSync(OPENAPI_PATH, "utf8"),
  ) as OpenApiParameters;
  const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
  if (!sdl) {
    console.error(
      `tightening-evidence: no SDL template literal in ${SDL_PATH}`,
    );
    process.exit(1);
  }
  const diff = diffSchemas(sdl, openapi);
  const report = await checkNullability(openapi);
  // `unobserved` is what the probe never saw; everything else it promised was
  // seen. Deriving the observed set by SUBTRACTION rather than asking for it
  // keeps the two reports from having to agree on a second list.
  const unobserved = new Set(report.unobserved);
  const nulledFields = new Set(
    report.findings.filter((f) => f.nulls > 0).map((f) => f.field),
  );
  // The second oracle (#10786): the producers themselves, through the checker.
  const compiler = findOverPromises(createRepoProgram(), generatedQueryType());
  const evidence = joinEvidence(
    diff.tightened,
    new Set(
      diff.tightened.map(fieldOf).filter((field) => !unobserved.has(field)),
    ),
    nulledFields,
    compiler.decided,
    new Set(compiler.findings.map((finding) => finding.path)),
  );

  console.log(
    `tightening-evidence: ${evidence.tightened.length} tightening(s); ` +
      `${evidence.proved.length} proved by production, ` +
      `${evidence.compiled.length} proved by the compiler, ` +
      `${evidence.nulled.length} answered NULL, ` +
      `${evidence.unproved.length} unproved.`,
  );
  for (const [label, lines] of [
    ["ANSWERED NULL -- a bug, not a tightening", evidence.nulled],
    ["UNPROVED -- no evidence either way", evidence.unproved],
  ] as const) {
    if (!lines.length) continue;
    console.log(`\n${label}:`);
    for (const line of lines.slice(0, 60)) console.log(`  - ${line}`);
    if (lines.length > 60) console.log(`  … and ${lines.length - 60} more`);
  }
  // A tightening production has ANSWERED NULL for is the one case that is not
  // a judgement call, so it is the one that fails.
  if (evidence.nulled.length) process.exit(1);
}
