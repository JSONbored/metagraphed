# Internal API-key state capability

`POST /api/v1/internal/keys/state` checks the application ledger for a
provider key identifier and its verified account identity. It requires the
same internal token as `/api/v1/internal/keys/verify`; it does not accept a
wallet session as that capability. The request body is
`{ "keyId": "key_example", "accountId": "7" }`.

The response is `{ "state": "..." }`, with `cache-control: no-store`:

| State       | Meaning                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`    | The key row is active, its account matches the verified identity, and its owner account exists.                                                |
| `pending`   | A revocation intent is recorded; access must be denied.                                                                                        |
| `revoked`   | Completed revocation is recorded; access must be denied.                                                                                       |
| `unmanaged` | No application row exists for this provider identifier. This is not an authorization grant; a request must obtain fresh external verification. |
| `denied`    | A known key has an invalid or mismatched account binding, or its owner account no longer exists.                                               |

Pending or revoked rows deny access even when the supplied account differs.
A missing binding, database failure, invalid body, or invalid token produces
an error response; none is treated as an unmanaged credential.

The query uses the existing unique provider-key index and the account
primary key. It requires a Hyperdrive configuration with query caching
disabled. There is no application cache for these state results.
[Cloudflare documents that writes do not invalidate cached SELECT results
and recommends a cache-disabled configuration for authentication reads.](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)

The internal verification route checks ledger state after the provider
responds. A successful internal result adds `keyId` and `managed` to the
existing `valid`, `code`, `tier`, and `accountId` fields. Managed results
require an active matching ledger row. Unmanaged results retain the freshly
verified provider identity without inserting a ledger row. The provider
remains the source for tier values; the ledger guard does not change them.

The key list adds `revocation_requested_at` and `revocation_state` to each
existing row. The states are `active`, `pending`, and `revoked`, with
`revoked_at` taking precedence over a pending timestamp. The nullable intent
column preserves existing records and can be deployed before its writers.

Apply migration 0038 and verify the nullable column in the bound database
before deploying the internal capability. Then deploy its request enforcement
consumers and the compatible settings UI. The intent writer requires the
migration, capability, all enforcing readers, and UI to be confirmed deployed.
The capability uses an explicit typed SELECT projection; the generated live
schema snapshot follows its separate refresh and policy workflow tracked in
#12072.

The owned DELETE route records `revocation_requested_at` before calling the
provider. This immediately causes the state readers to deny access. An intent
write failure leaves provider state untouched and returns the existing error.
Unknown IDs and IDs owned by another account retain the same 404 response.

After intent commits, provider failure or a failed completion write returns
HTTP 502 with this body:

```json
{
  "error": {
    "code": "KEY_REVOCATION_PENDING",
    "message": "Key access is disabled. Revocation confirmation is pending; retry."
  },
  "key_id": "key_example",
  "revoked": false,
  "revocation_state": "pending",
  "access_disabled": true
}
```

The key list continues to show pending until completion is persisted. Retrying
the same DELETE preserves the first intent timestamp and retries provider
confirmation. Once the provider confirms and the completion write succeeds,
the response is the existing HTTP 200 `{ "key_id": "key_example", "revoked": true }`.
Repeating an owned completed revoke returns that same success without another
provider call. There is no background retry; the settings UI offers the retry
action and refreshes the list after both successful and failed requests.

The ledger guard addresses application-managed state. Changes made directly
at the external provider still require a new provider observation; the ledger
does not independently observe provider-side disable, deletion, or expiry.
