// The two enum types the published schema declares (#10214).
//
// Neither can be emitted from a component the way an object type is: the
// emitter maps every registered Zod enum to `String`, deliberately -- there are
// 17 registered enum components and turning them all into GraphQL enums is a
// decision about the whole published surface. These two are the ones the SDL
// has always declared, so they are declared here, each DERIVED from the
// producer's own vocabulary rather than restated.
//
// A narrowing has to be written down and justified, and it can only ever be a
// SUBSET -- `assertEnumVocabularies` fails on a value the producer does not
// have, so this cannot invent one.
import { CHAIN_FIREHOSE_TABLES } from "../../src/chain-firehose-topics.ts";
import { BITTENSOR_NETWORK_VALUES } from "../shared.ts";

export interface PublishedEnum {
  readonly description: string;
  readonly values: readonly string[];
  /** The producer vocabulary `values` must be a subset of. */
  readonly from: readonly string[];
  /** Values the producer has that GraphQL does not publish, and why. */
  readonly excluded?: Readonly<Record<string, string>>;
  /**
   * The `PublishedType.field` sites that publish this enum rather than String.
   *
   * The emitter maps every registered Zod enum to `String` -- the decision
   * above -- so a field the SDL publishes as an enum has to say so somewhere.
   * Here rather than in a general retype map, because THIS declaration can be
   * checked against the field's own vocabulary: `assertEnumFieldVocabularies`
   * reads the Zod behind each site and fails when its values are not the ones
   * the enum publishes. A blanket "retype this field to that name" could not.
   *
   * Empty on `Network`, which is an ARGUMENT type only -- no field returns it.
   */
  readonly fields?: readonly string[];
}

export const GRAPHQL_ENUMS: Readonly<Record<string, PublishedEnum>> = {
  Network: {
    description:
      "The Bittensor network whose static subnet artifact to read: finney (mainnet, default) or test (testnet). Mirrors the list_subnets MCP tool's network argument.",
    values: ["finney", "test"],
    from: BITTENSOR_NETWORK_VALUES,
    excluded: {
      local:
        "a developer chain with no published artifact -- nothing serves it, " +
        "and GraphQL rejects it today: `subnets(network: local)` answers " +
        '\'Value "local" does not exist in "Network" enum.\' Verified against ' +
        "api.metagraph.sh. Publishing it would advertise a network with no data.",
    },
  },
  ChainFirehoseTable: {
    description:
      "Which source table a live chain event came from. The same four topics the SSE firehose and the ingest validator accept.",
    values: [...CHAIN_FIREHOSE_TABLES],
    from: [...CHAIN_FIREHOSE_TABLES],
    fields: ["ChainEvent.table"],
  },
};

/**
 * `PublishedType.field` -> the enum it publishes, inverted from the above.
 *
 * One field cannot publish two enums, so a second declaration of the same site
 * is a contradiction rather than an override, and this throws on it.
 */
export function enumFieldSites(
  declarations: Readonly<Record<string, PublishedEnum>> = GRAPHQL_ENUMS,
): ReadonlyMap<string, string> {
  const sites = new Map<string, string>();
  for (const [name, declaration] of Object.entries(declarations)) {
    for (const site of declaration.fields ?? []) {
      const existing = sites.get(site);
      if (existing) {
        throw new Error(
          `${site} is declared as both ${existing} and ${name}; a field publishes one enum`,
        );
      }
      sites.set(site, name);
    }
  }
  return sites;
}

/**
 * Every published value must exist in the producer's vocabulary, and every
 * value the producer has must be published or declared excluded.
 *
 * Takes the declarations so a test can drive it with a MUTATED one -- run only
 * against the real pair it proves it passes, not that it can fail.
 *
 * Both directions, because each catches a different rot: a published value the
 * producer dropped is a type a client can send and nothing can answer, and a
 * producer value nobody published is a silent hole -- which is what a
 * fifth firehose table would be.
 */
export function assertEnumVocabularies(
  declarations: Readonly<Record<string, PublishedEnum>> = GRAPHQL_ENUMS,
): string[] {
  const problems: string[] = [];
  for (const [name, declaration] of Object.entries(declarations)) {
    const producer = new Set(declaration.from);
    for (const value of declaration.values) {
      if (!producer.has(value)) {
        problems.push(`${name}.${value} -- the producer has no such value`);
      }
    }
    const publishedValues = new Set(declaration.values);
    for (const value of declaration.from) {
      if (publishedValues.has(value)) continue;
      if (declaration.excluded?.[value]) continue;
      problems.push(
        `${name}.${value} -- the producer publishes it, the enum neither ` +
          `publishes nor declares it excluded`,
      );
    }
    for (const value of Object.keys(declaration.excluded ?? {})) {
      if (!producer.has(value)) {
        problems.push(
          `${name}.${value} -- declared excluded, but the producer no longer ` +
            `has it (delete the entry)`,
        );
      }
      if (publishedValues.has(value)) {
        problems.push(
          `${name}.${value} -- declared excluded, and the enum publishes it`,
        );
      }
    }
  }
  return problems;
}
