// The per-Worker env types, given importable names (#11339).
//
// `wrangler types` writes each Worker's interface into a global `.d.ts`, which
// makes them AMBIENT: usable anywhere without an import, and impossible to
// import by name. Test helpers and any cross-Worker call site need the name, so
// this module aliases each one into an ordinary export.
//
// Nothing here declares anything -- every alias resolves to the generated
// interface. If a name below stops resolving, the generated file it mirrors
// changed and `npm run types:workers` is the fix.

/** The main API Worker (wrangler.jsonc). */
export type ApiWorkerEnv = Env;

/** The data API Worker (wrangler.data.jsonc). */
export type DataApiWorkerEnv = DataApiEnv;

/** The registry sync Worker (wrangler.registry.jsonc). */
export type RegistrySyncWorkerEnv = RegistrySyncApiEnv;

// NO alias for wrangler.wss-lb.jsonc's `WssLbWorkerEnv`. That Worker declares
// its own `WssLbEnv` by hand -- see workers/wss-lb.ts's header, which is where
// the merged-Env trap was first written down -- and never reaches for the
// generated one. An unused alias here would be a name nothing imports.
