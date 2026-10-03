import {
  capturedSchemaObject,
  resolveLocalSchemaObject,
} from "./subnet-openapi-reference.ts";

export interface SerializedQueryGroup {
  replaceNames: string[];
  pairs: { name: string; encoded: string }[];
}

function invalid(name: string, reason: string): never {
  throw new Error(`query_values parameter ${JSON.stringify(name)} ${reason}.`);
}

function scalar(name: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean")
    return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return invalid(
    name,
    "needs scalar items/properties for style-based serialization; use declared JSON content for nested values",
  );
}

function encode(value: string, reserved = false, delimiter = ""): string {
  // RFC3986/RFC6570 regular expansion. Keep value commas separate from join
  // commas. Reserved expansion still escapes URI/form query syntax so values
  // cannot create parameters or fragments; valid pre-encoded triples survive.
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (!reserved) return encoded;
  return encoded.replace(
    /%25([0-9a-f]{2})|%([0-9a-f]{2})/gi,
    (match, triplet: string | undefined, hex: string | undefined) => {
      if (triplet) return `%${triplet}`;
      const char = String.fromCharCode(Number.parseInt(hex!, 16));
      return ":/?@!$'()*,;".includes(char) && !delimiter.includes(char)
        ? char
        : match;
    },
  );
}

function pair(name: string, value: string) {
  return { name, encoded: `${encode(name)}=${value}` };
}

function parameterPairs(
  document: unknown,
  parameter: Record<string, unknown>,
  name: string,
  value: unknown,
): SerializedQueryGroup["pairs"] {
  const content = capturedSchemaObject(parameter.content);
  if (parameter.content !== undefined) {
    if (parameter.schema !== undefined)
      invalid(name, "cannot declare both schema and content");
    const mediaTypes = content ? Object.keys(content) : [];
    if (mediaTypes.length !== 1)
      invalid(name, "must declare exactly one query content media type");
    const media = mediaTypes[0]!.split(";", 1)[0]!.trim().toLowerCase();
    if (media === "application/json" || media.endsWith("+json")) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) invalid(name, "must contain a JSON value");
      return [pair(name, encode(serialized))];
    }
    if (typeof value !== "string")
      invalid(name, "needs a pre-serialized string for non-JSON query content");
    return [pair(name, encode(value))];
  }
  if (value === null) return [];
  const swagger = capturedSchemaObject(document)?.swagger === "2.0";
  const style = swagger ? "form" : (parameter.style ?? "form");
  if (
    !["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(
      String(style),
    )
  )
    invalid(name, "declares an invalid query style");
  if (parameter.explode !== undefined && typeof parameter.explode !== "boolean")
    invalid(name, "declares a non-boolean explode value");
  if (
    parameter.allowReserved !== undefined &&
    typeof parameter.allowReserved !== "boolean"
  )
    invalid(name, "declares a non-boolean allowReserved value");
  const reserved = !swagger && parameter.allowReserved === true;
  const explode = !swagger && (parameter.explode ?? style === "form");
  const object = capturedSchemaObject(value);
  if (!Array.isArray(value) && !object) {
    if (style !== "form")
      invalid(name, "uses a collection style with a scalar value");
    return [pair(name, encode(scalar(name, value)!, reserved))];
  }
  if (swagger && object)
    invalid(name, "cannot use an object in a Swagger 2 query parameter");
  if (style === "deepObject") {
    if (!object) invalid(name, "needs an object for deepObject");
    return Object.entries(object).flatMap(([key, item]) => {
      if (/[[\]]/.test(key))
        invalid(
          name,
          "needs provider-defined pre-escaping for brackets in deepObject keys",
        );
      const text = scalar(name, item);
      return text === null
        ? []
        : [pair(`${name}[${key}]`, encode(text, reserved))];
    });
  }
  let delimiter =
    style === "spaceDelimited"
      ? "%20"
      : style === "pipeDelimited"
        ? "%7C"
        : ",";
  let repeated = explode === true;
  if (swagger) {
    const format = parameter.collectionFormat ?? "csv";
    const delimiters: Record<string, string> = {
      csv: ",",
      ssv: "%20",
      tsv: "%09",
      pipes: "%7C",
      multi: "",
    };
    if (typeof format !== "string" || !Object.hasOwn(delimiters, format))
      invalid(name, "declares an invalid Swagger collectionFormat");
    delimiter = delimiters[format]!;
    repeated = format === "multi";
  } else if (style !== "form" && repeated) {
    invalid(name, "uses an undefined exploded delimited style");
  }
  const ambiguous =
    delimiter === "%20"
      ? " "
      : delimiter === "%7C"
        ? "|"
        : delimiter === "%09"
          ? "\t"
          : "";
  const encodeItem = (text: string, key = false) => {
    if (ambiguous && text.includes(ambiguous))
      invalid(
        name,
        "needs provider-defined pre-escaping for delimiter characters inside delimited items",
      );
    return encode(text, key ? false : reserved, delimiter === "," ? "," : "");
  };
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      const text = scalar(name, item);
      return text === null ? [] : [text];
    });
    if (repeated)
      return items.map((text) => pair(name, encode(text, reserved)));
    return items.length
      ? [pair(name, items.map((text) => encodeItem(text)).join(delimiter))]
      : [];
  }
  const entries = Object.entries(object!).flatMap(([key, item]) => {
    const text = scalar(name, item);
    return text === null ? [] : [[key, text] as const];
  });
  if (repeated)
    return entries.map(([key, text]) => pair(key, encode(text, reserved)));
  return entries.length
    ? [
        pair(
          name,
          entries
            .flatMap(([key, text]) => [encodeItem(key, true), encodeItem(text)])
            .join(delimiter),
        ),
      ]
    : [];
}

/** Serialize only parameters declared on the admitted captured operation.
 * Path-level declarations apply first; operation-level query declarations override.
 * Parameter and path-item references remain local, bounded and source-owned. */
export function serializeDeclaredQuery(
  document: unknown,
  pathItem: unknown,
  operation: Record<string, unknown>,
  values: Record<string, unknown>,
  legacyQuery?: Record<string, string | number | boolean>,
): SerializedQueryGroup[] {
  const parameters = new Map<string, Record<string, unknown>>();
  for (const list of [
    capturedSchemaObject(pathItem)?.parameters,
    operation.parameters,
  ]) {
    if (list === undefined) continue;
    if (!Array.isArray(list))
      invalid("", "has a malformed captured parameter list");
    for (const entry of list) {
      const parameter = resolveLocalSchemaObject(document, entry);
      if (parameter?.in === "query" && typeof parameter.name === "string")
        parameters.set(parameter.name, parameter);
    }
  }
  const groups: SerializedQueryGroup[] = [];
  const occupied = new Set(Object.keys(legacyQuery ?? {}));
  for (const [name, value] of Object.entries(values)) {
    const parameter = parameters.get(name);
    if (!parameter) invalid(name, "is not declared on this captured operation");
    const pairs = parameterPairs(document, parameter, name, value);
    const names = new Set([name, ...pairs.map((entry) => entry.name)]);
    for (const emitted of names) {
      if (occupied.has(emitted)) invalid(name, "overlaps another query field");
      occupied.add(emitted);
    }
    groups.push({ replaceNames: [...names], pairs });
  }
  return groups;
}

/** Keep existing raw query pieces, replace declared fields, then attach credentials
 * last. Re-serializing URLSearchParams here would escape structural join commas. */
export function applySerializedQuery(
  url: URL,
  groups: readonly SerializedQueryGroup[],
  credentials: readonly [string, string][],
): void {
  const credentialNames = new Set(credentials.map(([name]) => name));
  const replaced = new Set([
    ...credentialNames,
    ...groups.flatMap((group) => group.replaceNames),
  ]);
  const pieces = url.search
    ? url.search
        .slice(1)
        .split("&")
        .filter((piece) => {
          const name = new URLSearchParams(piece).keys().next().value;
          return name === undefined || !replaced.has(name);
        })
    : [];
  for (const group of groups)
    for (const entry of group.pairs)
      if (!credentialNames.has(entry.name)) pieces.push(entry.encoded);
  for (const [name, value] of credentials)
    pieces.push(new URLSearchParams([[name, value]]).toString());
  url.search = pieces.join("&");
}
