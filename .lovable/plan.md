## Goal
Frontend-side scaffolding for the three remaining items: backend `icon_url` respect, dark-mode logo variants with auto-contrast tile, and a proxy-aware `BrandIcon` ready for the Cloudflare-KV-backed icon service you'll run separately.

---

## 1. Icon proxy integration (frontend-ready, backend lives elsewhere)

### Config
- Add `VITE_ICON_PROXY_URL` env var (e.g. `https://metagraph.sh/api/v1/icon`). When set, `BrandIcon` adds the proxy as the **highest-priority auto candidate** in the resolution chain, ahead of DDG/S2/GitHub.
- Falls through to the existing chain on 4xx/5xx, so the app keeps working before the backend ships.

### Contract (documented in `src/lib/metagraphed/brand-overrides.ts`)
Defines what the backend route must implement. No code change to backend; just the spec your separate project will implement:
```
GET {VITE_ICON_PROXY_URL}?host={domain}&size={px}&theme={light|dark}
  → 200 image/png|svg (normalized square, ≥ size)
  → 404 if no usable source found
Cache-Control: public, max-age=2592000, immutable
ETag supported
```
- `theme` is optional; backend may serve a dark-mode variant when one exists.
- `size` is a hint, backend should serve ≥ size and ≤ 2×size.

### Client behavior
- Send the requested size at `displaySize × 2` for retina; render at displaySize.
- Existing low-res rejection still applies — if proxy returns something smaller than displaySize, we advance.
- Per-host winner cache means a successful proxy hit short-circuits all later renders.

---

## 2. Dark-mode variants

### Override schema (`src/lib/metagraphed/brand-overrides.ts`)
Switch override entries from `string` to `{ light: string; dark?: string }`. Existing string entries auto-coerce to `{ light: <url> }`. Backwards compatible.

```ts
{ light: "https://github.com/opentensor.png?size=192",
  dark:  "https://.../opentensor-dark.png" }   // optional
```

`resolveBrandOverride()` gains a `theme` arg and returns the dark URL when present + theme is dark, otherwise light.

### Theme detection
- Read from the project's existing theme system. (I'll check `__root.tsx` / a `useTheme` hook; if none exists, fall back to `window.matchMedia('(prefers-color-scheme: dark)')` inside a hydration-safe hook.)
- `BrandIcon` re-resolves the candidate chain when theme changes.

### Auto-contrast tile (handles the long tail with no dark variant)
After a successful image load:
1. Draw it to an offscreen `<canvas>` at small size (~16×16).
2. Sample alpha-weighted mean luminance of non-transparent pixels.
3. If the active theme is dark and mean luminance < threshold (logo is dark-on-light), wrap the `<img>` in a white-ish tile background (`bg-white/95`) with the existing rounded border. Otherwise leave transparent over the surface token.
4. Cache the decision per source URL at module scope (same map style as `winnerByHost`) so we only sample once per session.

Failure-safe: any canvas/CORS issue silently skips the analysis and renders as-is.

---

## 3. Backend `icon_url` respect (already in place, formalize)

Frontend already passes `iconUrl` through to `BrandIcon`. To make the contract clearer for the registry side:
- Extend types so `icon_url` on `Provider` / `Subnet` / `SubnetProfile` accepts either a string or `{ light: string; dark?: string }`.
- `BrandIcon` accepts both shapes via a new `iconUrl: string | { light: string; dark?: string } | null` prop signature.
- Document in `src/lib/metagraphed/brand-overrides.ts` (header comment) the resolution priority used everywhere:
  1. `iconUrl` from API (per-entry, registry-controlled)
  2. Curated frontend overrides (this file)
  3. Icon proxy (when `VITE_ICON_PROXY_URL` set)
  4. GitHub org avatar (from `repo` URL)
  5. DuckDuckGo icons
  6. Google S2 @128
  7. Monogram tile

---

## Files
- `src/components/metagraphed/brand-icon.tsx` — proxy candidate, theme-aware chain, canvas luminance check, contrast tile, dark prop plumbing.
- `src/lib/metagraphed/brand-overrides.ts` — `{ light, dark? }` schema, `resolveBrandOverride(lookup, theme)`, backend contract docblock.
- `src/lib/metagraphed/types.ts` — widen `icon_url` typing on `Provider` / `Subnet` / `SubnetProfile` / `PrimaryLinks`.
- `src/hooks/use-color-scheme.ts` *(new, only if no existing theme hook)* — hydration-safe `'light' | 'dark'` resolver.
- `.env.example` — add `VITE_ICON_PROXY_URL=` with a comment pointing at the backend contract.

## Out of scope (still)
- Building the actual proxy/resize Worker — you said your backend project will own this.
- Sourcing dark-mode logo URLs en masse — I'll seed 2–3 obvious ones (Opentensor, TaoStats) and leave the rest for organic growth.
