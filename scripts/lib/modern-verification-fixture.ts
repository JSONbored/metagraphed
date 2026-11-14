import assert from "node:assert/strict";
import type { V2QueryExecutor } from "../../src/v2/shared.ts";
import {
  V2AccountStakeEntrySchema,
  type V2AccountStakeEntry,
} from "../../schemas-src/v2/stake.ts";
import {
  accountStakeKey,
  compareAccountStakeKeys,
} from "../../src/v2/account-stake-cursor.ts";
import {
  canonicalSubnet,
  ecosystemFixture,
} from "./modern-ecosystem-fixture.ts";

// Controlled database read results only. No fixture is installed in a registry,
// published, sent to a provider, or presented as PostgreSQL/native acceptance.
export const MODERN_FIXTURE = {
  origin: "https://example.test",
  now: "2026-11-06T14:00:00.000Z",
  expires: "2026-11-07T14:00:00.000Z",
  publication: "2".repeat(64),
  ecosystemPublication: "a".repeat(64),
  registrationCounter: "7",
  catalog: "4".repeat(64),
  capture: "3".repeat(64),
  blockHash: `0x${"1".repeat(64)}`,
  registration: "42",
  schema:
    '{"openapi":"3.1.0","info":{"title":"Controlled validation API","version":"1"},"paths":{"/status":{"get":{"operationId":"status","responses":{"200":{"description":"OK"}}}},"/infer":{"post":{"operationId":"infer","responses":{"200":{"description":"OK"}}}}}}',
  schemaDigest:
    "a282c9f90a033ee097f300fbfbfb922cc64d18b47c55d64fcfe077e1f2d25c79",
} as const;

export const MODERN_REGISTERED_NETUIDS = [
  0,
  ...Array.from({ length: 128 }, (_, index) => index + 1),
  200,
];

/** Source-shaped controlled rows only; these do not qualify producer custody. */
export function modernAccountStakeRow(account = `0x${"a".repeat(64)}`) {
  const genesis = `0x${"0".repeat(64)}`;
  const stateId = "c".repeat(64);
  const stateMetadata = "d".repeat(64);
  const little = (value: bigint, bytes: number) =>
    "0x" +
    BigInt.asUintN(bytes * 8, value)
      .toString(16)
      .padStart(bytes * 2, "0")
      .match(/../g)!
      .reverse()
      .join("");
  const absent = { status: "absent_in_complete_census" };
  const stored = (scale_hex: string) => ({ status: "stored", scale_hex });
  const shares = {
    encoding: "safe_float_v2",
    mantissa: "1000000000000000000000",
    exponent: "-21",
  };
  const rawShare =
    little(1000000000000000000000n, 16) + little(-21n, 8).slice(2);
  const position = (hotkey: string, retired = false) =>
    V2AccountStakeEntrySchema.parse({
      kind: "position",
      position: {
        hotkey,
        coldkey: account,
        netuid: 0,
        subnet: {
          status: "same_snapshot",
          generation: { netuid: 0, registration_counter: "0" },
          counter_source: "stored",
          baseline_history_unqualified: false,
          lifecycle: "started",
          operational: true,
        },
        asset: { kind: "tao", genesis_hash: genesis, unit: "rao" },
        selection: { member: "v2", denominator: "v2" },
        observations: {
          legacy_member: absent,
          v2_member: stored(rawShare),
          member_epoch: stored(little(retired ? 1n : 0n, 8)),
          legacy_denominator: absent,
          v2_denominator: stored(rawShare),
          pool_epoch: stored(little(retired ? 2n : 0n, 8)),
          pool_balance: stored(little(100n, 8)),
        },
        assessment: {
          status: "assessed",
          share_state: retired ? "retired" : "current",
          member: shares,
          denominator: shares,
          pool_epoch: retired ? "2" : "0",
          member_epoch: retired ? "1" : "0",
        },
        quote: retired
          ? { status: "no_current_position", state: "retired" }
          : {
              status: "exact",
              basis: { kind: "root_tao" },
              atomic_units: "100",
            },
      },
    });
  const claimOnly = account === `0x${"b".repeat(64)}`;
  const root = V2AccountStakeEntrySchema.parse({
    kind: "root_entitlement",
    entitlement: {
      snapshot_id: stateId,
      key: { hotkey: `0x${"0".repeat(64)}`, coldkey: account },
      principal: claimOnly
        ? { status: "absent_in_complete_join" }
        : { status: "exact_rao", value: "100" },
      outcome: {
        status: "assessed",
        value: {
          profile_revision: "subtensor-488-root-basket-v1",
          upstream_revision: "b6a81d144078eac18bd25c3af7cb31579bb670f3",
          qualification: "metadata_qualified_source_candidate",
          metadata_layout_qualified: true,
          layout_snapshot_id: stateId,
          runtime_semantics_attested: false,
          state_proof_verified: false,
          at_hash: MODERN_FIXTURE.blockHash,
          state_metadata_sha256: stateMetadata,
          hotkey_hex: `0x${"0".repeat(64)}`,
          coldkey_hex: account,
          root_principal_rao: claimOnly ? "0" : "100",
          basket_claimed_shares: claimOnly ? "-37" : "5",
          basket_claimed_correction_shares: "0",
          basket_owed_shares: claimOnly ? "37" : "20",
          basket_shares_capped: claimOnly ? "37" : "20",
          basket_shares_total: "50",
          deferred_alpha: [
            { netuid: 1, generation: "9", alpha_atomic: claimOnly ? "1" : "3" },
          ],
          deferred_cash_rao: claimOnly ? "9" : "49",
          deferred_cash_claimed_settled_rao: claimOnly ? "-9" : "1",
        },
      },
    },
  });
  const entries: V2AccountStakeEntry[] =
    account === `0x${"c".repeat(64)}`
      ? []
      : claimOnly
        ? [root]
        : [
            position(`0x${"0".repeat(64)}`),
            root,
            position(`0x${"1".repeat(64)}`, true),
          ];
  return {
    network: { id: "finney", genesis_hash: genesis },
    snapshot: {
      block_number: "123",
      block_hash: MODERN_FIXTURE.blockHash,
      parent_hash: `0x${"9".repeat(64)}`,
      metadata_digest: "5".repeat(64),
      spec_version: 486,
      transaction_version: 1,
      producer_revision: "6".repeat(40),
      publication_id: MODERN_FIXTURE.publication,
      observed_at: MODERN_FIXTURE.now,
      published_at: MODERN_FIXTURE.now,
    },
    stake: {
      publication_id: "e".repeat(64),
      generation: "3",
      source_id: "f".repeat(64),
      root_candidate_id: "1".repeat(64),
      request_id: "7".repeat(64),
      stake_candidate_id: "8".repeat(64),
      ecosystem_candidate_id: "9".repeat(64),
      block_publication_id: MODERN_FIXTURE.publication,
      projection_contract: 1,
      producer_revision: "b".repeat(64),
      observed_at: MODERN_FIXTURE.now,
      published_at: MODERN_FIXTURE.now,
      qualification: "source_reviewed_candidate",
      state_proof_verified: false,
      runtime_semantics_attested: false,
      census_complete: true,
      account_scope: "coldkey",
      member_count: "2",
      claimant_count: "2",
      state: {
        snapshot_id: stateId,
        block_number: "123",
        block_hash: MODERN_FIXTURE.blockHash,
        metadata_digest: stateMetadata,
        spec_version: 488,
        transaction_version: 1,
        producer_revision: "a".repeat(40),
        observed_at: MODERN_FIXTURE.now,
      },
    },
    finalized_observed_height: "123",
    finalized_observed_hash: MODERN_FIXTURE.blockHash,
    finalized_observed_at: MODERN_FIXTURE.now,
    within_budget: true,
    has_more: false,
    entries,
  };
}

export type ModernVerificationFault =
  | "old_registration"
  | "catalog_identity"
  | "schema_digest"
  | "remote_reference"
  | "unsafe_example"
  | "registry_coverage";

export function modernVerificationFixture(fault?: ModernVerificationFault) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const subnets = MODERN_REGISTERED_NETUIDS.map((netuid) =>
    canonicalSubnet({
      netuid,
      counter: netuid === 200 ? MODERN_FIXTURE.registrationCounter : "0",
      registrationBlock:
        netuid === 200 ? Number(MODERN_FIXTURE.registration) : 0,
    }),
  );
  const published = {
    network_id: "finney",
    genesis_hash: `0x${"0".repeat(64)}`,
    block_number: "123",
    block_hash: MODERN_FIXTURE.blockHash,
    parent_hash: `0x${"9".repeat(64)}`,
    metadata_digest: "5".repeat(64),
    producer_revision: "6".repeat(40),
    publication_id: MODERN_FIXTURE.publication,
    observed_at: MODERN_FIXTURE.now,
    published_at: MODERN_FIXTURE.now,
    finalized_observed_height: "123",
    finalized_observed_hash: MODERN_FIXTURE.blockHash,
    finalized_observed_at: MODERN_FIXTURE.now,
    integrity_verified: true,
    stage: "published",
    spec_version: 488,
    transaction_version: 1,
  };
  const safeEffects = {
    writes_state: false,
    billable: false,
    requires_credentials: false,
    unknown: false,
  };
  const service = {
    service_id: "inference",
    name: "Controlled inference",
    description: "An inert service with explicit examples and effects",
    kind: "http",
    base_url: "https://api.example.com/v1",
    source_urls: ["https://example.com/docs"],
    authentication: { required: false, schemes: [] },
    schema_capture_id: MODERN_FIXTURE.capture,
    verification: {
      generation: "1",
      verification_id: "7".repeat(64),
      operation_id: "status",
      status: "verified",
      observed_at: MODERN_FIXTURE.now,
      expires_at: MODERN_FIXTURE.expires,
    },
    operations: [
      {
        operation_id: "status",
        method: "GET",
        path: "/status",
        description: "Known safe, nonbillable status read",
        effects: safeEffects,
        example_json: "{}",
      },
      {
        operation_id: "infer",
        method: "POST",
        path: "/infer",
        description: "An operation requiring the caller's billing authority",
        effects: { ...safeEffects, billable: true },
        example_json:
          fault === "unsafe_example"
            ? '{"authorization":"not-a-placeholder"}'
            : '{"prompt":"A controlled example"}',
      },
    ],
  };
  const events = [
    {
      event_index: 0,
      pallet: "Balances",
      variant: "Transfer",
      fields: { amount_rao: "9007199254740993" },
      participants: [
        {
          participant_index: 0,
          account_id: `0x${"a".repeat(64)}`,
          role: "sender",
        },
      ],
      phase: "ApplyExtrinsic",
      extrinsic_index: 0,
      topics: [],
    },
    {
      event_index: 1,
      pallet: "System",
      variant: "ExtrinsicSuccess",
      fields: {},
      participants: [],
      phase: "ApplyExtrinsic",
      extrinsic_index: 0,
      topics: [],
    },
  ];
  const reads: V2QueryExecutor = {
    async query(sql, values) {
      assert.ok(calls.length < 1024, "Modern fixture query budget exceeded");
      assert.ok(
        /^\s*(?:SELECT|WITH)\b/.test(sql),
        "Fixture accepts reads only",
      );
      calls.push({ sql, values: structuredClone(values) });
      if (sql.includes("FROM chain.eligible_stake_publications e")) {
        assert.equal(values[0], "finney");
        assert.equal(typeof values[1], "string");
        const row = modernAccountStakeRow(String(values[1]));
        if (values[2] !== null && values[2] !== row.stake.publication_id)
          return { rows: [] };
        const limit = Number(values[6]);
        assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 10);
        const after =
          values[3] === null
            ? undefined
            : {
                kind:
                  values[4] === 0
                    ? ("position" as const)
                    : ("root_entitlement" as const),
                hotkey: String(values[3]),
                netuid: values[4] === 0 ? Number(values[5]) : null,
              };
        const entries = row.entries.filter(
          (entry) =>
            after === undefined ||
            compareAccountStakeKeys(after, accountStakeKey(entry)) < 0,
        );
        return {
          rows: [
            {
              ...row,
              entries: entries.slice(0, limit),
              has_more: entries.length > limit,
            },
          ],
        };
      }
      if (sql.startsWith("SELECT capture.capture_id")) {
        assert.ok(
          sql.includes(
            "JOIN registry.schema_documents document ON document.digest=capture.digest",
          ),
        );
        assert.deepEqual(values, [
          MODERN_FIXTURE.capture,
          "finney",
          200,
          MODERN_FIXTURE.registrationCounter,
          MODERN_FIXTURE.ecosystemPublication,
          MODERN_FIXTURE.catalog,
          "inference",
        ]);
        return {
          rows: [
            {
              capture_id: MODERN_FIXTURE.capture,
              network_id: "finney",
              netuid: 200,
              registration_counter: MODERN_FIXTURE.registrationCounter,
              service_id: "inference",
              digest:
                fault === "remote_reference"
                  ? "d95315080a032389446a3488b6f4a37f9e40f88cdfe03df51003874b77c9ea59"
                  : MODERN_FIXTURE.schemaDigest,
              source_url: "https://example.com/openapi.json",
              observed_at: MODERN_FIXTURE.now,
              document_json:
                fault === "remote_reference"
                  ? '{"$ref":"https://external.example.com/schema.json"}'
                  : MODERN_FIXTURE.schema +
                    (fault === "schema_digest" ? " " : ""),
            },
          ],
        };
      }
      assert.equal(values[0], "finney");
      const block = (height: string) => {
        const offset = 123 - Number(height);
        return {
          ...published,
          block_number: height,
          block_hash:
            offset === 0
              ? MODERN_FIXTURE.blockHash
              : `0x${String(9 - offset + 1).repeat(64)}`,
          parent_hash: `0x${String(9 - offset).repeat(64)}`,
          publication_id:
            offset === 0
              ? MODERN_FIXTURE.publication
              : String(9 - offset).repeat(64),
          raw_digest: "7".repeat(64),
          event_count: 2,
          extrinsic_count: 1,
        };
      };
      const head = {
        ...published,
        complete_from: "120",
        complete_through: "123",
        checkpoint_hash: MODERN_FIXTURE.blockHash,
        checkpoint_publication_id: MODERN_FIXTURE.publication,
        has_gap: false,
      };
      // Listing embeds headSql: dispatch it before the broad checkpoint read.
      if (
        sql.startsWith("WITH live_head AS MATERIALIZED") &&
        sql.includes("interval_blocks AS MATERIALIZED")
      ) {
        assert.equal(values.length, 7);
        const anchor = String(values[3] ?? "123");
        const from = String(values[2] ?? "120");
        const matching = events
          .filter((event) =>
            event.participants.some((p) => p.account_id === values[1]),
          )
          .filter(
            (event) =>
              values[4] === null ||
              BigInt("123") < BigInt(String(values[4])) ||
              (values[4] === "123" && event.event_index < Number(values[5])),
          )
          .sort((a, b) => b.event_index - a.event_index);
        const limit = Number(values[6]);
        return {
          rows: [
            {
              head,
              anchor: block(anchor),
              coverage: {
                block_count: (BigInt(anchor) - BigInt(from) + 1n).toString(),
                first_block: from,
                last_block: anchor,
                valid: true,
              },
              revision: {
                generation: "4",
                publication_id: MODERN_FIXTURE.publication,
              },
              within_budget: true,
              has_more: matching.length > limit,
              events: matching.slice(0, limit).map((event) => ({
                source: block("123"),
                event,
                matching_participants: event.participants.filter(
                  (p) => p.account_id === values[1],
                ),
              })),
            },
          ],
        };
      }
      if (sql.startsWith("WITH live_head AS MATERIALIZED")) {
        assert.equal(values.length, 5);
        const anchor = String(values[1] ?? "123");
        const before =
          values[2] === null ? Number(anchor) + 1 : Number(values[2]);
        const from = Number(values[4] ?? 120);
        return {
          rows: [
            {
              head,
              anchor: block(anchor),
              boundary: values[2] === null ? null : block(String(values[2])),
              blocks: Array.from(
                {
                  length: Math.min(
                    Number(values[3]),
                    Math.max(0, before - from),
                  ),
                },
                (_, index) => block(String(before - 1 - index)),
              ),
            },
          ],
        };
      }
      if (sql.includes("JOIN ops.checkpoints c")) {
        assert.deepEqual(values, ["finney"]);
        return { rows: [head] };
      }
      if (sql.startsWith("WITH selected AS MATERIALIZED")) {
        assert.equal(values.length, 6);
        assert.equal(values[1], "123");
        const extrinsics = [
          {
            extrinsic_index: 0,
            extrinsic_hash: `0x${"b".repeat(64)}`,
            pallet: "Balances",
            call: "transfer_keep_alive",
            fields: { amount_rao: "9007199254740993" },
            is_signed: true,
            signer: { account_id: `0x${"a".repeat(64)}` },
          },
        ];
        return {
          rows: [
            {
              ...block("123"),
              actual_event_count: events.length,
              first_event_index: 0,
              last_event_index: events.length - 1,
              actual_extrinsic_count: extrinsics.length,
              first_extrinsic_index: 0,
              last_extrinsic_index: extrinsics.length - 1,
              within_budget: true,
              events: events
                .filter((event) => event.event_index > Number(values[2]))
                .slice(0, Number(values[3])),
              extrinsics: extrinsics
                .filter(
                  (extrinsic) => extrinsic.extrinsic_index > Number(values[4]),
                )
                .slice(0, Number(values[5])),
            },
          ],
        };
      }
      if (sql.includes("FROM registry.eligible_ecosystem_publications e")) {
        if (sql.includes("AND e.publication_id=$2")) {
          assert.equal(values.length, 2);
          assert.match(String(values[1]), /^[0-9a-f]{64}$/);
          if (values[1] !== MODERN_FIXTURE.ecosystemPublication)
            return { rows: [] };
        } else assert.deepEqual(values, ["finney"]);
        return {
          rows: [
            {
              ...published,
              registry_complete: true,
              registry_expected_netuids: MODERN_REGISTERED_NETUIDS,
              actual_netuids:
                fault === "registry_coverage"
                  ? MODERN_REGISTERED_NETUIDS.slice(0, -1)
                  : MODERN_REGISTERED_NETUIDS,
              actual_operational_netuids: MODERN_REGISTERED_NETUIDS,
              actual_mechanisms_complete: true,
              ecosystem: ecosystemFixture({
                snapshot: published,
                publicationId: MODERN_FIXTURE.ecosystemPublication,
                operationalNetuids: MODERN_REGISTERED_NETUIDS,
              }).ecosystem,
            },
          ],
        };
      }
      if (
        sql.startsWith("SELECT jsonb_build_object(") &&
        sql.includes("FROM registry.subnets s WHERE s.network_id=$1")
      ) {
        assert.equal(values[1], MODERN_FIXTURE.ecosystemPublication);
        if (sql.includes("AND s.netuid=$3")) {
          assert.equal(values.length, 3);
          return {
            rows: subnets
              .filter((row) => row.generation.netuid === values[2])
              .map((subnet) => ({ subnet })),
          };
        }
        assert.equal(values.length, 4);
        assert.ok(values[2] === null || Number.isInteger(values[2]));
        assert.ok(Number.isInteger(values[3]));
        return {
          rows: subnets
            .filter(
              (row) =>
                values[2] === null ||
                row.generation.netuid > (values[2] as number),
            )
            .slice(0, values[3] as number)
            .map((subnet) => ({ subnet })),
        };
      }
      if (sql.startsWith("WITH selected_catalog AS")) {
        assert.ok(sql.includes("JOIN registry.service_definitions d"));
        assert.ok(sql.includes("AND budget.supported"));
        assert.equal(values.length, 5);
        assert.ok(sql.includes("c.registration_counter=$3::numeric"));
        assert.deepEqual(values.slice(0, 3), [
          "finney",
          200,
          MODERN_FIXTURE.registrationCounter,
        ]);
        assert.equal(values[4], MODERN_FIXTURE.ecosystemPublication);
        assert.ok(
          values[3] === null ||
            (typeof values[3] === "string" && /^[0-9a-f]{64}$/.test(values[3])),
        );
        if (values[3] !== null && values[3] !== MODERN_FIXTURE.catalog)
          return { rows: [] };
        if (fault === "old_registration") return { rows: [] };
        return {
          rows: [
            {
              network_id: "finney",
              netuid: 200,
              registered_at_block: "42",
              registration_counter:
                fault === "catalog_identity"
                  ? "6"
                  : MODERN_FIXTURE.registrationCounter,
              chain_publication_id: MODERN_FIXTURE.ecosystemPublication,
              generation: "2",
              producer_revision: "8".repeat(40),
              catalog_id: MODERN_FIXTURE.catalog,
              observed_at: MODERN_FIXTURE.now,
              published_at: MODERN_FIXTURE.now,
              expires_at: MODERN_FIXTURE.expires,
              expected_service_ids: ["inference"],
              actual_service_ids: ["inference"],
              services: [service],
            },
          ],
        };
      }
      if (sql.startsWith("WITH latest AS")) {
        assert.ok(sql.includes("JOIN registry.service_definitions d"));
        assert.ok(
          sql.includes("d.encoding IS DISTINCT FROM 'service-definition-v1'"),
        );
        assert.ok(
          sql.includes("s.registration_counter=c.registration_counter"),
        );
        assert.deepEqual(values, [
          "finney",
          MODERN_FIXTURE.ecosystemPublication,
          "inference",
          5,
        ]);
        return {
          rows: [
            {
              observed_subnets: 1,
              complete_subnets: 1,
              subnets_with_services: 1,
              matches: [
                {
                  catalog_id: MODERN_FIXTURE.catalog,
                  service_id: "inference",
                  subnet: canonicalSubnet(),
                  relevance: 0.5,
                },
              ],
            },
          ],
        };
      }
      throw new Error("Unexpected modern fixture read");
    },
  };
  const errors: unknown[] = [];
  const executor: V2QueryExecutor = {
    async query(sql, values) {
      try {
        return await reads.query(sql, values);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  };
  return { executor, calls, errors };
}
