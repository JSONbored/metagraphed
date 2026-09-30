import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retired website GraphQL editor dependency boundary", () => {
  it("removes editor packages while preserving the API/MCP engine", () => {
    const ui = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(
      readFileSync(new URL("../../../../../package-lock.json", import.meta.url), "utf8"),
    );
    for (const name of ["graphiql", "graphql", "graphql-ws"]) {
      expect(ui.dependencies).not.toHaveProperty(name);
      expect(lock.packages["apps/ui"].dependencies).not.toHaveProperty(name);
    }
    const editors = Object.keys(lock.packages).filter((name) =>
      /node_modules\/(?:@graphiql\/|graphiql$|codemirror(?:-graphql)?$|graphql-language-service$)/.test(
        name,
      ),
    );
    expect(editors).toEqual([]);
    expect(lock.packages[""].dependencies).toHaveProperty("graphql");
    expect(lock.packages[""].dependencies).toHaveProperty("graphql-ws");
  });
});
