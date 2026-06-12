# Security Policy

Metagraphed publishes public operational metadata only.

## Reporting a Vulnerability

**Report security vulnerabilities privately** via GitHub's "Report a vulnerability" (private security advisories):

**https://github.com/JSONbored/metagraphed/security/advisories/new**

Never open a public issue for anything that could expose secrets, credentials, wallets, private infrastructure, or unsafe write access. The private advisory channel lets us triage and ship a fix before details are public.

For **non-sensitive** public endpoint/status corrections (e.g. a stale URL or a wrong health status), use the status issue template instead.

## Supported Versions

Metagraphed is a continuously deployed service. Security fixes land on `main` and ship via the standard deploy pipeline; only the latest release of the published clients (`@jsonbored/metagraphed` on npm, `metagraphed` on PyPI) is supported.

## Do Not Submit

- secrets, tokens, PATs, API keys, signed URLs, or webhook URLs;
- wallet paths, seed phrases, hotkeys, coldkeys, keypairs, validator-local state, or private scoring inputs;
- private dashboards, private IPs, localhost URLs, internal hostnames, or credentialed endpoints;
- write/mutating RPC examples.

## RPC Proxy Boundary

The read-only RPC proxy contract is disabled by default. Any future public proxy/load-balancer must keep unsafe/write RPC methods blocked and must be protected by Cloudflare WAF/rate limiting before being enabled.

## Registry Data Boundary

Metagraphed records public interface metadata and public chain-derived subnet facts. A live URL or schema-valid issue is not enough to publish an interface as reviewed registry truth. Maintainers must confirm the source, public accessibility, auth requirements, and probe safety before promotion.

Native chain values may include placeholder names from upstream RPC/SDK sources. Those raw values are preserved as provenance, but public display identity should come from reviewed overlays when the native value is degraded.
