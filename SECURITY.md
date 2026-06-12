# Security Policy

metagraphed-ui is the public web frontend for
[Metagraphed](https://github.com/JSONbored/metagraphed). It ships no credentials or
secrets and renders only public, read-only data from the `api.metagraph.sh` API.

## Reporting a Vulnerability

**Report security vulnerabilities privately** via GitHub's "Report a vulnerability"
(private security advisories):

**https://github.com/JSONbored/metagraphed-ui/security/advisories/new**

Never open a public issue for a security problem — the private advisory channel lets us
triage and ship a fix before details are public.

## Scope

- **Code/build vulnerabilities** in this frontend → report here (link above).
- **Registry data concerns** (a wrong or unsafe subnet interface, endpoint, or chain
  value) belong to the backend — see its
  [security policy](https://github.com/JSONbored/metagraphed/blob/main/SECURITY.md).

## Supported Versions

This app is continuously deployed; fixes land on `main` and ship via Cloudflare Workers
Builds. Only the version deployed at [metagraph.sh](https://metagraph.sh) is supported.
