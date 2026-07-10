/**
 * Shared loading/error/ready phase for compact KPI/stat cells that read from a
 * non-suspense `useQuery`. Lets a cell distinguish "still loading" (skeleton)
 * and "failed" (error indicator) from a legitimately-null value ("—"), instead
 * of collapsing all three into a bare dash. Used by the homepage KPI panels
 * (#3964) and the About "At a glance" sidebar (#3968).
 */
export type StatPhase = "pending" | "error" | "ready";

/** Derive a {@link StatPhase} from a query result's pending/error flags. */
export function statPhase(result: { isPending: boolean; isError: boolean }): StatPhase {
  if (result.isError) return "error";
  if (result.isPending) return "pending";
  return "ready";
}
