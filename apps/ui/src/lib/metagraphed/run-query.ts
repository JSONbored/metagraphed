import { QueryClient, type QueryFunctionContext, type QueryKey } from "@tanstack/react-query";

/**
 * Invoke a `queryOptions()` object's `queryFn` directly, without mounting a
 * provider.
 *
 * ## Why this is shared
 *
 * The same fifteen lines were copy-pasted into nine `queries.*.test.ts` files.
 * Every copy typed the `queryFn` option's context parameter as `never` and
 * then passed a context object into it — and since nothing is assignable to
 * `never`, every copy also needed an assertion on the argument. Each file had
 * written an assertion to satisfy a signature that same file had written.
 *
 * The `never` was doing a real job: letting one helper accept a `queryFn`
 * whatever its context type. `QueryFunctionContext<TKey>` does that job
 * properly, because `TKey` is inferred from the `queryKey` the caller already
 * hands over.
 *
 * ## What the assertion was hiding
 *
 * Asserting to `never` accepts every value, so the context these tests
 * supplied was never checked against the one TanStack Query actually passes.
 * It was missing `client`, which is REQUIRED and has been since v5 — a
 * `queryFn` that reads it (to seed a related key, or to read `defaultOptions`)
 * works in the app and gets `undefined` in every one of these tests. Building
 * the context against its real type is what surfaced that.
 */
export function runQuery<TKey extends QueryKey, TResult>(options: {
  queryKey: TKey;
  queryFn?: (context: QueryFunctionContext<TKey>) => TResult;
}): TResult {
  const { queryFn, queryKey } = options;
  if (!queryFn) {
    throw new Error("runQuery: these options carry no queryFn to invoke");
  }
  return queryFn({
    // A real client and a real controller, not stubs. A query function that
    // forwards `signal` into fetch needs a genuine AbortSignal, and a test
    // that hands it a fake is asserting cancellation against something that
    // could never cancel anything.
    client: new QueryClient(),
    signal: new AbortController().signal,
    queryKey,
    meta: undefined,
  });
}
