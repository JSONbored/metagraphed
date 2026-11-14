import { test } from "node:test";
import { registerAccountEventChecks } from "./helpers/account-event-checks.ts";

registerAccountEventChecks((name, check) => {
  void test(name, check);
});
