import { test } from "node:test";
import { registerAccountBalanceChecks } from "./helpers/account-balance-checks.ts";
registerAccountBalanceChecks((name, check) => {
  void test(name, check);
});
