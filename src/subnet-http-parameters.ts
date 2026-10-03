import {
  capturedSchemaObject,
  resolveLocalSchemaObject,
} from "./subnet-openapi-reference.ts";

export interface SerializedCookieGroup {
  pairs: { name: string; value: string }[];
  separator: "&" | "; ";
}

export interface SerializedHttpParameters {
  headers: Record<string, string>;
  cookies: SerializedCookieGroup[];
  redactions: string[];
}

function invalid(name: string, reason: string): never {
  throw new Error(`HTTP parameter ${JSON.stringify(name)} ${reason}.`);
}

const token = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const forbiddenHeaders =
  /^(?:accept|accept-encoding|authorization|connection|content-length|content-type|cookie|forwarded|host|origin|referer|te|trailer|transfer-encoding|upgrade|user-agent|proxy-.*|sec-.*)$/i;

function scalar(
  name: string,
  value: unknown,
  redactions: string[],
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  )
    invalid(
      name,
      "needs scalar style items; use declared content for a serialized value",
    );
  const text = String(value);
  redactions.push(text);
  return text;
}

function encode(text: string, reserved: boolean, delimiter: string): string {
  const value = encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (!reserved) return value;
  return value.replace(
    /%25([0-9a-f]{2})|%([0-9a-f]{2})/gi,
    (match, triple: string | undefined, hex: string | undefined) => {
      if (triple) return `%${triple}`;
      const char = String.fromCharCode(Number.parseInt(hex!, 16));
      return ":/?@!$'()*,".includes(char) && !delimiter.includes(char)
        ? char
        : match;
    },
  );
}

function contentValue(
  parameter: Record<string, unknown>,
  name: string,
  value: unknown,
  cookie: boolean,
  redactions: string[],
): string {
  const content = capturedSchemaObject(parameter.content);
  const media = content ? Object.keys(content) : [];
  if (parameter.schema !== undefined || media.length !== 1)
    invalid(name, "needs exactly one content media type, without schema");
  const essence = media[0]!.split(";", 1)[0]!.trim().toLowerCase();
  if (
    !cookie &&
    (essence === "application/json" || essence.endsWith("+json"))
  ) {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string") redactions.push(item);
      return item;
    });
    if (text === undefined) invalid(name, "needs a JSON value");
    // JSON escapes retain Unicode values in a byte-valued HTTP header.
    return text.replace(
      /[\u0100-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  // Cookie content has provider-specific quoting/escaping, unlike form style.
  // Preserve the caller's serialized representation, without another encoding.
  if (typeof value !== "string")
    invalid(
      name,
      "needs an already serialized string for this content media type",
    );
  return value;
}

function headerValue(
  document: unknown,
  parameter: Record<string, unknown>,
  name: string,
  value: unknown,
  redactions: string[],
): string | null {
  if (parameter.content !== undefined)
    return contentValue(parameter, name, value, false, redactions);
  if (value === null) return null;
  const swagger = capturedSchemaObject(document)?.swagger === "2.0";
  if (!swagger && (parameter.style ?? "simple") !== "simple")
    invalid(name, "needs simple header style");
  if (parameter.explode !== undefined && typeof parameter.explode !== "boolean")
    invalid(name, "needs a boolean explode value");
  let delimiter = ",";
  if (swagger) {
    const format = parameter.collectionFormat ?? "csv";
    const delimiters: Record<string, string> = {
      csv: ",",
      ssv: " ",
      tsv: "\t",
      pipes: "|",
    };
    if (typeof format !== "string" || !Object.hasOwn(delimiters, format))
      invalid(name, "needs a supported Swagger header collectionFormat");
    delimiter = delimiters[format]!;
  }
  const item = (value: unknown, key = false) => {
    const text = scalar(name, value, redactions);
    if (
      text !== null &&
      (text.includes(delimiter) ||
        (key && parameter.explode === true && text.includes("=")))
    )
      invalid(name, "needs provider-defined pre-escaping inside a collection");
    return text;
  };
  if (Array.isArray(value))
    return value
      .flatMap((value) => {
        const text = item(value);
        return text === null ? [] : [text];
      })
      .join(delimiter);
  const object = capturedSchemaObject(value);
  if (!object) return scalar(name, value, redactions);
  if (swagger) invalid(name, "cannot serialize an object as a Swagger header");
  return Object.entries(object)
    .flatMap(([key, value]) => {
      const text = item(value);
      if (text === null) return [];
      const property = item(key, true)!;
      return parameter.explode === true
        ? [`${property}=${text}`]
        : [property, text];
    })
    .join(delimiter);
}

function cookieGroup(
  parameter: Record<string, unknown>,
  name: string,
  value: unknown,
  redactions: string[],
): SerializedCookieGroup {
  if (parameter.content !== undefined) {
    if (!token.test(name))
      invalid(name, "needs a valid cookie name for content serialization");
    const text = contentValue(parameter, name, value, true, redactions);
    return { separator: "; ", pairs: [{ name, value: `${name}=${text}` }] };
  }
  const style = parameter.style ?? "form";
  if (style !== "form" && style !== "cookie")
    invalid(name, "needs form or cookie style");
  if (parameter.explode !== undefined && typeof parameter.explode !== "boolean")
    invalid(name, "needs a boolean explode value");
  if (
    parameter.allowReserved !== undefined &&
    typeof parameter.allowReserved !== "boolean"
  )
    invalid(name, "needs a boolean allowReserved value");
  const explode = parameter.explode ?? true;
  const raw = style === "cookie";
  const format = (text: string, key = false, joined = false) => {
    if (raw) {
      if (
        text.includes(";") ||
        (joined && text.includes(",")) ||
        (key && !token.test(text))
      )
        invalid(name, "needs provider-defined escaping for cookie syntax");
      return text;
    }
    return encode(
      text,
      !key && parameter.allowReserved === true,
      joined ? "," : "",
    );
  };
  const pair = (key: string, text: string) => ({
    name: key,
    value: `${format(key, true)}=${text}`,
  });
  const group: SerializedCookieGroup = {
    separator: raw ? "; " : "&",
    pairs: [],
  };
  if (value === null) return group;
  if (Array.isArray(value)) {
    const texts = value.flatMap((value) => {
      const text = scalar(name, value, redactions);
      return text === null ? [] : [text];
    });
    group.pairs =
      explode && texts.length
        ? texts.map((text) => pair(name, format(text)))
        : [
            pair(
              name,
              texts.map((text) => format(text, false, true)).join(","),
            ),
          ];
  } else {
    const object = capturedSchemaObject(value);
    if (object) {
      const entries = Object.entries(object).flatMap(([key, value]) => {
        const text = scalar(name, value, redactions);
        return text === null ? [] : [[key, text] as const];
      });
      group.pairs =
        explode && entries.length
          ? entries.map(([key, text]) => pair(key, format(text)))
          : [
              pair(
                name,
                entries
                  .flatMap(([key, text]) => [
                    format(key, true, true),
                    format(text, false, true),
                  ])
                  .join(","),
              ),
            ];
    } else group.pairs = [pair(name, format(scalar(name, value, redactions)!))];
  }
  return group;
}

/** Resolve one captured parameter list for both header and cookie inputs. */
export function serializeDeclaredHttpParameters(
  document: unknown,
  pathItem: unknown,
  operation: Record<string, unknown>,
  headerValues: Record<string, unknown> = {},
  cookieValues: Record<string, unknown> = {},
): SerializedHttpParameters {
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
      if (!parameter)
        invalid("", "has an unresolved captured parameter reference");
      if (parameter.in !== "header" && parameter.in !== "cookie") continue;
      if (typeof parameter.name !== "string")
        invalid("", "has a malformed parameter name");
      const name =
        parameter.in === "header"
          ? parameter.name.toLowerCase()
          : parameter.name;
      parameters.set(`${parameter.in}:${name}`, parameter);
    }
  }
  const result: SerializedHttpParameters = {
    headers: Object.create(null),
    cookies: [],
    redactions: [],
  };
  const occupiedHeaders = new Set<string>();
  for (const [name, value] of Object.entries(headerValues)) {
    const key = name.toLowerCase();
    if (!token.test(name) || forbiddenHeaders.test(name))
      invalid(
        name,
        "controls transport or authentication; use the dedicated request fields",
      );
    if (occupiedHeaders.has(key))
      invalid(name, "duplicates a case-insensitive header");
    occupiedHeaders.add(key);
    const parameter = parameters.get(`header:${key}`);
    if (!parameter) invalid(name, "is not declared on this captured operation");
    const text = headerValue(
      document,
      parameter,
      name,
      value,
      result.redactions,
    );
    if (text === null) continue;
    result.headers[key] = text;
    result.redactions.push(text);
  }
  const occupiedCookies = new Set<string>();
  for (const [name, value] of Object.entries(cookieValues)) {
    const parameter = parameters.get(`cookie:${name}`);
    if (!parameter || capturedSchemaObject(document)?.swagger === "2.0")
      invalid(name, "is not declared on this captured operation");
    const group = cookieGroup(parameter, name, value, result.redactions);
    for (const emitted of new Set([
      name,
      ...group.pairs.map((pair) => pair.name),
    ])) {
      if (occupiedCookies.has(emitted))
        invalid(name, "overlaps another cookie field");
      occupiedCookies.add(emitted);
    }
    for (const pair of group.pairs) {
      if (/[;\r\n]/.test(pair.value) || pair.value.includes("\0"))
        invalid(name, "needs provider-defined escaping for cookie syntax");
      result.redactions.push(pair.value.slice(pair.value.indexOf("=") + 1));
    }
    result.cookies.push(group);
  }
  // Names are tokens above; validate field bytes without constructing and
  // copying Headers objects before the actual outbound Request does that work.
  const unsafeValue = /[^\t\x20-\x7e\x80-\xff]/;
  if (
    Object.values(result.headers).some((value) => unsafeValue.test(value)) ||
    result.cookies.some((group) =>
      group.pairs.some((pair) => unsafeValue.test(pair.value)),
    )
  )
    invalid("", "contains a value that cannot be sent in an HTTP header");
  return result;
}
