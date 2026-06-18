# Integration readiness

`integration_readiness` is a codified, **objective** score (0–100) for the
question developers and their agents actually ask: _can I build on this subnet
today?_ It appears on each subnet in the agent catalog
(`/api/v1/agent-catalog`, `/api/v1/agent-catalog/{netuid}`) and ranks
`find_subnets_by_capability` results in the MCP server.

It is deliberately **not** a subjective quality rating. Every input is a fact
metagraphed already measures, the formula is published here, and the component
breakdown ships alongside the score so you can re-weight it for your own needs.

## What it is not

- **Not live up/down.** Readiness is a _build-time eligibility_ signal computed
  from the reproducible registry snapshot — never the 2-minute health prober.
  A subnet can be "ready" and momentarily down. For "is it up right now" use
  `get_subnet_health` / the per-service `health` block. Keeping live status out
  of the score is what lets it stay a deterministic, reproducible artifact value.
- **Not a verdict on the ~99 non-API subnets.** Only ~30 subnets expose callable
  public APIs today; the rest score low because they have nothing to build on
  _yet_, not because they're "bad". This is the buildable-today subset.
- **Not chain economics.** Whether a subnet is worth _running a validator on_
  (emissions, TAO price, miner quality) is a different question — that's chain
  data, not metagraphed's lane.

## Rubric (`readiness_version: 2`)

Score = sum of the component weights below, clamped to 100. Each component is an
objective boolean published under `readiness.components`.

| Component           | Weight | True when                                                                                                                                         |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `has_callable_api`  | 30     | the subnet exposes ≥1 catalogued service surface                                                                                                  |
| `documented`        | 25     | ≥1 service has a captured OpenAPI/Swagger schema                                                                                                  |
| `auth_clarity`      | 15     | every callable service has clear auth — either no auth, or auth required _with_ known schemes (so an agent knows whether and how to authenticate) |
| `callable_now`      | 15     | ≥1 service is structurally callable (public-safe, not dead/unsafe)                                                                                |
| `active_lifecycle`  | 10     | `lifecycle === "active"` (not deprecated/parked/pending)                                                                                          |
| `profile_complete`  | 5      | the subnet's `completeness_score` ≥ 70                                                                                                            |
| `has_source_repo`   | 4      | a source repository is recorded (curated or chain identity)                                                                                       |
| `has_candidate_api` | 4      | a community-flagged candidate surface of an operational kind exists (unverified — does not imply callable)                                        |
| `has_public_docs`   | 3      | a documentation link is recorded, even without a captured schema (distinct from `documented`)                                                     |

`auth_clarity` intentionally treats "auth required, schemes known" as **clear** —
it does not penalize an honestly auth-gated API. The three low-weight components
added in `readiness_version: 2` (#356) carry **no** dependency on a callable API,
so the large API-less tail stops cliffing at one score and becomes a ranked
curation pipeline; they cannot, combined, lift an API-less subnet above ~21.

## Readiness tier (`readiness.readiness_tier`)

A categorical gradient derived purely from the components (so it stays stable if
weights are re-tuned), for filtering/sorting the tail without thresholding the
score:

| Tier            | When                                                              |
| --------------- | ----------------------------------------------------------------- |
| `buildable`     | `has_callable_api` — a verified callable surface exists           |
| `emerging`      | no callable API, but `has_candidate_api` or `has_public_docs`     |
| `identity-only` | neither of the above, but `has_source_repo` or `active_lifecycle` |
| `dormant`       | none — no interface, no candidate, no docs, no repo, not active   |

## Blocker reasons (`agent_readiness`)

The agent catalog keeps its existing `subnets` array as the callable subset, and
adds `blocked_subnets` for the rest of the registry. Each callable and blocked
row carries an `agent_readiness` object:

- `status`: `callable`, `base-layer`, `candidate`, `needs-evidence`, or
  `blocked`.
- `blocker_level`: `none`, `hard-blocked`, `needs-review`, or `missing-data`.
- `blockers[]`: stable `{ code, severity, message, field, next_action }`
  objects.
- `missing_fields[]`: deduplicated fields/evidence families from
  `missing-data` blockers.

The blocker model is not a second score. It is a deterministic explanation of
the same readiness facts, shaped for agents and UI filters. Use it when a subnet
is absent from the callable subset and the user asks why.

## Coverage depth scorecard

`GET /api/v1/coverage-depth` publishes the registry-wide prioritization view.
It is generated from the same public-safe build data as `agent-catalog`,
`fixtures.json`, schema snapshots, profiles, candidates, and surface authority.

Use it when the question is "what should we enrich next and why?". It provides:

- `summary`: row counts, tier counts, blocker-level counts, severity counts,
  and gap-code counts.
- `rows[]`: one row per subnet, sorted by `netuid`, with a deterministic
  `score`, `tier`, `dimensions`, `top_gaps`, and `recommended_next_action`.
- `ranked_queue[]`: the highest-priority actionable rows, sorted by
  `priority_score`, then lower score, then `netuid`.

The scorecard intentionally separates three classes of work:

- `missing-data`: data we should add or explicitly mark absent, such as schemas,
  fixtures, examples, docs, source repos, or profile fields.
- `needs-review`: evidence exists, but a maintainer needs to verify authority or
  promote a candidate surface.
- `hard`: the subnet should not be recommended for application integration in
  its current state, such as root/base-layer-only or inactive lifecycle.

The score is deterministic and build-time only. Live up/down remains the health
overlay and should not be inferred from `coverage-depth`.

Common blocker codes:

| Code                         | Meaning                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `base-layer-only`            | root/base-layer surfaces are not application-subnet APIs                 |
| `inactive-lifecycle`         | the subnet is not marked active in the registry snapshot                 |
| `missing-callable-service`   | no public-safe callable service is catalogued yet                        |
| `service-not-callable`       | services exist, but none are structurally callable                       |
| `candidate-api-needs-review` | an unpromoted candidate operational surface needs maintainer review      |
| `no-candidate-api`           | no candidate API surface has been found                                  |
| `missing-schema`             | callable services exist but no captured schema artifact is available     |
| `unclear-auth`               | callable services exist but auth metadata is not machine-readable enough |
| `missing-docs`               | no public documentation link is recorded                                 |
| `missing-source-repo`        | no public source repository is recorded                                  |
| `profile-incomplete`         | the subnet profile is below the completeness threshold                   |

## Schema projection (`schema_source`)

Agent-catalog services expose `schema_artifact` when Metagraphed has a captured
machine-readable schema for the service. The schema can be linked three ways:

| Match type            | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `surface-id`          | the service row is itself the captured schema/OpenAPI surface          |
| `schema-url`          | the service row declares the same machine-readable `schema_url`        |
| `same-origin-openapi` | a captured OpenAPI surface for the same subnet and origin is available |

`schema_source` carries the source surface id, schema URL, artifact path,
capture status, observed timestamp, and content hash. Agents should prefer
exact `surface-id` and `schema-url` matches for endpoint-specific code
generation. Treat `same-origin-openapi` as a strong pointer to the canonical
API contract, then inspect the schema artifact before claiming a specific path
or request shape is supported.

## Fixture status (`fixture_status`)

Agent-catalog services expose fixture availability separately from schemas:

| Status             | Meaning                                                   |
| ------------------ | --------------------------------------------------------- |
| `available`        | a sanitized request/response fixture exists               |
| `missing`          | no fixture has been captured yet                          |
| `capture-failed`   | the capture run tried the service and could not save JSON |
| `auth-required`    | capture is skipped because credentials are required       |
| `non-get`          | capture is skipped because the probe is disabled/non-GET  |
| `unsupported-kind` | capture is skipped because the service kind is not JSON   |

Use `fixture_status` to explain absence. Use `fixture.artifact_path` only when
the status is `available`.

## Live verification (`readiness.readiness_verified`)

The numeric `score` is deliberately build-time and deterministic, so
`has_callable_api` fires on a _catalogued_ surface — a subnet can score 100 with
a dead API. `readiness_verified` (#357) closes that gap **at serve time only**:
it is `true` when ≥1 catalogued surface was probed healthy (status `"ok"`) by the
live 2-minute cron. It is **absent** on the static build artifact (there is no
live truth there) and overlaid onto live agent-catalog detail responses. Treat it
as the "proven callable right now" gate on top of the deterministic score — an
agent that needs ground truth before wiring should require
`readiness_verified === true`, not just a high score.

## Re-weighting

The composite is one reasonable default. Because every component boolean ships
in `readiness.components`, an agent that, say, doesn't care about docs can
recompute its own score from the components. Treat `integration_readiness` as a
sort key and a filter, and read the components when the default weighting
doesn't match your use case.
