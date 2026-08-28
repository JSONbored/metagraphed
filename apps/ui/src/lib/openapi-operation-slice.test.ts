import { describe, expect, it } from "vitest";
import { operationIdToSlug, sliceOpenAPIDocumentForOperation } from "./openapi-operation-slice";

describe("operationIdToSlug", () => {
  it("matches the OpenAPI docs generator's route transform", () => {
    expect(operationIdToSlug("subnetsByNetwork")).toBe("subnets-by-network");
    expect(operationIdToSlug("getSs58Profile")).toBe("get-ss-58-profile");
  });
});

describe("sliceOpenAPIDocumentForOperation", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Example", version: "1" },
    security: [{ bearer: [] }],
    paths: {
      "/wanted": {
        parameters: [{ $ref: "#/components/headers/Trace" }],
        get: {
          operationId: "wantedOperation",
          responses: {
            200: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Envelope" } },
              },
            },
          },
        },
        post: { operationId: "otherMethod", responses: { 204: {} } },
      },
      "/unrelated": {
        get: {
          operationId: "unrelatedOperation",
          responses: { 200: { $ref: "#/components/schemas/Unrelated" } },
        },
      },
    },
    components: {
      headers: { Trace: { schema: { type: "string" } } },
      schemas: {
        Envelope: { properties: { data: { $ref: "#/components/schemas/Item" } } },
        Item: {
          discriminator: { mapping: { special: "#/components/schemas/SpecialItem" } },
          type: "object",
        },
        SpecialItem: { type: "object" },
        Unrelated: { type: "object" },
      },
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        unused: { type: "apiKey", in: "header", name: "x-unused" },
      },
    },
  };

  it("keeps the selected method, path-level data, and transitive local references", () => {
    const result = sliceOpenAPIDocumentForOperation(document, "wanted-operation");

    expect(result?.path).toBe("/wanted");
    expect(result?.method).toBe("get");
    expect(result?.document.paths).toEqual({
      "/wanted": {
        parameters: [{ $ref: "#/components/headers/Trace" }],
        get: document.paths["/wanted"].get,
      },
    });
    expect(result?.document.components).toEqual({
      headers: { Trace: document.components.headers.Trace },
      schemas: {
        Envelope: document.components.schemas.Envelope,
        Item: document.components.schemas.Item,
        SpecialItem: document.components.schemas.SpecialItem,
      },
      securitySchemes: { bearer: document.components.securitySchemes.bearer },
    });
  });

  it("does not retain unrelated paths, methods, or components", () => {
    const result = sliceOpenAPIDocumentForOperation(document, "wanted-operation")!;
    const serialized = JSON.stringify(result.document);

    expect(serialized).not.toContain("/unrelated");
    expect(serialized).not.toContain("otherMethod");
    expect(serialized).not.toContain("Unrelated");
    expect(serialized).not.toContain("x-unused");
  });

  it("returns undefined when the generated page no longer exists in the contract", () => {
    expect(sliceOpenAPIDocumentForOperation(document, "missing-operation")).toBeUndefined();
  });
});
