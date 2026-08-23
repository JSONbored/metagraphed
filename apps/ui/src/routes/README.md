# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
is a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` — those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic — bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell — wraps every page; preserve `<Outlet />`     |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## The `-page.tsx` convention

A route file wires the URL; the page it renders lives beside it with a leading
hyphen:

| File                       | What it holds                                  |
| -------------------------- | ---------------------------------------------- |
| `subnets.$netuid.tsx`      | `createFileRoute`, search schema, loader, meta |
| `-subnets-netuid-page.tsx` | the component the route names in `component:`  |

The hyphen is not decoration: TanStack's generator ignores any file in this
directory whose name starts with `-`, so the page module is a plain module the
route imports rather than a route of its own. Splitting them keeps the routing
concerns (params, search, redirects, `head`) readable at a glance, and lets a
page module be imported by a test without dragging the router in.

## The page rules

Every page in this directory obeys the design contract in
`packages/ui-kit/README.md`. The two that bite most often:

- **At most seven `AnalyticsSection`s.** `AnalyticsPage` throws above seven
  outside production, and `token-inventory.spec.ts` asserts it for every swept
  route. A page that answers an eighth question is two pages.
- **No legacy primitives.** The names deleted by
  [#11628](https://github.com/JSONbored/metagraphed/issues/11628) are listed in
  `eslint.config.ts` as `no-restricted-imports`, and their CSS classes are
  asserted absent by the same e2e sweep. Build from the fourteen primitives.

A new route must also be reachable by the design gate: add it to
`tests/e2e/overflow-check.config.ts` with a HAR fixture, or — if it renders no
page of ours — name it in `NOT_SWEPT` with a reason.
`token-inventory-coverage.unit.ts` fails on a route that is neither.
