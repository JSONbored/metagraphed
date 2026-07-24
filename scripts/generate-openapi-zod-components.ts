// Emits the Zod-owned OpenAPI component schemas (types-epic B, #7860) from
// schemas-src/openapi-registry.ts. Pure function, no filesystem I/O -- the
// caller (scripts/openapi-components.ts) merges the result over the
// hand-edited bundle.
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
    // document (the OpenAPI file) and never carries either -- none of the
    // hand-edited components do, and validate-contract-drift byte-compares
    // against that shape.
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

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(generateOpenApiZodComponents(), null, 2));
}
