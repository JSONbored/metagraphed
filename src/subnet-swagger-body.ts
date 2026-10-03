import {
  capturedSchemaObject,
  resolveLocalSchemaObject,
} from "./subnet-openapi-reference.ts";

function invalid(reason: string): never {
  throw new Error(`Invalid captured Swagger 2 request body: ${reason}.`);
}

/** Normalize Swagger's body/formData and consumes into the existing media gate.
 * The body parameter name is documentation, never a payload envelope. Form
 * payloads remain caller-encoded text or exact bytes, including file parts. */
export function resolveSwaggerRequestBody(
  document: unknown,
  pathItem: unknown,
  operation: Record<string, unknown>,
): { required: boolean; content: Record<string, { schema?: unknown }> } | null {
  const root = capturedSchemaObject(document);
  if (root?.swagger !== "2.0") return null;
  const parameters = new Map<string, Record<string, unknown>>();
  for (const list of [capturedSchemaObject(pathItem)?.parameters, operation.parameters]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) invalid("parameters must be an array");
    const seen = new Set<string>();
    for (const entry of list) {
      const parameter = resolveLocalSchemaObject(document, entry);
      if (!parameter) invalid("parameter references must resolve inside the captured document");
      if (parameter.in !== "body" && parameter.in !== "formData") continue;
      if (typeof parameter.name !== "string") invalid("body/formData parameters need a name");
      const key = `${parameter.in}:${parameter.name}`;
      if (seen.has(key)) invalid("parameters must be unique within each declaration list");
      seen.add(key);
      parameters.set(key, parameter);
    }
  }
  let body: Record<string, unknown> | undefined;
  let form = false;
  let required = false;
  for (const parameter of parameters.values()) {
    if (parameter.required !== undefined && typeof parameter.required !== "boolean")
      invalid("required must be boolean");
    required ||= parameter.required === true;
    if (parameter.in === "body") {
      if (body) invalid("an operation can have only one body parameter");
      if (!capturedSchemaObject(parameter.schema)) invalid("body parameters need a schema");
      body = parameter;
    } else form = true;
  }
  if (!body && !form) return null;
  if (body && form) invalid("body and formData cannot be combined");
  // An operation's empty consumes explicitly clears the global definition.
  const consumes = operation.consumes === undefined ? root.consumes : operation.consumes;
  const declared = consumes === undefined ? [] : consumes;
  if (!Array.isArray(declared) || declared.some((media) => typeof media !== "string" || !media.trim()))
    invalid("consumes must be an array of nonempty media types");
  const mediaTypes: string[] = declared.length
    ? declared
    : form ? ["application/x-www-form-urlencoded", "multipart/form-data"] : ["*/*"];
  if (form && mediaTypes.some((media) => !["application/x-www-form-urlencoded", "multipart/form-data"].includes(media.split(";", 1)[0]!.trim().toLowerCase())))
    invalid("formData requires form media types");
  return {
    required,
    content: Object.fromEntries(mediaTypes.map((media) => [media, body ? { schema: body.schema } : {}])),
  };
}
