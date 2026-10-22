// The direct x402 v2 quote emitted by src/x402.ts::paymentRequiredResponse.
// Payment challenges are protocol documents, rather than API ErrorEnvelopes.
import { z } from "zod";

const X402PaymentRequirementsSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().describe("CAIP-2 identifier of the payment network."),
    amount: z
      .string()
      .regex(/^\d+$/)
      .describe("USDC amount in six-decimal atomic units."),
    asset: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.int().positive(),
    extra: z
      .record(z.string(), z.string())
      .describe(
        "Scheme-specific signing fields, including an EVM domain or Solana fee payer.",
      ),
  })
  .strict();

export const X402PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string(),
    resource: z
      .object({
        url: z.url(),
        description: z.string(),
        mimeType: z.literal("application/json"),
      })
      .strict(),
    accepts: z.array(X402PaymentRequirementsSchema),
    // The producer currently emits {}. A never-valued record declares that
    // no extension keys are accepted without leaving an opaque object site.
    extensions: z.record(z.string(), z.never()),
  })
  .strict()
  .describe(
    "Direct x402 v2 payment quote, also base64-encoded in PAYMENT-REQUIRED. Select an accepts entry and preserve it unchanged as the signed payload's accepted field.",
  );
