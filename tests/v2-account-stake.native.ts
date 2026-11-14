import { test } from "node:test";
import { registerAccountStakeChecks } from "./helpers/account-stake-checks.ts";
registerAccountStakeChecks((name, check) => {
  void test(name, check);
});
