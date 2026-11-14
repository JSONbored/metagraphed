import { test } from "vitest";
import { registerAccountStakeChecks } from "./helpers/account-stake-checks.ts";
registerAccountStakeChecks((name, check) => {
  test(name, check);
});
