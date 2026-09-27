/** Bridge existing cron fault-injection fixtures to the small D1 store port.
 * The real SQL and constraints are covered by generated-artifact-store.test.ts.
 */
export function generatedArtifactDb(
  store: unknown,
): Pick<D1Database, "prepare"> | undefined {
  const bucket = store as
    | {
        get?: (key: string) => Promise<{ json(): Promise<unknown> } | null>;
        put?: (key: string, value: string) => Promise<unknown>;
      }
    | undefined;
  if (!bucket?.get || !bucket.put) return undefined;
  return {
    prepare(sql: string) {
      return {
        bind(key: string, payload?: string) {
          return {
            async first() {
              if (sql.startsWith("SELECT")) {
                const value = await bucket.get!(key);
                return value
                  ? { payload: JSON.stringify(await value.json()) }
                  : null;
              }
              await bucket.put!(key, payload!);
              return { key };
            },
          };
        },
      };
    },
  } as unknown as Pick<D1Database, "prepare">;
}
