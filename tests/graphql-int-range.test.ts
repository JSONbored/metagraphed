// The Int-range gate (#10386): does it actually fail?
//
// A gate only ever run against a passing tree proves nothing, so every test
// here drives `findOverflows` with a payload that SHOULD trip it and asserts
// it does -- plus the emitter assertions that pin the fix itself, so an
// `EpochMillis` field silently reverting to `z.int()` fails here rather than
// in production on the first query that selects it.
import { describe, expect, it } from "vitest";
import {
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from "graphql";
import {
  GRAPHQL_MAX_INT,
  dataComponent,
  findOverflows,
} from "../scripts/check-graphql-int-range.ts";
import { emitTypes } from "../schemas-src/graphql/emit.ts";

const EPOCH_MS = 1786323600000;

const Candle = new GraphQLObjectType({
  name: "Candle",
  fields: {
    bucket_start: { type: new GraphQLNonNull(GraphQLInt) },
    safe_start: { type: new GraphQLNonNull(GraphQLFloat) },
    event_count: { type: new GraphQLNonNull(GraphQLInt) },
  },
});
const Artifact = new GraphQLObjectType({
  name: "Artifact",
  fields: {
    candles: { type: new GraphQLList(new GraphQLNonNull(Candle)) },
    netuid: { type: GraphQLInt },
  },
});

describe("findOverflows", () => {
  it("reports an Int field carrying an epoch-millisecond value", () => {
    const found = findOverflows(
      {
        netuid: 1,
        candles: [
          { bucket_start: EPOCH_MS, safe_start: EPOCH_MS, event_count: 4 },
        ],
      },
      Artifact,
      "/api/v1/subnets/{netuid}/ohlc",
    );
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe("Candle.bucket_start");
    expect(found[0].value).toBe(EPOCH_MS);
    expect(found[0].path).toBe(".candles[].bucket_start");
  });

  it("says nothing about the same value published as Float", () => {
    const found = findOverflows(
      { candles: [{ bucket_start: 1, safe_start: EPOCH_MS, event_count: 4 }] },
      Artifact,
      "/route",
    );
    expect(found).toEqual([]);
  });

  it("passes at the boundary and fails one past it", () => {
    const at = findOverflows({ netuid: GRAPHQL_MAX_INT }, Artifact, "/route");
    expect(at).toEqual([]);
    const past = findOverflows(
      { netuid: GRAPHQL_MAX_INT + 1 },
      Artifact,
      "/route",
    );
    expect(past).toHaveLength(1);
  });

  it("catches a NEGATIVE value past the range too", () => {
    const found = findOverflows(
      { netuid: -(GRAPHQL_MAX_INT + 1) },
      Artifact,
      "/route",
    );
    expect(found).toHaveLength(1);
  });

  it("reports every offending element, not just the first", () => {
    const found = findOverflows(
      {
        candles: [
          { bucket_start: EPOCH_MS, safe_start: 0, event_count: 1 },
          { bucket_start: EPOCH_MS + 1, safe_start: 0, event_count: 1 },
        ],
      },
      Artifact,
      "/route",
    );
    expect(found).toHaveLength(2);
  });

  it("ignores a response key the component does not publish", () => {
    // REST may serve more than GraphQL exposes. A key with no field can never
    // be selected, so it can never overflow -- reporting it would be noise.
    const found = findOverflows(
      { rest_only_epoch: EPOCH_MS },
      Artifact,
      "/route",
    );
    expect(found).toEqual([]);
  });
});

describe("dataComponent", () => {
  it("reads the component a route's data property refs", () => {
    expect(
      dataComponent(
        {
          paths: {
            "/r": {
              get: {
                responses: {
                  "200": {
                    content: {
                      "application/json": {
                        schema: {
                          allOf: [
                            {},
                            {
                              properties: {
                                data: { $ref: "#/components/schemas/Thing" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/r",
      ),
    ).toBe("Thing");
  });

  it("answers null for a route with no data ref", () => {
    expect(dataComponent({ paths: {} }, "/r")).toBeNull();
  });
});

describe("the emitted types (#10386)", () => {
  const { types } = emitTypes();

  // The eight production proved overflow, plus the seven the deleted `_at`
  // rule used to rescue -- named individually so a revert names the field it
  // broke rather than a count.
  const INSTANTS: [string, string][] = [
    ["SubnetOhlcArtifactCandles", "bucket_start"],
    ["RpcUsageArtifactBuckets", "ts"],
    ["RpcUsageArtifactCoverage", "start"],
    ["RpcUsageArtifactCoverage", "end"],
    ["RpcUsageArtifactCoverageSegments", "start"],
    ["RpcUsageArtifactCoverageSegments", "end"],
    ["RpcUsageArtifactCoverageLatencyPercentiles", "start"],
    ["RpcUsageArtifactCoverageLatencyPercentiles", "end"],
    ["RpcUsageArtifact", "observed_at"],
    ["GlobalIncidentsArtifactSurfacesIncidents", "started_at"],
    ["GlobalIncidentsArtifactSurfacesIncidents", "ended_at"],
    ["HealthIncidentsArtifactSurfacesIncidents", "started_at"],
    ["HealthIncidentsArtifactSurfacesIncidents", "ended_at"],
    ["ChainEventsFeedArtifactEvents", "observed_at"],
    ["BlockChainEventsArtifactEvents", "observed_at"],
  ];

  it.each(INSTANTS)("%s.%s is a Float, not a 32-bit Int", (type, field) => {
    const emitted = types.get(type);
    expect(emitted, `${type} is not an emitted type`).toBeDefined();
    expect(String(emitted!.getFields()[field]?.type)).toMatch(/^Float!?$/);
  });

  it("a DURATION stays an Int -- a span is not an instant", () => {
    const incident = types.get("GlobalIncidentsArtifactSurfacesIncidents")!;
    expect(String(incident.getFields().duration_ms.type)).toBe("Int!");
  });

  it("EpochMillis is a scalar, never published as an object type", () => {
    expect(types.has("EpochMillis")).toBe(false);
  });
});
