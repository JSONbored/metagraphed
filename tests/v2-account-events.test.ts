import { test } from "vitest";
import { registerAccountEventChecks } from "./helpers/account-event-checks.ts";

registerAccountEventChecks((name, check) => {
  test(name, check);
});
