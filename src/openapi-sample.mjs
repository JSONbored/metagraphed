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

function normalizeObjectSample(out) {
  normalizeCounterpartyRelationshipSample(out);
  normalizeAccountCounterpartiesSample(out);
  normalizeAccountStakeFlowSample(out);
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
