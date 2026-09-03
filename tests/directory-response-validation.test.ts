import { describe, expect, test, vi } from "vitest";
import { buildAccountHolderDirectory } from "../src/account-holder-directory.ts";
import { buildValidatorOperatorDirectory } from "../src/validator-operator-directory.ts";
import {
  ResponseSchemaDriftError,
  validateResponseTripwire,
} from "../src/response-validation-tripwire.ts";

const registry = vi.hoisted(() => ({ reads: vi.fn() }));
vi.mock("../schemas-src/openapi-registry.ts", () => ({
  get COMPONENT_SCHEMAS_BY_ID() {
    registry.reads();
    throw new Error("unrelated registry must stay unloaded for directories");
  },
}));

describe("directory response validation without the full registry", () => {
  for (const { id, path, data, count } of [
    {
      id: "account-holder-directory",
      path: "/metagraph/accounts/directory.json",
      data: buildAccountHolderDirectory([], { priceByNetuid: new Map() }),
      count: "account_count",
    },
    {
      id: "validator-operator-directory",
      path: "/metagraph/validators/operators.json",
      data: buildValidatorOperatorDirectory(null),
      count: "operator_count",
    },
  ]) {
    test(`${id} validates good responses and rejects drift on repeated reads`, async () => {
      const envelope = {
        ok: true,
        schema_version: 1,
        data,
        meta: { contract_version: "test" },
      };
      await expect(
        validateResponseTripwire(id, envelope, path),
      ).resolves.toBeUndefined();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          validateResponseTripwire(
            id,
            { ...envelope, data: { ...data, [count]: -1 } },
            path,
          ),
        ).rejects.toBeInstanceOf(ResponseSchemaDriftError);
      }
      expect(registry.reads).not.toHaveBeenCalled();
    });
  }
});
