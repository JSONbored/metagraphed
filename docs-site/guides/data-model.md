---
title: Data model
description: How registry source, generated artifacts, and the Worker API relate.
---

# Data model

Metagraphed separates **reviewed source** (in git), **generated artifacts** (deterministic projections), and the **Worker API** (serving layer).

```text
schemas/  ──►  openapi.json + types/clients
                    │
registry/ ──►  public/metagraph/*.json  ──►  Cloudflare R2/KV  ──►  api.metagraph.sh
```

JSON Schema is the canonical contract. Hand-editing `public/metagraph/openapi.json` or generated types breaks CI.

## Registry (source of truth for human input)

| Path                             | Purpose                                             |
| -------------------------------- | --------------------------------------------------- |
| `registry/subnets/<slug>.json`   | Per-subnet overlay: identity, `surfaces[]`, notes   |
| `registry/providers/<slug>.json` | Team/operator identity for provider-scoped surfaces |
| `registry/native/`               | Chain snapshots (Finney/testnet)                    |
| `registry/adapters/`             | Deep adapter pilots (e.g. Gittensor, Allways)       |

A **surface** is one public interface entry:

```jsonc
{
  "id": "sn-7-example-openapi",
  "kind": "openapi", // docs | website | openapi | subnet-api | sse | …
  "url": "https://…",
  "source_urls": ["https://…"], // proof the subnet publishes it
  "authority": "community",
  "review": { "state": "community-submitted", "submitted_by": "…" },
}
```

Health, uptime, latency, and `verification` are **probe-derived** — never set by contributors.

## Generated artifacts

Built by `npm run build` / `scripts/build-artifacts.mjs`. Committed dual-tier artifacts include `openapi.json`, `api-index.json`, and `contracts.json`. High-churn detail (per-subnet JSON, search indexes) is R2-only.

Key consumer artifacts:

| Artifact                          | Role                          |
| --------------------------------- | ----------------------------- |
| `/metagraph/openapi.json`         | OpenAPI 3.1 contract          |
| `/metagraph/api-index.json`       | Route index + query metadata  |
| `/metagraph/contracts.json`       | Artifact catalog              |
| `/metagraph/agent-resources.json` | AI resource index (R2-served) |

## Worker API

`/api/v1/*` routes wrap artifacts in the standard envelope. Raw JSON remains at `/metagraph/*.json` for static tooling.

Network prefixes scope data:

- `/api/v1/…` — mainnet (default)
- `/api/v1/testnet/…` — testnet native registry
- `/api/v1/local` — setup guidance for local subtensor nodes

## Completeness

Coverage and completeness scores are **build-derived** from which surface kinds exist per subnet. The headline metric is trustworthy coverage — provable via `source_urls`, live probes, and the evidence ledger.

Browse live: [metagraph.sh/coverage](https://metagraph.sh/coverage) · API: [`/api/v1/coverage`](https://api.metagraph.sh/api/v1/coverage).
