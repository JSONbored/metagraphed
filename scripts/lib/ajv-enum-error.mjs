// Shared ajv enum-error message formatting for validate-schemas.mjs and
// validate-surface.mjs. Extracted so tests can exercise the contract without
// mutating live registry/subnets files (that races parallel full-registry
// validators — see validate-surface-duplicate-url + validate-error-messages).

/**
 * ajv's default `error.message` for an `enum` keyword is the unhelpful
 * "must be equal to one of the allowed values" with no indication of what
 * those values actually are. Append the allowed values (and the offending
 * value, when resolvable) for enum-keyword errors only.
 *
 * @param {import("ajv").ErrorObject} error
 * @param {unknown} document
 * @returns {string}
 */
export function formatAjvEnumErrorMessage(error, document) {
  if (error.keyword !== "enum") {
    return error.message;
  }
  const allowed = (error.params?.allowedValues || []).join(", ");
  const actual = valueAtInstancePath(document, error.instancePath);
  const gotSuffix =
    actual === undefined ? "" : ` (got ${JSON.stringify(actual)})`;
  return `${error.message}: ${allowed}${gotSuffix}`;
}

/**
 * @param {unknown} document
 * @param {string} instancePath
 * @returns {unknown}
 */
export function valueAtInstancePath(document, instancePath) {
  if (!instancePath) return undefined;
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = document;
  for (const segment of segments) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}
