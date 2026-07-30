// The inlined-example projection of the OpenAPI document, for type generation
// only (#8763).
//
// The published public/metagraph/openapi.json holds each distinct worked
// example ONCE, in components.examples, with every media type pointing at it by
// $ref. That de-duplication is the point of #8763 and it is what clients
// download.
//
// openapi-typescript 7.x renders an `@example` JSDoc block only from a media
// type's SINGULAR `example` field, or from a JSON-Schema `examples` ARRAY (see
// addJSDocComment in openapi-typescript/dist/lib/ts.mjs). It has no handling for
// the OpenAPI 3.1 Media Type `examples` MAP, so pointing it at the deduplicated
// document silently drops every `@example` from the generated .d.ts — ~546 KB of
// per-operation documentation that SDK users read on hover. Keeping an inline
// copy in the published spec to satisfy it would undo the de-duplication.
//
// So each artifact gets the view it needs: the spec stays deduplicated, and type
// generation reads a throwaway inlined projection. Resolving a $ref to the value
// it already pointed at yields the same document, so the emitted types are
// byte-identical to the pre-#8763 output.
//
// THIS MODULE IS SHARED ON PURPOSE. Both scripts/generate-types.ts (which writes
// the types) and scripts/validate-contract-drift.ts (which regenerates them and
// asserts the committed copies match) must project the spec the same way — if
// only one did, drift would fail on every build for a difference that is not
// drift. One implementation, two callers, no way for them to disagree.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./lib.ts";

const EXAMPLES_REF_PREFIX = "#/components/examples/";

type MediaType = { example?: unknown; examples?: Record<string, unknown> };

/**
 * Replace every media-type `examples` $ref with the inline `example` it points
 * at. Mutates `document`; returns how many media types were rewritten.
 */
export function inlineOpenApiExamples(
  document: Record<string, unknown>,
): number {
  const components = document.components as
    { examples?: Record<string, { value?: unknown }> } | undefined;
  const hoisted = components?.examples ?? {};
  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, { responses?: Record<string, { content?: unknown }> }>
  >;
  let inlined = 0;
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item)) {
      for (const response of Object.values(operation?.responses ?? {})) {
        const content = (response?.content ?? {}) as Record<string, MediaType>;
        for (const media of Object.values(content)) {
          if (!media.examples) continue;
          const entry = Object.values(media.examples)[0] as
            { $ref?: string; value?: unknown } | undefined;
          const ref = entry?.$ref;
          const value =
            typeof ref === "string"
              ? hoisted[ref.replace(EXAMPLES_REF_PREFIX, "")]?.value
              : entry?.value;
          if (value === undefined) continue;
          media.example = value;
          delete media.examples;
          inlined += 1;
        }
      }
    }
  }
  return inlined;
}

/**
 * Write the inlined projection of the published spec to a temp file and return
 * its path plus the rewrite count. The caller owns the directory and should
 * remove it — see `removeInlinedOpenApiSpec`.
 */
export async function writeInlinedOpenApiSpec(): Promise<{
  specPath: string;
  inlined: number;
}> {
  const document = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "public/metagraph/openapi.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const inlined = inlineOpenApiExamples(document);
  const specPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "metagraphed-openapi-")),
    "openapi.json",
  );
  await fs.writeFile(specPath, JSON.stringify(document), "utf8");
  return { specPath, inlined };
}

/** Remove a temp spec directory created by `writeInlinedOpenApiSpec`. */
export async function removeInlinedOpenApiSpec(specPath: string) {
  await fs.rm(path.dirname(specPath), { recursive: true, force: true });
}
