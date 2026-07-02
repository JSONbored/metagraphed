# Endpoint Operations Playbook

Metagraphed tracks endpoint resources across two different layers:

- root/system Bittensor endpoints: Subtensor RPC, WSS, and archive-capable endpoints for Finney;
- subnet app endpoints: public APIs, OpenAPI/Swagger schemas, SSE streams, dashboards, data artifacts, docs, source repos, SDKs, and examples.

Bittensor subnets are not separate Cosmos chains, so Metagraphed does not pretend every subnet has its own RPC/API/gRPC/seed-node set. The Cosmos Directory-style idea applies as a registry, monitoring, provider, and future load-balanced access model, but the endpoint categories are Bittensor-native.

## Operator Brief

Use the endpoint operations brief when reviewing production readiness, endpoint health, provider scores, incidents, or future pool eligibility:

```bash
npm run endpoint:brief
```

For machine-readable output:

```bash
npm run endpoint:brief -- --json
```

Useful focused output:

```bash
npm run endpoint:brief -- --limit 5
```

The brief reads existing generated artifacts through the same storage-tier-aware path resolution used by the backend. Compact artifacts can come from `public/metagraph`; high-churn endpoint details come from the R2 staging tree when present.

## Health Authority

Endpoint health is probe-derived only.

Contributor submissions and status reports can:

- add candidate endpoint resources;
- correct provider/operator metadata;
- add source URLs, auth notes, or rate-limit notes;
- request a re-probe or review;
- identify a broken or moved endpoint.

Contributor submissions cannot:

- set uptime;
- set latency;
- set latest block;
- set incident state;
- make an endpoint pool-eligible;
- mark an endpoint healthy.

Observed health comes from scheduled probes, smoke checks, and adapter-specific checks.

## Pool Eligibility

Pool eligibility is conservative in v1:

- only root/system Bittensor base-layer endpoints are eligible;
- endpoints must be public-safe, unauthenticated, monitored, and currently `ok`;
- stale or degraded endpoints should fall out of eligibility;
- provider/operator review state is part of the readiness model;
- the public RPC proxy remains disabled unless explicitly enabled later.

The disabled proxy contract exists so the API shape can be reviewed before any traffic is routed. Future proxy/load-balancer work must keep write and unsafe RPC methods blocked by default.

## Contributor Targets

Good direct contributions:

- official subnet docs;
- official websites;
- source repos;
- dashboards;
- OpenAPI or Swagger JSON URLs;
- public subnet APIs;
- SSE endpoints;
- data artifacts;
- SDKs or examples;
- auth and rate-limit corrections.

Manual-review contributions:

- provider/operator profiles;
- base-layer RPC/WSS/archive endpoints;
- authenticated APIs;
- adapter requests;
- identity disputes;
- endpoint status reports.

Rejected contributions:

- generated artifacts;
- wallet paths;
- PATs, API keys, or secrets;
- validator internals;
- private dashboards;
- Discord-only claims;
- subjective rankings;
- price or alpha opinions.

## Current Limitations

Metagraphed has complete active-netuid coverage, but subnet depth varies by what each subnet publicly exposes and what has been verified. “Fully curated” means maximum verified public-operational coverage for that subnet, not forcing every subnet into the same endpoint shape.

Deep enrichment remains ongoing for subnets that still lack official identity, docs, source repos, websites, public APIs, schemas, or data surfaces.
