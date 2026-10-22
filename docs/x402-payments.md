# REST x402 payments

The registry and ordinary reads remain available under their anonymous limits.
Eligible routes accept an optional payment for additional rate and quota
headroom. Bulk chain-event exports require payment. The route-family policy in
`src/x402-pricing.ts` owns that distinction; the generated OpenAPI document
describes each operation's payment behavior.

## Mainnet configuration

The reviewed production configuration selects PayAI's public facilitator at
`https://facilitator.payai.network` and Base mainnet native USDC
(`eip155:8453`, asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). The
existing receiving address remains unchanged. Configuration is in
`wrangler.jsonc`; network-to-asset mappings are in `src/x402.ts`.

The public facilitator lane requires no merchant authentication while the
receiving wallet has available credits. PayAI provides an initial free credit
allowance; ongoing settlement can require purchased credits. Its credit prices
and remaining allowance are external operational state, not a service guarantee.
This integration does not purchase credits or create a PayAI account. A future
authenticated lane must use PayAI's documented Ed25519 JWT authentication on
capability discovery and settlement together; a raw API-key header is not a
substitute.

Before issuing new quotes, the API reads the selected facilitator's `/supported`
document with bounded response size, timeout and a short cache. It offers only
the exact-v2 networks supported by that public lane. Solana's `feePayer`, when
needed, comes from this response rather than a committed signer address.

Solana mainnet USDC support is prepared, but `X402_SOLANA_ENABLED=false` keeps
it out of quotes and discovery until the merchant's native-USDC associated
token account exists. PayAI does not create the receiving token account. The
existing Solana recipient was observed without a USDC token account during
preparation. Enabling Solana requires the wallet owner to initialize that
account or approve a different recipient, followed by a finalized readback and
a reviewed configuration change. Never request the wallet seed. Base can
operate independently of this prerequisite.

## Client flow and retries

1. Request the desired operation without a payment. A required-payment route
   returns HTTP 402 with a direct JSON quote and the identical quote encoded as
   base64 JSON in `PAYMENT-REQUIRED`. Optional-payment routes retain anonymous
   access when the header is absent.
2. Select an entry in `accepts`. Copy it unchanged into the v2 payment's
   `accepted` field, then prepare the scheme-specific signed authorization.
   Prices, assets, recipients, timeouts and facilitator extras come from this
   quote. Send the base64 JSON payload in `PAYMENT-SIGNATURE`.
3. On success, read the base64 JSON `PAYMENT-RESPONSE` settlement receipt.
   A receipt authorizes one paid operation. It is not a reusable access token.

The API binds a verified signed-payment identity to the exact HTTP method,
full URL including query, and body bytes in D1 before submitting settlement.
It persists the original facilitator URL and envelope so an uncertain attempt
can be reconciled even if current configuration or capabilities change. A
conditional database update grants paid execution once. Consumed attempts
retain the receipt permanently and discard the full settlement envelope.

| Response                      | Client action                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 malformed payment         | Correct the encoding or request before signing again.                                                                                               |
| 402 rejected payment          | Read the new quote and its error before preparing a replacement.                                                                                    |
| 409 `x402_payment_conflict`   | The same payment was bound to another request; do not reuse it for this operation.                                                                  |
| 409 `x402_payment_consumed`   | Read the saved receipt; the API will not execute the operation again.                                                                               |
| 503 `x402_settlement_pending` | After `Retry-After`, retry the identical request with the identical payment payload. Do not create another payment while the outcome is unresolved. |
| 503 `x402_unavailable`        | Payment discovery, storage or a dependency is unavailable. Retry after the indicated delay.                                                         |

No pending or consumed response supplies a replacement quote. A network error
after settlement may leave a payment consumed without a delivered operation;
the saved receipt supports reconciliation, but the API does not promise
exactly-once result delivery or automatic refunds. It prioritizes preventing
another charge or repeated paid work on a replay.

## Storage and rollout

`migrations/d1/0039_x402_payment_attempts.sql` creates the private attempt
journal in the existing `D1_STATE` database. Missing bindings, a missing
migration or failed journal writes stop payment processing before a new
settlement. The table is internal settlement state and is excluded from
public D1 exports.

The committed physical schema can be generated as an expected postmigration
projection without touching production. That projection is review evidence,
not a live database readback. After an approved merge, the existing D1
maintenance workflow applies tracked migrations and verifies the actual
ledger and physical schema. API deployment and database migration are separate
acceptance events; confirm both before treating the payment rail as available.

Passive checks may inspect `/.well-known/x402`, facilitator capabilities and
an unpaid export quote. They must not submit `/settle`, sign a payment, create
a receiving token account or purchase credits. A real mainnet settlement is a
separate wallet-owner action and is not implied by a successful unit test or
readiness scan. The pay-skills catalog additionally requires usable Solana
mainnet payments, so Base-only deployment does not establish catalog readiness.
