// The action-sentence template implementation moved to @jsonbored/chain-summaries
// (#8525) -- the shared package both this app and workers/ import identically,
// so the sentence rendered on the site and the sentence served by the API can
// never drift. This re-export is a compatibility shim only (no logic of its
// own) preserving existing import sites in apps/ui/src/components and
// apps/ui/src/routes without touching them.
export {
  summarizeCall,
  summarizeEvent,
  summarizableCallKeys,
  summarizableEventKeys,
  type SummaryContext,
} from "@jsonbored/chain-summaries";
