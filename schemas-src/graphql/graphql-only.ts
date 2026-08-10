// The three shapes only GraphQL publishes (#10409).
//
// Every other published type comes from a route's Zod component. These three do
// not, because no route serves them: `OpportunityBoards` is a re-key of the
// leaderboards record, `EmissionGateChange` is the flattened form of a union
// REST serves un-flattened, and `ChainEvent` is a WebSocket payload with no
// REST equivalent at all. They sat in `RESOLVER_BUILT_TYPES` -- the list of
// types NO gate reaches -- and an over-promise in any of them (the class that
// nulled `SelfHealthLane.detail` on every request, #10215) was invisible.
//
// WHY THEY LIVE IN THE SHARED REGISTRY, not a GraphQL-only one. A second
// registry would be a second `$ref` namespace, and these shapes reference the
// first: `EmissionGateChange` is built FROM the three arms
// `EmissionGateChangesArtifact` already models, and the leaderboard rows are
// the ones `/api/v1/registry/leaderboards` serves. Cross-registry refs do not
// resolve, so the GraphQL-only copies would have to restate the shapes they
// reference -- which is the duplication this epic exists to delete. The
// registry is the contract, not the REST contract: it already emits the MCP
// output schemas and the GraphQL type system from the same nodes.
// `GenericArtifact` is the standing precedent for a registered component no
// route serves.
//
// NOTHING HERE IS HAND-RESTATED WHERE IT CAN BE DERIVED. `EmissionGateChange`
// is computed from the three arm schemas, so a field added to any arm appears
// in the GraphQL type and the parity gate fails until the SDL publishes it.
import { z } from "zod";
import {
  EmissionFlowChangeSchema,
  EmissionParamChangeSchema,
  EmissionSubnetChangeSchema,
} from "../routes/emission-gate-changes.ts";
import { SubnetDetailArtifactSchema } from "../routes/subnet-detail.ts";

// ── Query.opportunity_boards ─────────────────────────────────────────────────

/** The six economic boards `formatLeaderboards` always materializes. */
export const OPPORTUNITY_BOARDS = [
  "open_slots",
  "cheapest_registration",
  "highest_emission",
  "validator_headroom",
  "biggest_alpha_gain_1d",
  "biggest_alpha_gain_7d",
] as const;

/**
 * One ranked row, which is the subnet's economics card plus the headroom the
 * ranker derives -- exactly what `OpportunityEntry` is already declared as a
 * projection of, taken from the same component so the two cannot diverge.
 */
const OpportunityEntrySchema =
  SubnetDetailArtifactSchema.shape.economics.unwrap();

/**
 * The resolver's re-key of `RegistryLeaderboardsArtifact.boards`.
 *
 * The artifact keys its boards by NAME -- "open-slots", "cheapest-registration"
 * -- which are not valid GraphQL field names, so the record stays JSON on the
 * REST mirror and the resolver names the six it publishes. The same reshape
 * `SubnetTrajectoryDelta` needed for its window keys, and the same fix:
 * register the value so the published type has something to be checked
 * against.
 *
 * Every board is non-optional because `formatLeaderboards` always materializes
 * every economic key, possibly as `[]` -- the resolver relies on that and says
 * so (src/graphql.ts, "no `|| []` fallback -- that branch is unreachable").
 */
export const OpportunityBoardsSchema = z
  .object({
    observed_at: z.string().nullable(),
    with_economics_count: z.int().min(0),
    ...Object.fromEntries(
      OPPORTUNITY_BOARDS.map((board) => [
        board,
        z.array(OpportunityEntrySchema),
      ]),
    ),
  })
  .describe(
    "The economic opportunity boards, ranked. The same ranking " +
      "/api/v1/registry/leaderboards serves, re-keyed to GraphQL field names.",
  );

// ── Query.emission_gate_changes.changes ──────────────────────────────────────

/** The four every arm carries, which stay required. */
const SHARED_CHANGE_FIELDS: readonly string[] = [
  "kind",
  "observed_at",
  "block_number",
  "predates_capture",
];

const EMISSION_ARMS = [
  EmissionParamChangeSchema,
  EmissionSubnetChangeSchema,
  EmissionFlowChangeSchema,
];

/**
 * The three arms of the emission-gate change union, flattened into one type.
 *
 * REST serves the union un-flattened: a `param` entry has no `netuid`, a
 * `subnet` entry has no numeric `value`, and each row carries only its own
 * fields -- absent, not null, because absent says "this kind has no such
 * thing" where null would say "it has one and we do not know it". GraphQL has
 * no way to express that in a selection set a client can write once, so the
 * SDL publishes one type with the arm-specific fields nullable.
 *
 * DERIVED from the three, never restated. A field added to any arm shows up
 * here, and `validate:graphql-component-parity` then fails until the SDL
 * publishes it -- which is the whole difference between this and the hand
 * -written type it replaces.
 */
export const EmissionGateChangeSchema = z
  .object({
    ...Object.fromEntries(
      SHARED_CHANGE_FIELDS.map((name) => [
        name,
        EmissionParamChangeSchema.shape[
          name as keyof typeof EmissionParamChangeSchema.shape
        ] as z.ZodType,
      ]),
    ),
    // Every arm-specific field, made OPTIONAL on top of the `.nullable()` it
    // already carries. That is not a loosening: a row from the `param` arm has
    // no `netuid` key at all, and the route schema says why -- absent means
    // "this kind has no such thing" where null would mean "it has one and we
    // do not know it". GraphQL cannot express the difference, so the published
    // field is nullable either way; requiring the key here would reject every
    // real row. `netuid` is on two arms with the same type, so the spread
    // order does not matter.
    ...Object.fromEntries(
      EMISSION_ARMS.flatMap((arm) =>
        Object.entries(arm.shape)
          .filter(([name]) => !SHARED_CHANGE_FIELDS.includes(name))
          .map(([name, field]) => [name, (field as z.ZodType).optional()]),
      ),
    ),
  })
  .describe(
    "One recorded change to the emission gate. Shape varies by kind: a param " +
      "entry has no netuid, a subnet entry has no numeric value.",
  );

// ── Subscription.chainEvents ─────────────────────────────────────────────────

/**
 * The #4980 NOTIFY payload the chain firehose broadcasts.
 *
 * No REST route serves it -- it exists only on the WebSocket transport -- and
 * the four source tables carry different columns, so everything past `table`
 * and `block_number` is nullable AND optional: `enqueue_chain_firehose()`'s
 * jsonb_build_object emits only the columns of the table an event came from,
 * so a `blocks` payload has no `extrinsic_index` KEY rather than a null one.
 * Those two are the only fields the hand-written ingest check requires, and
 * they are the only two the SDL declares non-null. `workers/chain-firehose-hub.ts` validates
 * the ingest side with a hand-written check that bounds every field to a
 * scalar without enumerating them; `tests/graphql-only-schemas.test.ts` holds
 * the two to the same vocabulary so they cannot drift apart.
 */
export const ChainFirehoseEventSchema = z
  .object({
    table: z
      .enum(["blocks", "extrinsics", "chain_events", "account_events"])
      .describe("Which source table this event came from."),
    block_number: z.int().min(0),
    observed_at: z.string().nullable().optional(),
    block_hash: z.string().nullable().optional().describe("blocks only"),
    extrinsic_count: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("blocks only"),
    event_count: z.int().min(0).nullable().optional().describe("blocks only"),
    extrinsic_index: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("extrinsics only"),
    call_module: z.string().nullable().optional().describe("extrinsics only"),
    call_function: z.string().nullable().optional().describe("extrinsics only"),
    signer: z.string().nullable().optional().describe("extrinsics only"),
    success: z.boolean().nullable().optional().describe("extrinsics only"),
    event_index: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("chain_events / account_events (event index within the block)"),
    pallet: z.string().nullable().optional().describe("chain_events only"),
    method: z.string().nullable().optional().describe("chain_events only"),
    event_kind: z
      .string()
      .nullable()
      .optional()
      .describe(
        "account_events only -- the curated kind (e.g. Transfer, StakeAdded)",
      ),
    hotkey: z.string().nullable().optional().describe("account_events only"),
    coldkey: z.string().nullable().optional().describe("account_events only"),
    netuid: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("account_events only"),
    amount_tao: z
      .number()
      .nullable()
      .optional()
      .describe("account_events only"),
  })
  .describe(
    "One live chain event as the firehose broadcasts it. Only the fields " +
      "relevant to the event's table are populated.",
  );
