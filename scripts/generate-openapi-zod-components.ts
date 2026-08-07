// Emits the published OpenAPI component schemas from
// schemas-src/openapi-registry.ts. Pure function, no filesystem I/O.
//
// Since #9830 this is the ONLY source: the hand-written
// schemas/components/*.schema.json layer this used to be merged over is
// deleted, so what this returns is the whole of components.schemas (plus the
// build marker scripts/openapi-components.ts adds).
import { z } from "zod";
import { openApiComponentRegistry } from "../schemas-src/openapi-registry.ts";

type Row = Record<string, unknown>;

export function generateOpenApiZodComponents(): Record<string, Row> {
  // reused:"inline" (not "ref"): several registered schemas share underlying
  // Zod nodes by reference (e.g. every ArtifactBaseSchema.extend() call
  // reuses the exact same schema_version/generated_at/notes nodes; several
  // routes import the same shared.ts enum). With "ref", Zod hoists those
  // into an anonymous "__shared" bucket inside the schemas map instead of
  // giving them a real component name -- not embeddable as an OpenAPI
  // component. "inline" duplicates that (small) shared shape at each call
  // site instead, which only ever affects schemas this registry does NOT
  // explicitly name (enums, small nested objects) -- exactly the class of
  // cosmetic inline-vs-$ref difference the diff audit already expects and
  // accepts (see the PR body's bucket-c notes).
  const generated = z.toJSONSchema(openApiComponentRegistry, {
    target: "draft-2020-12",
    reused: "inline",
    uri: (id) => `#/components/schemas/${id}`,
  });

  const components: Record<string, Row> = {};
  for (const [name, schema] of Object.entries(generated.schemas)) {
    // $schema/$id are per-document JSON Schema metadata Zod stamps on every
    // root it emits; a components.schemas entry is embedded inside a larger
    // document (the OpenAPI file) and never carries either.
    const {
      $schema: _schema,
      $id: _id,
      ...rest
    } = schema as Row & {
      $schema?: unknown;
      $id?: unknown;
    };
    components[name] = rest;
  }
  return components;
}

// `--check` compiles the registry and reports the count; bare prints the JSON.
//
// The build passes --check (scripts/build.ts). Without it this step wrote
// ~1,040,000 bytes / 42,664 lines to stdout -- 99.8% of the whole build log,
// against 2,358 bytes from every other step combined -- and nothing read a
// byte of it: both real consumers (scripts/openapi-components.ts,
// scripts/validate-single-schema-source.ts) import the function and call it
// in-process. A log that noisy is a log nobody reads, which is how a healthy
// build got reported as a failing one (#9945).
//
// The step still earns its place: compiling the registry is exactly the
// fast-fail check build.ts wants, and it fails identically either way -- the
// count line just proves it ran. Same shape as generate-client.ts's flagged
// summary-vs-payload split, and the same --check verb as
// generate-registry-readme-section.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const components = generateOpenApiZodComponents();
  if (process.argv.includes("--check")) {
    console.log(
      `openapi-zod: ${Object.keys(components).length} component schema(s) compiled.`,
    );
  } else {
    console.log(JSON.stringify(components, null, 2));
  }
}
