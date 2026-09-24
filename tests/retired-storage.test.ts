import { expect, it } from "vitest";
import {
  retiredStorageFindings,
  main,
} from "../scripts/validate-retired-storage.ts";
it("rejects typed calls, imported aliases, credentials and direct transport URLs", () => {
  for (const code of [
    "await r2SqlQuery<Rows>(env, sql);",
    'import {r2SqlQuery as read} from "./client.ts"; await read(env, sql);',
    'import * as sql from "./r2-sql.ts";',
    "env.R2_SQL_TOKEN;",
    'env["R2_SQL_ACCOUNT_ID"];',
    "fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${id}/r2-sql/query/bucket`);",
  ])
    expect(retiredStorageFindings(code).length).toBeGreaterThan(0);
  expect(retiredStorageFindings("r2SqlQuery(env);\nr2SqlQuery(env);")).toEqual([
    1, 2,
  ]);
});
it("permits native producer queries and catalog access, ignoring obsolete prose", () => {
  expect(
    retiredStorageFindings(
      '// r2SqlQuery and R2_SQL_TOKEN are retired\nconst query = "SELECT * FROM account_events";\nconst url="https://api.cloudflare.com/client/v4/accounts/id/r2-catalog";',
    ),
  ).toEqual([]);
  expect(main()).toBe(0);
});
