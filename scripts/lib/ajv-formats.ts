// `ajv-formats` through its real CJS/ESM interop shape (#11339).
//
// Under NodeNext, `import addFormats from "ajv-formats"` resolves to the
// package's `module.exports` OBJECT, not to the callable inside it. Six
// validators each wrote the same cast to get past that:
//
//   const addFormats = addFormatsPlugin as unknown as (a: Ajv2020) => void;
//
// ...which is a claim about a third-party module's shape, made six times, none
// of them checked -- and each one also silenced any error in the argument at
// the call. `.default` IS the callable, and reaching for it type-checks on its
// own, so the interop is stated once here instead.
import addFormatsPlugin from "ajv-formats";
import type { Ajv2020 } from "ajv/dist/2020.js";

/** Register ajv-formats' string formats on an Ajv instance. */
export function addAjvFormats(ajv: Ajv2020): void {
  addFormatsPlugin.default(ajv);
}
