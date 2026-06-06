# Security Policy

Metagraphed publishes public operational metadata only.

## Do Not Submit

- secrets, tokens, PATs, API keys, signed URLs, or webhook URLs;
- wallet paths, seed phrases, hotkeys, coldkeys, keypairs, validator-local state, or private scoring inputs;
- private dashboards, private IPs, localhost URLs, internal hostnames, or credentialed endpoints;
- write/mutating RPC examples.

## Reporting Issues

For public endpoint/status corrections, use the status issue template.

For anything that could expose secrets, credentials, wallets, private infrastructure, or unsafe write access, do not paste sensitive details into a public issue. Open a minimal public issue that says sensitive details are available privately, or contact the maintainer directly.

## RPC Proxy Boundary

The read-only RPC proxy contract is disabled by default. Any future public proxy/load-balancer must keep unsafe/write RPC methods blocked and must be protected by Cloudflare WAF/rate limiting before being enabled.

## Registry Data Boundary

Metagraphed records public interface metadata and public chain-derived subnet facts. A live URL or schema-valid issue is not enough to publish an interface as reviewed registry truth. Maintainers must confirm the source, public accessibility, auth requirements, and probe safety before promotion.

Native chain values may include placeholder names from upstream RPC/SDK sources. Those raw values are preserved as provenance, but public display identity should come from reviewed overlays when the native value is degraded.
