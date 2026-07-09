// Pure config for the subnet-detail route (`subnets.$netuid.tsx`): the tab bar
// definition and the section-anchor → owning-tab routing that drives cross-tab
// deep links (a `/subnets/N#section` hash resolves to the tab that owns the
// section and scrolls to it). Kept framework-free (no React) so the deep-link
// routing table can be unit tested — every section anchor must resolve to a
// real tab, or its hash link (including the panels' own "copy link" buttons)
// silently fails to switch tabs.

export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "metagraph", label: "Metagraph" },
  { id: "validators", label: "Validators" },
  { id: "activity", label: "Activity" },
  { id: "identity", label: "Identity history" },
  { id: "hyperparameters", label: "Hyperparameters" },
  { id: "services", label: "Callable services" },
  { id: "surfaces", label: "Surfaces" },
  { id: "endpoints", label: "Endpoints" },
  { id: "schemas", label: "Schemas" },
  { id: "candidates", label: "Candidates" },
  { id: "gaps", label: "Gaps" },
  { id: "evidence", label: "Evidence" },
  { id: "api", label: "API" },
] as const;

// Which tab does each section anchor live under? Drives cross-tab deep links.
export const SECTION_TO_TAB: Record<string, string> = {
  "endpoints-glance": "overview",
  "health-trends": "overview",
  incidents: "overview",
  economics: "overview",
  reliability: "overview",
  lineage: "overview",
  evidence: "overview",
  metagraph: "metagraph",
  neuron: "metagraph",
  concentration: "metagraph",
  yield: "metagraph",
  turnover: "metagraph",
  validators: "validators",
  activity: "activity",
  identity: "identity",
  hyperparameters: "hyperparameters",
  services: "services",
  "agent-readiness": "services",
  surfaces: "surfaces",
  endpoints: "endpoints",
  "schema-drift": "schemas",
  candidates: "candidates",
  gaps: "gaps",
  api: "api",
};
