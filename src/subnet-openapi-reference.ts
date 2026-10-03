/** A captured schema object, resolved locally without fetches or copies. */
export function capturedSchemaObject(
  value: unknown,
): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveLocalSchemaObject(
  document: unknown,
  value: unknown,
): Record<string, unknown> | null {
  let current = capturedSchemaObject(value);
  if (!current || current.$ref === undefined) return current;
  const visited = new Set<string>();
  for (let hop = 0; hop < 32 && current; hop++) {
    if (current.$ref === undefined) return current;
    if (typeof current.$ref !== "string" || !current.$ref.startsWith("#/"))
      return null;
    const reference = current.$ref;
    if (visited.has(reference)) return null;
    visited.add(reference);
    let pointer: string;
    try {
      pointer = decodeURIComponent(reference.slice(1));
    } catch {
      return null;
    }
    let target = document;
    for (const token of pointer.slice(1).split("/")) {
      if (/~(?:[^01]|$)/.test(token)) return null;
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(target)) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(key) || !Object.hasOwn(target, key))
          return null;
        target = target[Number(key)];
      } else {
        const parent = capturedSchemaObject(target);
        if (!parent || !Object.hasOwn(parent, key)) return null;
        target = parent[key];
      }
    }
    current = capturedSchemaObject(target);
  }
  return null;
}
