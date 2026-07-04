// Deterministic, schema-valid example generator for the OpenAPI contract.
//
// Produces a minimal-but-realistic instance for any component/response schema so
// every operation can ship a worked `example` WITHOUT depending on live data —
// keeping public/metagraph/openapi.json reproducible from contracts + schemas
// alone (validate:contract-drift regenerates it offline). Values are seeded by
// field name + format + pattern so the examples read like real metagraphed
// responses rather than bare placeholders. Validity is enforced downstream by
// scripts/validate-openapi-examples.mjs (ajv against each operation's schema).

// Top levels show optional fields (informative); deeper levels stay required-only
// so examples don't explode. MAX_DEPTH bounds recursion on self-referential schemas.
const OPTIONAL_DEPTH = 3;
const MAX_DEPTH = 8;
const ISO = "2026-06-01T00:00:00.000Z";
const CURSOR2 = "123.4";
const HEX64 = "a3f1".repeat(16); // 64 hex chars, matches ^[a-f0-9]{64}$
const SAMPLE_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const SAMPLE_COUNTERPARTY_SS58 =
  "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ";

function valueForPattern(pattern, name = "") {
  const n = String(name || "").toLowerCase();
  switch (pattern) {
    case "^[a-f0-9]{64}$":
      return HEX64;
    case "^[1-9A-HJ-NP-Za-km-z]{47,48}$":
      return /counterparty|^to$|address/.test(n)
        ? SAMPLE_COUNTERPARTY_SS58
        : SAMPLE_SS58;
    case "^\\d{4}-\\d{2}-\\d{2}$":
      return "2026-06-01";
    case "^\\d+\\.\\d+$":
      return CURSOR2;
    case "^[a-z0-9][a-z0-9-]*$":
      return "example-subnet";
    case "^/metagraph/":
      return "/metagraph/example.json";
    case "^/api/v1":
      return "/api/v1/example";
    case "^#/components/schemas/[A-Za-z0-9]+$":
      return "#/components/schemas/Example";
    case "^[Hh][Tt][Tt][Pp][Ss]?://":
      // http(s)-only guard (e.g. provider logo_url) — keep the sample a valid
      // absolute URL so it satisfies both the pattern and format: uri.
      return "https://api.metagraph.sh/example";
    default:
      return "example";
  }
}

function seededString(name) {
  const n = String(name || "").toLowerCase();
  if (/(^url$|_url$|href|endpoint|uri|repository|documentation|logo)/.test(n)) {
    return "https://api.metagraph.sh/example";
  }
  if (
    /(_at$|_time$|^last_|observed|checked|reviewed|verified|captured|published_|generated_|updated_|started_|ended_)/.test(
      n,
    )
  ) {
    return ISO;
  }
  if (/(^day$|^date$)/.test(n)) return "2026-06-01";
  if (/window/.test(n)) return "30d";
  if (n === "ss58" || n === "from") return SAMPLE_SS58;
  if (n === "counterparty" || n === "to") return SAMPLE_COUNTERPARTY_SS58;
  if (/slug/.test(n)) return "example-subnet";
  if (/(^name$|title|subnet_name|display_name)/.test(n))
    return "Example Subnet";
  if (/(description|^notes$|instructions|summary$)/.test(n)) {
    return "Example description.";
  }
  if (/version/.test(n)) return "2026-06-29.1";
  if (/(provider|operator)/.test(n)) return "example-provider";
  if (/(content_hash|_hash$|^hash$)/.test(n)) return HEX64;
  if (/health_source/.test(n)) return "probe-derived";
  if (/source$/.test(n)) return "live-cron-prober";
  if (/status$/.test(n)) return "ok";
  if (/grade/.test(n)) return "A";
  if (/method/.test(n)) return "GET";
  if (/(surface_id|^id$|_id$)/.test(n)) return "example";
  return "example";
}

function seededNumber(name, schema) {
  const n = String(name || "").toLowerCase();
  const isInt =
    schema.type === "integer" ||
    (Array.isArray(schema.type) && schema.type.includes("integer"));
  let value;
  if (/netuid/.test(n)) value = 7;
  else if (/(uptime_ratio|_ratio$)/.test(n)) value = 0.9966;
  else if (/score$/.test(n)) value = 100;
  else if (/latency/.test(n)) value = 120;
  else if (/block/.test(n)) value = 5000000;
  else if (/(_count$|count$|samples|^total$|returned|limit|cursor)/.test(n)) {
    value = 1;
  } else value = isInt ? 1 : 0.5;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    value = schema.minimum;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    value = schema.maximum;
  }
  return isInt ? Math.round(value) : value;
}

function seededBoolean(name) {
  return /(required|^enabled$|public_safe|^ok$|supported)/.test(
    String(name || "").toLowerCase(),
  );
}

function sampleAmount(value) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeCounterpartyRelationshipSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !Array.isArray(out.transfers) ||
    !("counterparty" in out) ||
    !("total_sent_tao" in out) ||
    !("total_received_tao" in out) ||
    !("net_tao" in out)
  ) {
    return out;
  }

  let totalSent = 0;
  let totalReceived = 0;
  let transferCount = 0;
  for (const transfer of out.transfers) {
    if (!transfer || typeof transfer !== "object") continue;
    const amount = sampleAmount(transfer.amount_tao);
    if (transfer.direction === "sent") {
      totalSent += amount;
      transferCount += 1;
    } else if (transfer.direction === "received") {
      totalReceived += amount;
      transferCount += 1;
    }
  }

  out.total_sent_tao = totalSent;
  out.total_received_tao = totalReceived;
  out.net_tao = totalReceived - totalSent;
  out.transfer_count = transferCount;
  return out;
}

function normalizeAccountCounterpartiesSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.relationship ||
    typeof out.relationship !== "object" ||
    !Array.isArray(out.counterparties)
  ) {
    return out;
  }

  const relationship = normalizeCounterpartyRelationshipSample(
    out.relationship,
  );
  out.relationship = relationship;
  out.total_sent_tao = relationship.total_sent_tao;
  out.total_received_tao = relationship.total_received_tao;
  out.transfers_scanned = relationship.transfers_scanned;
  out.scan_capped = relationship.scan_capped;
  out.counterparties =
    relationship.transfer_count === 0
      ? []
      : [
          {
            address: relationship.counterparty,
            sent_tao: relationship.total_sent_tao,
            received_tao: relationship.total_received_tao,
            net_tao: relationship.net_tao,
            transfer_count: relationship.transfer_count,
            last_block: relationship.last_block,
          },
        ];
  out.counterparty_count = out.counterparties.length;
  return out;
}

function normalizeSubnetYieldSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !("subnet_yield" in out) ||
    !("median_yield" in out) ||
    !("p25_yield" in out) ||
    !Array.isArray(out.neurons)
  ) {
    return out;
  }
  // A two-neuron, internally consistent worked example: a validator earning 0.2 and a
  // miner earning 0.4 emission-per-stake. The derived distribution (subnet aggregate
  // 4/15, mean 0.3, median/percentiles) and the per-UID vs-median labels all line up —
  // the generic per-field generator cannot satisfy yield = emission/stake on its own.
  out.neurons = [
    {
      uid: 1,
      hotkey: SAMPLE_SS58,
      role: "miner",
      stake_tao: 5,
      emission_tao: 2,
      yield: 0.4,
      vs_median: "above",
    },
    {
      uid: 0,
      hotkey: SAMPLE_SS58,
      role: "validator",
      stake_tao: 10,
      emission_tao: 2,
      yield: 0.2,
      vs_median: "below",
    },
  ];
  out.neuron_count = 2;
  out.validator_count = 1;
  out.miner_count = 1;
  out.total_stake_tao = 15;
  out.total_emission_tao = 4;
  out.subnet_yield = 0.266666667;
  out.mean_yield = 0.3;
  // Conventional median of the two yields [0.2, 0.4] -> (0.2 + 0.4) / 2.
  out.median_yield = 0.3;
  out.p25_yield = 0.2;
  out.p75_yield = 0.4;
  out.p90_yield = 0.4;
  return out;
}

function normalizeAccountStakeFlowSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    typeof out.gross_flow_tao !== "number" ||
    !Array.isArray(out.subnets) ||
    !("concentration" in out) ||
    !("dominant_netuid" in out)
  ) {
    return out;
  }
  // A single-subnet, internally consistent worked example: 2.0 TAO in, 0.5 out, so
  // net 1.5 / gross 2.5 / ratio 0.6 reads "accumulating", and the account totals, the
  // HHI concentration (one subnet -> 1), and the dominant subnet all line up. The
  // generic per-field generator cannot satisfy these cross-field invariants on its own.
  const staked = 2;
  const unstaked = 0.5;
  const net = staked - unstaked;
  const gross = staked + unstaked;
  const ratio = Math.round((net / gross) * 10000) / 10000;
  out.subnets = [
    {
      netuid: 1,
      staked_tao: staked,
      unstaked_tao: unstaked,
      net_flow_tao: net,
      gross_flow_tao: gross,
      flow_ratio: ratio,
      direction: "accumulating",
      stake_events: 3,
      unstake_events: 1,
    },
  ];
  out.total_staked_tao = staked;
  out.total_unstaked_tao = unstaked;
  out.net_flow_tao = net;
  out.gross_flow_tao = gross;
  out.flow_ratio = ratio;
  out.direction = "accumulating";
  out.stake_events = 3;
  out.unstake_events = 1;
  out.subnet_count = 1;
  out.concentration = 1;
  out.dominant_netuid = 1;
  return out;
}

function normalizeChainTransfersSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !("top_sender_share" in out) ||
    !Array.isArray(out.top_senders) ||
    !Array.isArray(out.top_receivers) ||
    typeof out.total_volume_tao !== "number"
  ) {
    return out;
  }
  // An internally consistent worked example: two senders moving 60 + 20 of a 100 total,
  // so top_sender_share = 80/100 = 0.8. The generic per-field generator cannot derive the
  // share from the leaderboard on its own.
  out.total_volume_tao = 100;
  out.transfer_count = 12;
  out.unique_senders = 5;
  out.unique_receivers = 7;
  out.top_sender_share = 0.8;
  out.top_senders = [
    { address: SAMPLE_SS58, volume_tao: 60, transfer_count: 3 },
    { address: SAMPLE_COUNTERPARTY_SS58, volume_tao: 20, transfer_count: 2 },
  ];
  out.top_receivers = [
    { address: SAMPLE_COUNTERPARTY_SS58, volume_tao: 55, transfer_count: 4 },
    { address: SAMPLE_SS58, volume_tao: 30, transfer_count: 2 },
  ];
  return out;
}

function normalizeChainTransferPairsSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !("top_pair_share" in out) ||
    !Array.isArray(out.pairs) ||
    typeof out.total_volume_tao !== "number"
  ) {
    return out;
  }
  // An internally consistent worked example: the highest-volume full-window
  // pair moved 80 of a 100 total, so top_pair_share = 0.8.
  out.total_volume_tao = 100;
  out.transfer_count = 10;
  out.unique_pairs = 2;
  out.pair_count = 1;
  out.top_pair_share = 0.8;
  out.pairs = [
    {
      from: SAMPLE_SS58,
      to: SAMPLE_COUNTERPARTY_SS58,
      volume_tao: 80,
      transfer_count: 5,
      last_block: 5000000,
      last_observed_at: ISO,
    },
  ];
  return out;
}

function normalizeChainWeightsSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.network ||
    typeof out.network !== "object" ||
    !("sets_per_setter" in out.network) ||
    !("weight_sets" in out.network) ||
    !Array.isArray(out.subnets)
  ) {
    return out;
  }
  // An internally consistent worked example: two subnets whose validators emit 40 and 30
  // WeightsSet events, so sets_per_setter reads 40/4 = 10 and 30/2 = 15; the network rollup uses
  // the true distinct setter count (5, below the 6 per-subnet sum because a setter validates on
  // both subnets), total events 40 + 30 = 70 give 70/5 = 14, and the distribution summarizes
  // [10, 15]. The generic per-field generator cannot satisfy these events/setters ratios itself.
  out.subnets = [
    { netuid: 1, distinct_setters: 4, weight_sets: 40, sets_per_setter: 10 },
    { netuid: 2, distinct_setters: 2, weight_sets: 30, sets_per_setter: 15 },
  ];
  out.network = { distinct_setters: 5, weight_sets: 70, sets_per_setter: 14 };
  out.subnet_count = 2;
  out.intensity_distribution = {
    count: 2,
    mean: 12.5,
    min: 10,
    p25: 10,
    median: 10,
    p75: 15,
    p90: 15,
    max: 15,
  };
  return out;
}

function normalizeChainServingSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.network ||
    typeof out.network !== "object" ||
    !("announcements_per_server" in out.network) ||
    !("announcements" in out.network) ||
    !Array.isArray(out.subnets)
  ) {
    return out;
  }
  // An internally consistent worked example: two subnets whose servers emit 40 and 30 AxonServed
  // events, so announcements_per_server reads 40/4 = 10 and 30/2 = 15; the network rollup uses the
  // true distinct server count (5, below the 6 per-subnet sum because a server announces on both
  // subnets), total 40 + 30 = 70 give 70/5 = 14, and the distribution summarizes [10, 15]. The
  // generic per-field generator cannot satisfy these events/servers ratios itself.
  out.subnets = [
    {
      netuid: 1,
      distinct_servers: 4,
      announcements: 40,
      announcements_per_server: 10,
    },
    {
      netuid: 2,
      distinct_servers: 2,
      announcements: 30,
      announcements_per_server: 15,
    },
  ];
  out.network = {
    distinct_servers: 5,
    announcements: 70,
    announcements_per_server: 14,
  };
  out.subnet_count = 2;
  out.intensity_distribution = {
    count: 2,
    mean: 12.5,
    min: 10,
    p25: 10,
    median: 10,
    p75: 15,
    p90: 15,
    max: 15,
  };
  return out;
}

function normalizeChainPrometheusSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.network ||
    typeof out.network !== "object" ||
    !("announcements_per_exporter" in out.network) ||
    !("announcements" in out.network) ||
    !Array.isArray(out.subnets)
  ) {
    return out;
  }
  // An internally consistent worked example: two subnets whose exporters emit 40 and 30
  // PrometheusServed events, so announcements_per_exporter reads 40/4 = 10 and 30/2 = 15; the
  // network rollup uses the true distinct exporter count (5, below the 6 per-subnet sum because an
  // exporter announces on both subnets), total 40 + 30 = 70 give 70/5 = 14, and the distribution
  // summarizes [10, 15]. The generic per-field generator cannot satisfy these events/exporters ratios itself.
  out.subnets = [
    {
      netuid: 1,
      distinct_exporters: 4,
      announcements: 40,
      announcements_per_exporter: 10,
    },
    {
      netuid: 2,
      distinct_exporters: 2,
      announcements: 30,
      announcements_per_exporter: 15,
    },
  ];
  out.network = {
    distinct_exporters: 5,
    announcements: 70,
    announcements_per_exporter: 14,
  };
  out.subnet_count = 2;
  out.intensity_distribution = {
    count: 2,
    mean: 12.5,
    min: 10,
    p25: 10,
    median: 10,
    p75: 15,
    p90: 15,
    max: 15,
  };
  return out;
}

function normalizeChainRegistrationsSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.network ||
    typeof out.network !== "object" ||
    !("registrations_per_registrant" in out.network) ||
    !("registrations" in out.network) ||
    !Array.isArray(out.subnets)
  ) {
    return out;
  }
  // An internally consistent worked example: two subnets whose registrants emit 40 and 30
  // NeuronRegistered events, so registrations_per_registrant reads 40/4 = 10 and 30/2 = 15; the
  // network rollup uses the true distinct registrant count (5, below the 6 per-subnet sum because
  // a hotkey registers on both subnets), total 40 + 30 = 70 give 70/5 = 14, and the distribution
  // summarizes [10, 15]. The generic per-field generator cannot satisfy these events/registrants ratios itself.
  out.subnets = [
    {
      netuid: 1,
      distinct_registrants: 4,
      registrations: 40,
      registrations_per_registrant: 10,
    },
    {
      netuid: 2,
      distinct_registrants: 2,
      registrations: 30,
      registrations_per_registrant: 15,
    },
  ];
  out.network = {
    distinct_registrants: 5,
    registrations: 70,
    registrations_per_registrant: 14,
  };
  out.subnet_count = 2;
  out.intensity_distribution = {
    count: 2,
    mean: 12.5,
    min: 10,
    p25: 10,
    median: 10,
    p75: 15,
    p90: 15,
    max: 15,
  };
  return out;
}

function normalizeChainStakeMovesSample(out) {
  if (
    !out ||
    typeof out !== "object" ||
    !out.network ||
    typeof out.network !== "object" ||
    !("movements_per_mover" in out.network) ||
    !("movements" in out.network) ||
    !Array.isArray(out.subnets)
  ) {
    return out;
  }
  // An internally consistent worked example: two subnets whose movers emit 40 and 30 StakeMoved
  // events, so movements_per_mover reads 40/4 = 10 and 30/2 = 15; the network rollup uses the true
  // distinct mover count (5, below the 6 per-subnet sum because a coldkey moves stake out of both
  // subnets), total 40 + 30 = 70 give 70/5 = 14, and the distribution summarizes [10, 15]. The
  // generic per-field generator cannot satisfy these events/movers ratios itself.
  out.subnets = [
    {
      netuid: 1,
      distinct_movers: 4,
      movements: 40,
      movements_per_mover: 10,
    },
    {
      netuid: 2,
      distinct_movers: 2,
      movements: 30,
      movements_per_mover: 15,
    },
  ];
  out.network = {
    distinct_movers: 5,
    movements: 70,
    movements_per_mover: 14,
  };
  out.subnet_count = 2;
  out.intensity_distribution = {
    count: 2,
    mean: 12.5,
    min: 10,
    p25: 10,
    median: 10,
    p75: 15,
    p90: 15,
    max: 15,
  };
  return out;
}

function normalizeObjectSample(out) {
  normalizeCounterpartyRelationshipSample(out);
  normalizeAccountCounterpartiesSample(out);
  normalizeAccountStakeFlowSample(out);
  normalizeSubnetYieldSample(out);
  normalizeChainTransfersSample(out);
  normalizeChainTransferPairsSample(out);
  normalizeChainWeightsSample(out);
  normalizeChainServingSample(out);
  normalizeChainPrometheusSample(out);
  normalizeChainRegistrationsSample(out);
  normalizeChainStakeMovesSample(out);
  return out;
}

function pickType(type) {
  if (Array.isArray(type)) {
    return type.find((entry) => entry !== "null") || type[0];
  }
  return type;
}

function resolveRef(ref, components) {
  return components[ref.split("/").pop()];
}

function markActiveRef(activeRefsByDepth, depth, ref) {
  let active = activeRefsByDepth.get(depth);
  if (!active) {
    active = new Set();
    activeRefsByDepth.set(depth, active);
  }
  if (active.has(ref)) return false;
  active.add(ref);
  return true;
}

function unmarkActiveRef(activeRefsByDepth, depth, ref) {
  activeRefsByDepth.get(depth)?.delete(ref);
}

// Sample a JSON-Schema (2020-12 subset used by the metagraphed contract) into a
// concrete, valid instance. `components` is the bundle's components.schemas map.
export function sampleFromSchema(
  schema,
  components,
  name = "",
  depth = 0,
  activeRefsByDepth = null,
) {
  if (!schema || typeof schema !== "object") return null;
  const activeRefs = activeRefsByDepth ?? new Map();
  if (schema.$ref) {
    // Bound self-referential schemas. The object and array branches grow
    // `depth` as they descend, but only the array branch had a MAX_DEPTH guard,
    // so a required self-referential property (a linked list / tree node)
    // recursed through $ref until the stack overflowed. A self-reference always
    // routes back through here, so guard at this chokepoint — without changing
    // `depth`, so non-cyclic schemas still sample exactly as before.
    //
    // Composition keywords (allOf/oneOf/anyOf) recurse at the same depth, so a
    // self-hop routed purely through them never advanced `depth` and overflowed.
    // Track active $refs per depth and cut non-advancing revisits.
    if (depth >= MAX_DEPTH) return null;
    const ref = schema.$ref;
    if (!markActiveRef(activeRefs, depth, ref)) return null;
    try {
      return sampleFromSchema(
        resolveRef(ref, components),
        components,
        name,
        depth,
        activeRefs,
      );
    } finally {
      unmarkActiveRef(activeRefs, depth, ref);
    }
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.find((value) => value !== null) ?? schema.enum[0];
  }
  if (Array.isArray(schema.allOf)) {
    let merged = {};
    let scalar;
    for (const sub of schema.allOf) {
      const part = sampleFromSchema(sub, components, name, depth, activeRefs);
      if (part && typeof part === "object" && !Array.isArray(part)) {
        merged = { ...merged, ...part };
      } else if (part !== null && part !== undefined) {
        scalar = part;
      }
    }
    return Object.keys(merged).length > 0 ? merged : (scalar ?? merged);
  }
  const variants = schema.oneOf || schema.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const pick =
      variants.find((variant) => pickType(variant.type) !== "null") ||
      variants[0];
    return sampleFromSchema(pick, components, name, depth, activeRefs);
  }

  const type = pickType(schema.type);
  if (type === "null") return null;

  if (type === "object" || (!type && schema.properties)) {
    const out = {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const includeOptional = depth < OPTIONAL_DEPTH;
    for (const [key, propSchema] of Object.entries(props)) {
      if (!required.has(key) && !includeOptional) continue;
      out[key] = sampleFromSchema(
        propSchema,
        components,
        key,
        depth + 1,
        activeRefs,
      );
    }
    // Pure map object (additionalProperties is a schema, no named props): show
    // one representative entry so the shape is visible.
    if (
      Object.keys(props).length === 0 &&
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object" &&
      depth < OPTIONAL_DEPTH
    ) {
      out.example = sampleFromSchema(
        schema.additionalProperties,
        components,
        "example",
        depth + 1,
        activeRefs,
      );
    }
    return normalizeObjectSample(out);
  }

  if (type === "array") {
    if (depth >= MAX_DEPTH) return [];
    return [
      sampleFromSchema(
        schema.items || {},
        components,
        name,
        depth + 1,
        activeRefs,
      ),
    ];
  }

  if (type === "string") {
    if (schema.pattern) return valueForPattern(schema.pattern, name);
    if (schema.format === "uri") return "https://api.metagraph.sh/example";
    if (schema.format === "date-time") return ISO;
    return seededString(name);
  }
  if (type === "integer" || type === "number")
    return seededNumber(name, schema);
  if (type === "boolean") return seededBoolean(name);
  return null;
}
