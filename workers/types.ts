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

/**
 * The merged single-Worker env (#13142/#13143): a folded Worker's own env plus
 * every main-Worker member it does not declare itself. Where a name exists on
 * both — shared vars like D1_STATE_TABLES, whose generated literal types
 * differ per config — the FOLDED Worker's declaration is kept, so the merged
 * env stays assignable to that Worker's handler signature; a plain
 * intersection would collapse any such member (and with it the whole env) to
 * `never`. This is a typing convenience only: the merged deployment has
 * exactly one `vars` block (wrangler.jsonc's), and the cutover config change
 * must carry each shared var at a value every folded handler accepts.
 */
export type MergedWorkerEnv<Extra> = Extra & Omit<ApiWorkerEnv, keyof Extra>;
