export { resolveLocalSchemaObject as resolveLocalRequestBody } from "./subnet-openapi-reference.ts";

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
    return (
      range === essence ||
      range === "*/*" ||
      (range.endsWith("/*") &&
        range.slice(0, -1) === essence.split("/", 1)[0] + "/")
    );
  });
}
