// The generated schema against the published one, class by class (#10214).
//
// `report:graphql-sdl-equivalence` answers "does every published type have a
// generator SOURCE" and reached 407 of 407. This answers the next question and
// the only one left: BUILD the schema from those sources and see how the two
// differ. The difference is not one number -- it is three classes with very
// different meanings, and collapsing them into a single "N differences" would
// hide the one that matters.
//
//   TIGHTENED     the generator publishes `X!` where the schema publishes `X`.
//                 A HARDENING of the served contract, and the dangerous
//                 direction: graphql-js enforces non-null at execution, so one
//                 null from a producer nulls the whole surrounding object and
//                 attaches an error. `SelfHealthLane.detail` did exactly that
//                 on every self_health request (#10215). Each of these needs
//                 evidence that the producer cannot answer null -- the emitted
//                 non-null only says the Zod has no `.nullable()`, which is a
//                 claim about the schema, not about the producer.
//
//   NEWLY NAMED   a type the generator publishes that the schema does not. These
//                 are the shapes behind the fields the SDL under-types as
//                 `JSON`: publishing them is the FIX, and it happens by
//                 construction rather than by hand.
//
//   UNREACHED     a type the schema publishes that the generator does not build.
//                 A real gap -- something the declared sources do not describe.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildSchema, isObjectType } from "graphql";
import type { GraphQLObjectType, GraphQLSchema } from "graphql";
import { buildGeneratedSchema } from "../schemas-src/graphql/build-schema.ts";
import { assertEnumVocabularies } from "../schemas-src/graphql/enums.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";
import { extractSdl } from "./validate-graphql-component-parity.ts";

const SDL_PATH = "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

export interface SchemaDiff {
  publishedTypes: number;
  generatedTypes: number;
  /** Types reproduced field for field, name for name and type for type. */
  identical: number;
  /** `Type.field` the generator publishes non-null over a nullable one. */
  tightened: string[];
  /** Types only the generator has -- the under-typings, published. */
  newlyNamed: string[];
  /** Types only the schema has -- what the declared sources do not describe. */
  unreached: string[];
  /** Anything else: a field one side has and the other does not, or a retype. */
  otherDifferences: string[];
}

function objectTypes(schema: GraphQLSchema): Map<string, GraphQLObjectType> {
  const map = new Map<string, GraphQLObjectType>();
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith("__")) continue;
    if (isObjectType(type)) map.set(name, type);
  }
  return map;
}

export function diffSchemas(
  sdl: string,
  openapi: OpenApiParameters,
): SchemaDiff {
  const published = objectTypes(buildSchema(sdl));
  const { schema } = buildGeneratedSchema(openapi);
  const generated = objectTypes(schema);

  const tightened: string[] = [];
  const otherDifferences: string[] = [];
  let identical = 0;

  for (const [name, publishedType] of published) {
    const generatedType = generated.get(name);
    if (!generatedType) continue;
    const publishedFields = publishedType.getFields();
    const generatedFields = generatedType.getFields();
    let same = true;
    for (const [fieldName, field] of Object.entries(publishedFields)) {
      const counterpart = generatedFields[fieldName];
      if (!counterpart) {
        otherDifferences.push(
          `${name}.${fieldName} -- published, the generator does not build it`,
        );
        same = false;
        continue;
      }
      const was = String(field.type);
      const now = String(counterpart.type);
      if (was === now) continue;
      same = false;
      // The one class worth naming on its own: same type, one `!` more.
      if (`${was}!` === now || now === `${was.replace(/!$/, "")}!`) {
        tightened.push(`${name}.${fieldName} -- ${was} becomes ${now}`);
      } else {
        otherDifferences.push(`${name}.${fieldName} -- ${was} vs ${now}`);
      }
    }
    for (const fieldName of Object.keys(generatedFields)) {
      if (publishedFields[fieldName]) continue;
      otherDifferences.push(
        `${name}.${fieldName} -- the generator builds it, the schema does not publish it`,
      );
      same = false;
    }
    if (same) identical += 1;
  }

  return {
    publishedTypes: published.size,
    generatedTypes: generated.size,
    identical,
    tightened: tightened.sort(),
    newlyNamed: [...generated.keys()].filter((n) => !published.has(n)).sort(),
    unreached: [...published.keys()].filter((n) => !generated.has(n)).sort(),
    otherDifferences: otherDifferences.sort(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const vocabularies = assertEnumVocabularies();
  if (vocabularies.length) {
    console.error("graphql-schema-diff: enum vocabularies have drifted:");
    for (const line of vocabularies) console.error(`  - ${line}`);
    process.exit(1);
  }
  const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
  if (!sdl) {
    console.error(
      `graphql-schema-diff: no SDL template literal in ${SDL_PATH}`,
    );
    process.exit(1);
  }
  const report = diffSchemas(
    sdl,
    JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiParameters,
  );
  console.log(
    `graphql-schema-diff: the generator builds ${report.generatedTypes} object ` +
      `type(s) against the schema's ${report.publishedTypes}; ` +
      `${report.identical} reproduce field for field.`,
  );
  console.log(
    `\n  ${report.tightened.length} field(s) the generator would TIGHTEN to non-null` +
      `\n  ${report.newlyNamed.length} type(s) it publishes that the schema under-types as JSON` +
      `\n  ${report.unreached.length} type(s) the schema has that it does not build` +
      `\n  ${report.otherDifferences.length} other difference(s)`,
  );
  for (const [label, lines] of [
    [
      "UNREACHED -- the declared sources do not describe these",
      report.unreached,
    ],
    ["OTHER", report.otherDifferences],
  ] as const) {
    if (!lines.length) continue;
    console.log(`\n${label}:`);
    for (const line of lines.slice(0, 40)) console.log(`  - ${line}`);
    if (lines.length > 40) console.log(`  … and ${lines.length - 40} more`);
  }
}
