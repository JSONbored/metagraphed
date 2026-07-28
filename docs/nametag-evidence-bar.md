# Nametag Evidence Bar

Metagraphed resolves on-chain identities where a subnet or account has set
one, but the addresses people most need labeled never do that: exchange hot
and cold wallets, bridge escrows, foundation and treasury accounts, large
pools. `registry/entities/<ss58>.json` is the curated layer that fills that
gap — one community-contributable file per address, reviewed the same way
every other registry contribution is.

This page is the evidence bar for that specific kind of contribution. It's
not a tutorial on the general contribution flow — see
`.claude/skills/metagraphed/SKILL.md` for that. It's the answer to one
question: **what counts as proof that this address belongs to this entity?**

## What a nametag PR must contain

One new file, `registry/entities/<ss58>.json`, matching
`schemas/entity.schema.json`:

```json
{
  "schema_version": 1,
  "ss58": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  "name": "Example Foundation",
  "category": "foundation",
  "url": "https://example.org",
  "notes": "Optional: anything a reader needs that the name/category don't already say.",
  "source_urls": ["https://example.org/treasury-addresses"],
  "review": { "state": "community-submitted" }
}
```

- **`ss58`** must decode to a real, checksummed Bittensor (network prefix 42)
  address — a well-formed-looking string that fails checksum validation is
  rejected, not silently accepted (`scripts/validate-schemas.ts`). It must
  also match the filename exactly: `registry/entities/<that ss58>.json`.
- **`category`** is one of `exchange`, `bridge`, `foundation`, `pool`,
  `infra`, `project`, or the older `operator`/`other` (kept for entries that
  predate the wider set — prefer the more specific category for new
  entries).
- **`url`** is the entity's own canonical homepage, for linking the rendered
  nametag. This is presentation, not proof — see the next section for what
  actually counts as proof.

## What counts as proof (`source_urls`)

`source_urls` is the whole point of this file. Every entry needs **at least
one independent, public, verifiable-by-anyone source that ties this specific
address to this specific entity** — not that the entity exists, not that the
address exists, but that the two are the same thing.

**Accepted:**

- The entity's own official documentation, blog post, or announcement that
  states the address (e.g. a foundation's published treasury address, an
  exchange's published deposit/hot-wallet address list).
- A signed, verifiable on-chain or off-chain announcement from a key
  provably controlled by the entity (e.g. a message signed by the address
  itself, published somewhere the entity's identity is independently
  confirmed).
- A well-known Bittensor data provider's own address tag for this specific
  address, where that provider states its own evidence for the tag (not
  just "this explorer also labels it this way" — that's circular; the
  proof has to bottom out in something the entity itself said or did).

**Not accepted, on their own:**

- "Everyone knows this is Binance's wallet" — folklore, no citation.
- A forum post, tweet, or Discord message from someone who isn't
  demonstrably the entity, asserting the address is theirs.
- Inference from transaction patterns alone (e.g. "this address receives
  large amounts from many accounts, so it's probably an exchange") — a
  behavioral pattern is not attribution.
- A truncated or partially-matching address from another source — the
  full, exact ss58 must appear in the cited source.

If you can't cite something that clears this bar, the entry doesn't belong
in the registry yet — file it as a note for later rather than guess. A
wrong nametag is actively worse than no nametag: it's a specific, confident,
_wrong_ claim rendered next to real financial activity, not a merely
incomplete one.

## Review

Every new entry starts `review.state: "community-submitted"`. A maintainer
promotes it to `"maintainer-reviewed"` after checking the cited source
actually supports the claim, or marks it `"rejected"` if it doesn't. The
same public-safety scan (`npm run scan:public-safety`) and registry
validators (`npm run validate:schemas`) that gate every other registry
contribution apply here unchanged.

## What this registry is not

- **Not self-service labeling.** You cannot label your own address, or
  anyone else's, without the evidence above — this is a curated public
  record, not a personal note. (If you want a private label for your own
  wallets, that's a different, browser-local feature — see #8484.)
- **Not paid placement.** There is no path to a nametag other than
  verifiable public evidence, reviewed the same way as any other registry
  PR.
- **Not a write path for anything beyond the file itself.** A nametag PR
  touches exactly one file: `registry/entities/<ss58>.json`. Nothing else.
