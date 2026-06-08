## Goal
Eliminate blurry favicons across `/providers`, `/providers/:slug`, `/subnets`, `/subnets/:netuid`.

## Root cause
`BrandIcon` calls Google S2 at `sz = displaySize × 2` (~64px). Many ecosystem sites only expose a 16×16 `favicon.ico`, which S2 upscales — that's the blur. Retina screens make it worse.

## Fix

### 1. Multi-source candidate chain in `BrandIcon`
Replace the single-source render with an ordered chain, advancing on `onError` or when `naturalWidth < displaySize` (would upscale):

1. Explicit `iconUrl` prop (curated override or API-provided)
2. `https://icons.duckduckgo.com/ip3/{host}.ico` — usually serves the site's largest favicon
3. `https://www.google.com/s2/favicons?sz=128&domain={host}` — bumped from 64 to 128
4. GitHub org avatar when a `repo` URL is `github.com/{org}/...` → `https://github.com/{org}.png?size=128`
5. Monogram tile

Cache the winning candidate per host in the existing module-level map so the chain only walks once. Keep `loading="lazy"`, fixed dimensions, and the skeleton placeholder.

### 2. Curated overrides (`src/lib/metagraphed/brand-overrides.ts` — new)
`resolveBrandIcon({ providerSlug?, netuid?, subnetSlug?, website? })` returns a CDN URL when we have a hand-picked logo. I'll source as many as I can confidently find — official site `/apple-touch-icon.png` (typically 180×180), press-kit SVG/PNG, or GitHub org avatar — at ≥128px or SVG. Uploaded via `lovable-assets create` and referenced as `.asset.json` imports. Targets include: Bittensor/OTF, TaoStats, Tensorplex, Macrocosmos, Datura, Nineteen, Corcel, Manifold, Cortex.t, Allways (SN7), Gittensor (SN74), Targon, Bitmind, Compute Horde, Subnet 1 (Apex), and anything visible on the current `/providers` list.

If I can't find a clean ≥128px source for an entry, I skip it and let the auto chain handle it.

### 3. Retina-aware rendering
- Provide `srcset` for the S2/DDG candidates with `1x` at displaySize and `2x` at `displaySize × 2` so devices fetch the right density.
- Apply `image-rendering: -webkit-optimize-contrast` to mitigate any residual upscale.
- Prefetch (existing `prefetchBrandIcon`) warms only the first candidate.

### 4. Wire overrides at call sites
`providers.index.tsx`, `providers.$slug.tsx`, `subnets.index.tsx`, `subnets.$netuid.tsx` pass `providerSlug` / `netuid` / `subnetSlug` so `BrandIcon` can resolve curated overrides before falling back to the auto chain.

## Files
- `src/components/metagraphed/brand-icon.tsx` — chain + srcset + low-res rejection
- `src/lib/metagraphed/brand-overrides.ts` — **new**, override maps + resolver
- `src/assets/brand/*.png.asset.json` — **new**, curated CDN logos
- `src/routes/providers.index.tsx`, `src/routes/providers.$slug.tsx`, `src/routes/subnets.index.tsx`, `src/routes/subnets.$netuid.tsx` — pass slug/netuid props

## Out of scope
- Backend `icon_url` population (still respected when present)
- Dark-mode logo variants
- Server-side image proxy/resizer
