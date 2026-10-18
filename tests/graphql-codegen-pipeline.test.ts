import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { buildSchema } from "graphql";
import { gqlPluckFromCodeString } from "@graphql-tools/graphql-tag-pluck";
import ts from "typescript";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import codegenConfig from "../codegen.ts";
import * as generator from "../scripts/generate-graphql-types.ts";

// Small declarations make source changes observable without rebuilding the
// whole contract in every IO regression. Hosted drift qualification still
// compares both real canonical artifacts byte-for-byte.
vi.mock("../schemas-src/graphql/build-schema.ts", async () => {
  const { buildSchema } = await import("graphql");
  return {
    buildGeneratedSchema: () => {
      const schema = buildSchema("scalar JSON\ntype Query { fresh: JSON! }");
      schema.getQueryType()!.getFields().fresh.description =
        "literal `tick`, ${amount}, and C:\\schema";
      return { schema };
    },
  };
});

let schemaModule: string | undefined;
let typeOutput: string | undefined;
let events: string[];

function moduleFor(sdl: string): string {
  return `export const SDL = /* GraphQL */ \`${sdl}\`;\n`;
}

async function typesFromCommittedModule(source: string) {
  schemaModule = source;
  const [, output] = await generator.generateGraphqlTypes({ silent: true });
  return output;
}

// Parse the generated constant as data, without importing/evaluating a module.
// TypeScript's literal .text is the runtime-cooked value; raw pluck behavior is
// checked independently below and intentionally remains a different contract.
function runtimeSdlLiteral(source: string): string {
  const sourceFile = ts.createSourceFile(
    "generated/graphql/schema.ts",
    source,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TS,
  );
  const values: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "SDL" &&
        declaration.initializer &&
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer)
      ) {
        values.push(declaration.initializer.text);
      }
    }
  }
  if (values.length !== 1) throw new Error("Expected one literal SDL constant");
  return values[0];
}

beforeEach(() => {
  schemaModule = moduleFor("type Query { committed: String! }");
  typeOutput = undefined;
  events = [];

  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ] as const) {
    vi.spyOn(childProcess, method).mockImplementation(() => {
      throw new Error(`Unexpected child-process call: ${method}`);
    });
  }
  syncBuiltinESMExports();

  vi.spyOn(fs, "readFile").mockImplementation(
    (async (filename: Parameters<typeof fs.readFile>[0]) => {
      const target = path.normalize(String(filename));
      if (target.endsWith(path.normalize("public/metagraph/openapi.json"))) {
        return "{}";
      }
      if (target.endsWith(path.normalize("generated/graphql/schema.ts"))) {
        events.push("read schema");
        if (schemaModule === undefined) {
          throw Object.assign(new Error("Schema module is missing"), {
            code: "ENOENT",
          });
        }
        return schemaModule;
      }
      throw new Error(`Unexpected read: ${target}`);
    }) as typeof fs.readFile,
  );
  vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fs, "writeFile").mockImplementation(async (filename, content) => {
    const target = path.normalize(String(filename));
    if (target.endsWith(path.normalize("generated/graphql/schema.ts"))) {
      events.push("write schema");
      schemaModule = String(content);
      return;
    }
    if (target.endsWith(path.normalize("generated/graphql/types.ts"))) {
      events.push("write types");
      typeOutput = String(content);
      return;
    }
    throw new Error(`Unexpected write: ${target}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

test("the fixed pipeline preserves plugin order, scalar and context settings", async () => {
  expect(Object.keys(codegenConfig)).toEqual(["schema", "generates"]);
  expect(Object.keys(codegenConfig.generates)).toEqual([
    "generated/graphql/types.ts",
  ]);
  expect(
    codegenConfig.generates["generated/graphql/types.ts"].plugins,
  ).toEqual(["typescript", "typescript-resolvers"]);

  const output = await typesFromCommittedModule(
    moduleFor("scalar JSON\ntype Query { zulu: JSON! alpha: String! }"),
  );
  expect(output.filename).toBe("generated/graphql/types.ts");
  expect(output.content).toContain("JSON: { input: unknown; output: unknown; }");
  expect(output.content).toContain(
    "import { GqlContext } from '../../src/graphql.ts';",
  );
  expect(output.content.indexOf("  alpha:")).toBeLessThan(
    output.content.indexOf("  zulu:"),
  );
  expect(output.content).toContain("Record<string, any>");
  expect(childProcess.exec).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

test("plucks SDL without executing module code", async () => {
  const output = await typesFromCommittedModule(
    'throw new Error("Schema source must not execute");\n' +
      moduleFor("type Query { safe: String! }"),
  );
  expect(output.content).toContain("safe:");
  expect(fs.writeFile).not.toHaveBeenCalled();
});

test.each([
  ["no SDL", "export const ordinary = 1;"],
  [
    "multiple SDLs",
    moduleFor("type Query { first: String }") +
      "const second = /* GraphQL */ `type Other { value: String }`;",
  ],
  ["invalid SDL", moduleFor("type Query {")],
])("fails closed for %s without output writes", async (_label, source) => {
  await expect(typesFromCommittedModule(source)).rejects.toThrow();
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.mkdir).not.toHaveBeenCalled();
});

test("drift computation reads committed SDL, returns fresh module and never writes", async () => {
  const committed = schemaModule;
  const outputs = await generator.generateGraphqlTypes({ silent: true });
  expect(outputs.map((output) => output.filename)).toEqual([
    "generated/graphql/schema.ts",
    "generated/graphql/types.ts",
  ]);
  expect(outputs[0].content).toContain("fresh: JSON");
  expect(outputs[0].content).not.toBe(committed);
  expect(outputs[1].content).toContain("committed:");
  expect(outputs[1].content).not.toContain("fresh:");
  expect(schemaModule).toBe(committed);
  expect(fs.writeFile).not.toHaveBeenCalled();
  expect(fs.mkdir).not.toHaveBeenCalled();
});

test("a missing committed SDL fails drift computation without writing a repair", async () => {
  schemaModule = undefined;
  await expect(generator.generateGraphqlTypes()).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(fs.writeFile).not.toHaveBeenCalled();
});

test("build writes then reads fresh SDL without module-cache dependence", async () => {
  await generator.generateGraphqlTypes({ silent: true });
  events = [];
  await generator.buildGraphqlTypes();

  expect(events).toEqual(["write schema", "read schema", "write types"]);
  expect(typeOutput).toContain("fresh:");
  expect(typeOutput).not.toContain("committed:");
  expect(childProcess.exec).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

test("runtime SDL keeps literal escapes while type output retains baseline raw plucking", async () => {
  const [freshSchemaModule] = await generator.generateGraphqlTypes();
  const runtimeSchema = buildSchema(runtimeSdlLiteral(freshSchemaModule.content));
  const runtimeDescription =
    runtimeSchema.getQueryType()!.getFields().fresh.description;
  expect(runtimeDescription).toBe("literal `tick`, ${amount}, and C:\\schema");

  // This is the actual API/default used by the old CLI code-file loader,
  // rather than a reimplementation of its raw-string transformation.
  const baselineSources = await gqlPluckFromCodeString(
    codegenConfig.schema,
    freshSchemaModule.content,
  );
  expect(baselineSources).toHaveLength(1);
  const baselineDescription = buildSchema(baselineSources[0].body)
    .getQueryType()!
    .getFields().fresh.description!;
  expect(baselineDescription).toContain("literal `tick`");
  expect(baselineDescription).toContain("C:\\\\schema");
  expect(baselineDescription).not.toContain("${amount}");
  expect(baselineDescription).not.toBe(runtimeDescription);

  const candidate = await typesFromCommittedModule(
    freshSchemaModule.content,
  );
  expect(candidate.content).toContain(baselineDescription);
  expect(candidate.content).not.toContain("${amount}");
  expect(fs.writeFile).not.toHaveBeenCalled();
});

test("a failed schema write stops before reading or writing types", async () => {
  vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("disk full"));
  await expect(generator.buildGraphqlTypes()).rejects.toThrow("disk full");
  expect(events).toEqual([]);
  expect(typeOutput).toBeUndefined();
});
