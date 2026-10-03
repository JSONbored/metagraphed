/** Byte requests can provide MIME parameters (notably a multipart boundary).
 * Legacy string/JSON requests retain their existing exact media matching. */
export function matchesBinaryRequestMediaType(
  contentType: string,
  declared: readonly string[],
): boolean {
  try {
    new Headers({ "content-type": contentType });
  } catch {
    return false;
  }
  const essence = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(essence) ||
    essence.split("/").includes("*")
  )
    return false;
  return declared.some((media) => {
    if (media === contentType) return true;
    // A declaration containing fixed parameters must match them exactly.
    if (media.includes(";")) return false;
    const range = media.trim().toLowerCase();
    return range === essence || range === "*/*" ||
      (range.endsWith("/*") && range.slice(0, -1) === essence.split("/", 1)[0] + "/");
  });
}
import { recordOrNull } from "./read-store.ts";

/** Resolve only references inside the captured document, without network access.
 * Cycles, missing targets and excessive chains cannot admit a request body. */
export function resolveLocalRequestBody(
  document: unknown,
  requestBody: unknown,
): Record<string, unknown> | null {
  let current = recordOrNull(requestBody);
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
      const parent = recordOrNull(target);
      if (!parent || !Object.hasOwn(parent, key)) return null;
      target = parent[key];
    }
    current = recordOrNull(target);
  }
  return null;
}
