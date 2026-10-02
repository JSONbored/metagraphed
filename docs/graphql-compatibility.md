# GraphQL compatibility and migration

REST and MCP are the intended Metagraphed interfaces for new integrations. The
website GraphQL explorer is retired. The retained `/api/v1/graphql` endpoint and
`query_graphql` MCP tool serve existing integrations; neither is required to use
the native Bittensor contract, Root basket routes or runtime staking quotes.

The MCP tool now directs new work to named tools and REST. Its name, input/output
schemas, handler, field selection, nested relations, errors, rate limits and
query-only restrictions remain intact. Compatibility queries retain their
deferred schema/handler loading; other MCP tools and REST routes do not call
that bridge. No endpoint removal date is imposed by this PR.

## Choose the replacement by operation

Use the shared operation registry in `src/operations.ts` to resolve a published
GraphQL field to its REST route and named MCP tools. It derives these exposures
from the canonical route contracts; do not maintain a second mapping or infer a
route by converting a field name to kebab case.

For example, a subnet lookup belongs to `get_subnet` or
`GET /api/v1/subnets/{netuid}`; subnet discovery belongs to `list_subnets` or
`GET /api/v1/subnets`. Inspect the route/tool's own schema for supported filters,
pagination and output fields. REST envelopes and complete MCP objects differ
from a GraphQL caller's selected field projection, so migrating a query requires
updating its result handling.

For native storage, constants, runtime APIs and unsigned call preparation, use
`get_native_runtime` or `POST /api/v1/native-runtime`. These share one schema and
portable metadata contract, finalized source identity, exact quantities and
bounded collection pages. They do not require a GraphQL type or resolver for
each new on-chain feature. See [native runtime contract](native-runtime-contract.md).

Root basket directories and account positions use `get_root_baskets` and
`get_account_root_baskets`, or the matching REST routes. Runtime staking quotes
use `get_subnet_stake_quote` and its REST route. The retained GraphQL quote calls
the same runtime simulation rather than maintaining separate swap arithmetic.

Use `get_api_schema` and the declared `call_subnet_surface` /
`write_subnet_surface` operations for subnet provider APIs. Caller credentials,
captured schemas, permissions and safety gates still apply. GraphQL does not
grant access to an undeclared or disabled subnet operation.

## Retirement evidence still required

[Issue #11726](https://github.com/JSONbored/metagraphed/issues/11726) requires
external consumer and migration evidence before the endpoint is switched off.
The retained MCP bridge is itself a documented compatibility consumer. This PR
does not infer zero use from the removed website UI or from fixture tests.

Any eventual removal must separately qualify field/result migration and the
subscription transports that remain in service. Do not remove shared operation
metadata, query validation or feed protections merely because their current
files or comments mention GraphQL. Protected feed/decoder infrastructure and
production activation remain outside this PR.
