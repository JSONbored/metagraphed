# Integration readiness

`integration_readiness` is a codified, **objective** score (0–100) for the
question developers and their agents actually ask: *can I build on this subnet
today?* It appears on each subnet in the agent catalog
(`/api/v1/agent-catalog`, `/api/v1/agent-catalog/{netuid}`) and ranks
`find_subnets_by_capability` results in the MCP server.

It is deliberately **not** a subjective quality rating. Every input is a fact
metagraphed already measures, the formula is published here, and the component
breakdown ships alongside the score so you can re-weight it for your own needs.

## What it is not

- **Not live up/down.** Readiness is a *build-time eligibility* signal computed
  from the reproducible registry snapshot — never the 2-minute health prober.
  A subnet can be "ready" and momentarily down. For "is it up right now" use
  `get_subnet_health` / the per-service `health` block. Keeping live status out
  of the score is what lets it stay a deterministic, reproducible artifact value.
- **Not a verdict on the ~99 non-API subnets.** Only ~30 subnets expose callable
  public APIs today; the rest score low because they have nothing to build on
  *yet*, not because they're "bad". This is the buildable-today subset.
- **Not chain economics.** Whether a subnet is worth *running a validator on*
  (emissions, TAO price, miner quality) is a different question — that's chain
  data, not metagraphed's lane.

## Rubric (`readiness_version: 1`)

Score = sum of the component weights below, clamped to 100. Each component is an
objective boolean published under `readiness.components`.

| Component | Weight | True when |
|---|---|---|
| `has_callable_api` | 30 | the subnet exposes ≥1 catalogued service surface |
| `documented` | 25 | ≥1 service has a captured OpenAPI/Swagger schema |
| `auth_clarity` | 15 | every callable service has clear auth — either no auth, or auth required *with* known schemes (so an agent knows whether and how to authenticate) |
| `callable_now` | 15 | ≥1 service is structurally callable (public-safe, not dead/unsafe) |
| `active_lifecycle` | 10 | `lifecycle === "active"` (not deprecated/parked/pending) |
| `profile_complete` | 5 | the subnet's `completeness_score` ≥ 70 |

`auth_clarity` intentionally treats "auth required, schemes known" as **clear** —
it does not penalize an honestly auth-gated API.

## Re-weighting

The composite is one reasonable default. Because every component boolean ships
in `readiness.components`, an agent that, say, doesn't care about docs can
recompute its own score from the components. Treat `integration_readiness` as a
sort key and a filter, and read the components when the default weighting
doesn't match your use case.
