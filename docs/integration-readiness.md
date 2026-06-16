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
