import { test } from "vitest";
import { registerAccountBalanceChecks } from "./helpers/account-balance-checks.ts";
registerAccountBalanceChecks((name, check) => {
  test(name, check);
});
