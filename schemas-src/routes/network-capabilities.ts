// #8699: the per-network capability matrix served at GET /api/v1/networks.
//
// Shape mirrors src/network-capabilities.ts exactly. Every field is required
// because the payload is fully derived — there is no upstream that can fail
// and leave a hole, so an optional field here would describe a state that
// cannot occur.
import { z } from "zod";

const RouteFamilySchema = z
  .object({
    family: z.string(),
    route_count: z.int().min(1),
    example: z.string(),
  })
  .strict();

const NetworkCapabilitySchema = z
  .object({
    id: z.string(),
    chain: z.string(),
    aliases: z.array(z.string()),
    is_default: z.boolean(),
    // False for `local`, which is a node the caller runs themselves — we host
    // no registry data for it and say so rather than listing empty families.
    serves_data: z.boolean(),
    served_families: z.array(RouteFamilySchema),
    unserved_families: z.array(RouteFamilySchema),
    // A family where some routes serve and some do not. Reporting one of these
    // as simply "served" would send an agent into the 404 this route exists to
    // prevent.
    partial_families: z.array(RouteFamilySchema),
    note: z.string().nullable(),
  })
  .strict();

export const NetworkCapabilitiesArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    default_network: z.string(),
    path_form: z.string(),
    network_count: z.int().min(1),
    networks: z.array(NetworkCapabilitySchema),
  })
  .strict();
