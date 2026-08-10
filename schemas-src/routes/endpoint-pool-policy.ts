// The two policy blocks GET /api/v1/rpc-pools and GET /api/v1/endpoint-pools
// both carry (#10214).
//
// Each route had written both of them out inline. The copies were identical,
// which is the problem twice over: the same policy could drift apart in one
// route without anything noticing, and being unregistered they inlined into
// the JSON Schema separately -- so every generator downstream saw four
// anonymous shapes where the source has two.
import { z } from "zod";

/** What the RPC proxy allows while the proxy itself is switched off. */
export const DisabledProxyContractSchema = z
  .object({
    enabled: z.boolean().optional(),
    feature_flag: z.string().optional(),
    allowed_methods: z.array(z.string()).optional(),
    denied_method_patterns: z.array(z.string()).optional(),
    rate_limit_required: z.boolean().optional(),
    waf_required: z.boolean().optional(),
  })
  .passthrough()
  .describe(
    "The contract the RPC proxy honours while disabled: which methods stay allowed, which patterns stay denied, and whether rate limiting and WAF are prerequisites for enabling it.",
  );

/** Which probed endpoints a pool is allowed to draw from. */
export const EndpointEligibilityPolicySchema = z
  .object({
    source: z.string().optional(),
    eligible_layers: z.array(z.string()).optional(),
    required_status: z.string().optional(),
    requires_no_auth: z.boolean().optional(),
    requires_public_safe: z.boolean().optional(),
    user_reports_can_change_health: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Which probed endpoints this pool may draw from: the layers it accepts, the health verdict it requires, and whether an endpoint must be auth-free and public-safe to qualify.",
  );
