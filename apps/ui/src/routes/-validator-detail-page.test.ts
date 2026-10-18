import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  fileURLToPath(new URL("./-validators-hotkey-page.tsx", import.meta.url)),
  "utf8",
);

describe("validator detail loading contract", () => {
  it("projects the membership ledger's subnet-name lookup to its rendered fields", () => {
    expect(page).toContain('const VALIDATOR_SUBNET_NAME_FIELDS = "netuid,name"');
    expect(page).toContain(
      "subnetsQuery({ limit: SUBNETS_ALL_LIMIT, fields: VALIDATOR_SUBNET_NAME_FIELDS })",
    );
  });

  it("defers movement evidence and omits unsupported capital instruments", () => {
    expect(page).toContain("enabled: nominatorsNearViewport");
    expect(page).not.toContain("validatorHistoryQuery");
    expect(page).not.toContain("validatorOperatorDirectoryQuery");
    expect(page).not.toContain("stakeBySubnet");
  });
});
