// GET /api/v1/subnets/{netuid}/services (#13164; #13161, epic #13142). One
// subnet's on-chain service-URL registry, served live from
// app.subnet_services (migration 0047) through the native store seam. The
// burn tick's Gamma capture (src/chain-gamma-capture.ts) fills it from
// SubtensorModule.Services (events ServiceSet / ServiceRemoved), so until a
// store is bound and a capture observed this route serves the schema-stable
// decline below, never a fabricated service-less subnet.
import { z } from "zod";

export const SubnetServiceSchema = z
  .object({
    hotkey: z.string().describe("The hotkey this service URL is bound to."),
    service_url: z
      .string()
      .describe(
        "The service URL as the chain stores it (SubtensorModule.Services) -- published on chain by the key's owner, served verbatim.",
      ),
    set_at: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block the URL was last set at (event ServiceSet). Null when the capture did not carry it -- never fabricated as 0, which would claim a set at genesis.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One on-chain service binding: the hotkey, the URL it published, and the capture stamp.",
  );

export const SubnetServicesArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * registry is never a measured "no services" -- it is what an unbound or
     * unfilled store looks like (the engine dependency #13164 defers), and
     * publishing it as a count would be the confident-zero failure the
     * sibling subnet surfaces' own comments are about.
     */
    service_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many service bindings this subnet carries -- `services.length`. NULL when the registry holds no rows for this subnet (store unbound, or the service capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    services: z
      .array(SubnetServiceSchema)
      .describe("The subnet's service bindings, ordered by hotkey."),
  })
  .strict()
  .describe(
    "One subnet's on-chain service-URL registry (#13164). Empty with a null service_count until a Services capture is observed. Mirrors GET /api/v1/subnets/{netuid}/services.",
  );
