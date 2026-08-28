const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

type JsonObject = Record<string, unknown>;

export interface OpenAPIOperationSlice {
  document: JsonObject;
  method: string;
  path: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep this identical to scripts/generate-openapi-docs.ts's filename transform. */
export function operationIdToSlug(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

function decodePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalPointer(document: JsonObject, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const rawSegment of pointer.slice(2).split("/")) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = current[decodePointerSegment(rawSegment) as keyof typeof current];
  }
  return current;
}

function setLocalPointer(document: JsonObject, pointer: string, value: unknown): void {
  const segments = pointer.slice(2).split("/").map(decodePointerSegment);
  let current = document;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (isObject(next)) current = next;
    else {
      const child: JsonObject = {};
      current[segment] = child;
      current = child;
    }
  }
  current[segments.at(-1)!] = value;
}

function localReferences(value: unknown): string[] {
  const references = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      // `$ref` is the common case. Discriminator mappings are plain string
      // values, so collect every local pointer rather than only `$ref` keys.
      if (node.startsWith("#/")) references.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isObject(node)) for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return [...references];
}

function includeReferencedComponents(source: JsonObject, target: JsonObject, root: unknown): void {
  const pending = localReferences(root);
  const included = new Set<string>();

  while (pending.length > 0) {
    const pointer = pending.pop()!;
    if (included.has(pointer)) continue;
    const value = resolveLocalPointer(source, pointer);
    if (value === undefined) continue;
    included.add(pointer);
    setLocalPointer(target, pointer, value);
    pending.push(...localReferences(value));
  }
}

function includeNamedSecuritySchemes(source: JsonObject, target: JsonObject, root: unknown): void {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    const security = node.security;
    if (Array.isArray(security)) {
      for (const requirement of security) {
        if (isObject(requirement)) for (const name of Object.keys(requirement)) names.add(name);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(root);

  for (const name of names) {
    const pointer = `#/components/securitySchemes/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const value = resolveLocalPointer(source, pointer);
    if (value === undefined) continue;
    setLocalPointer(target, pointer, value);
    includeReferencedComponents(source, target, value);
  }
}

/**
 * Reduce a bundled OpenAPI document to one operation and every component it
 * can reach. Fumadocs renders one operation per generated page, but its stock
 * preloader serializes the entire API contract into every response.
 */
export function sliceOpenAPIDocumentForOperation(
  source: JsonObject,
  operationSlug: string,
): OpenAPIOperationSlice | undefined {
  const paths = source.paths;
  if (!isObject(paths)) return undefined;

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!isObject(rawPathItem)) continue;
    for (const [method, rawOperation] of Object.entries(rawPathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isObject(rawOperation)) continue;
      const operationId = rawOperation.operationId;
      if (typeof operationId !== "string" || operationIdToSlug(operationId) !== operationSlug) {
        continue;
      }

      const pathItem: JsonObject = {};
      for (const [key, value] of Object.entries(rawPathItem)) {
        if (!HTTP_METHODS.has(key.toLowerCase()) || key.toLowerCase() === method.toLowerCase()) {
          pathItem[key] = value;
        }
      }

      const document: JsonObject = {};
      for (const [key, value] of Object.entries(source)) {
        if (key !== "components" && key !== "paths" && key !== "webhooks") document[key] = value;
      }
      document.paths = { [path]: pathItem };

      includeReferencedComponents(source, document, document);
      includeNamedSecuritySchemes(source, document, document);
      return { document, method: method.toLowerCase(), path };
    }
  }
  return undefined;
}
