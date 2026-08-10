// #10444: turn one probed payload into dated revenue observations, or into a
// stated reason it could not.
//
// Pure and injected-free on purpose: the probe lane's fetching, hashing and
// persistence are separable concerns, and this is the part where being wrong is
// silent. Every failure mode here has the same shape -- a number that looks
// plausible and is not revenue -- so the module refuses rather than guesses.
//
// The two rules it exists to enforce:
//
//   1. A FAILURE IS NEVER A ZERO. A missing field, a wrong payload type, a
//      non-numeric value: each returns a reason, not 0. A zero is a real
//      measurement meaning "earned nothing today", and a subnet that earned
//      nothing is a different fact from a subnet whose feed broke. Collapsing
//      them would understate coverage silently and permanently.
//   2. `excludes` is SUBTRACTED, not ignored. Chutes' `sponsored_inference` is
//      inference the subnet funds itself and `pending_instance_revenue` is
//      unrecognised; leaving them in overstates external revenue by whatever
//      they happen to be that day.
import { REVENUE_SHAPES, type RevenueShape } from "./revenue-shape.ts";

export interface RevenueDeclaration {
  shape?: RevenueShape;
  currency?: string;
  fields?: Record<string, string>;
  excludes?: string[];
}

export interface RevenueObservation {
  /** The period this row covers, verbatim from the payload. Null for a scalar
   * total, which carries no period of its own. */
  period: string | null;
  amount: number;
  currency: string;
}

export type ExtractResult =
  | { ok: true; observations: RevenueObservation[] }
  | { ok: false; reason: string };

function fail(reason: string): ExtractResult {
  return { ok: false, reason };
}

/** A finite number, or null. Rejects NaN, Infinity, numeric strings and null --
 * a string that parses is still a payload that changed shape. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Net amount for one record: the declared amount field minus every declared
 * exclusion. A missing exclusion is not an error -- a feed that stops emitting
 * `sponsored_inference` on a day it sponsored nothing is behaving correctly --
 * but a PRESENT and non-numeric one is, because that means the payload changed
 * under a declaration that still claims to understand it.
 */
function netAmount(
  record: Record<string, unknown>,
  amountField: string,
  excludes: string[],
): number | string {
  const gross = finiteNumber(record[amountField]);
  if (gross === null) {
    return `field "${amountField}" is missing or not a finite number`;
  }
  let net = gross;
  for (const key of excludes) {
    if (!(key in record)) continue;
    const excluded = finiteNumber(record[key]);
    if (excluded === null) {
      return `exclusion "${key}" is present but not a finite number`;
    }
    net -= excluded;
  }
  return net;
}

/**
 * Extract observations from a probed payload against its declaration.
 *
 * `currency` is required: an amount with no unit is the trap this whole schema
 * exists to close, so it is refused here too rather than defaulted to USD.
 */
export function extractRevenue(
  declaration: RevenueDeclaration,
  payload: unknown,
): ExtractResult {
  const { shape, currency, excludes = [] } = declaration;
  if (!shape) return fail("no shape declared");
  // Checked against the vocabulary rather than assumed, because keyed-map is
  // the fallthrough below: a typo'd shape would otherwise be silently treated
  // as one and yield plausible numbers from the wrong reading of the payload.
  // The schema constrains the value in the registry; nothing constrains what
  // reaches this function.
  if (!(REVENUE_SHAPES as readonly string[]).includes(shape)) {
    return fail(`unknown shape "${shape}"`);
  }
  if (!currency) return fail("no currency declared");
  const fields = declaration.fields ?? {};

  if (shape === "flat-array") {
    if (!Array.isArray(payload)) return fail("expected an array payload");
    const dateField = fields.date;
    const amountField = fields.amount;
    if (!dateField || !amountField) {
      return fail("flat-array needs both fields.date and fields.amount");
    }
    const observations: RevenueObservation[] = [];
    for (const [index, row] of payload.entries()) {
      if (!isRecord(row)) return fail(`row ${index} is not an object`);
      const period = row[dateField];
      if (typeof period !== "string" || period === "") {
        return fail(`row ${index}: field "${dateField}" is not a string`);
      }
      const amount = netAmount(row, amountField, excludes);
      if (typeof amount === "string") return fail(`row ${index}: ${amount}`);
      observations.push({ period, amount, currency });
    }
    return { ok: true, observations };
  }

  if (shape === "scalar") {
    if (!isRecord(payload)) return fail("expected an object payload");
    const amountField = fields.amount;
    if (!amountField) return fail("scalar needs fields.amount");
    const amount = netAmount(payload, amountField, excludes);
    if (typeof amount === "string") return fail(amount);
    return { ok: true, observations: [{ period: null, amount, currency }] };
  }

  // keyed-map: {period: amount} or {period: {subkey: amount}}. The period is
  // the key, so there are no field names -- see #10525.
  if (!isRecord(payload)) return fail("expected an object payload");
  const observations: RevenueObservation[] = [];
  for (const [period, value] of Object.entries(payload)) {
    const direct = finiteNumber(value);
    if (direct !== null) {
      observations.push({ period, amount: direct, currency });
      continue;
    }
    if (!isRecord(value)) {
      return fail(`key "${period}" is neither a number nor an object`);
    }
    // A nested map is summed across its subkeys -- SN51 splits a month across
    // validator coldkeys, and the subnet's figure is their total.
    let sum = 0;
    for (const [subkey, inner] of Object.entries(value)) {
      const n = finiteNumber(inner);
      if (n === null) {
        return fail(`key "${period}.${subkey}" is not a finite number`);
      }
      sum += n;
    }
    observations.push({ period, amount: sum, currency });
  }
  return { ok: true, observations };
}
