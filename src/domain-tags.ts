// Domain/capability tag vocabulary (issue #345). Worker-safe (pure string/regex,
// no node deps) so both the build (scripts/lib.ts re-exports this) and the
// Worker (src/contracts.mjs ?domain= enum) share one source of truth.
//
// Each tag has a ReDoS-safe keyword pattern (literal alternations + bounded \w*,
// no nested quantifiers, no /g so .test() stays stateless). A subnet may carry
// several tags. The OUTPUT is always drawn from this fixed vocabulary — never
// the raw input text — so feeding untrusted on-chain text in is safe (no value
// can escape into the tag set).
const DOMAIN_TAG_RULES: Array<[string, RegExp]> = [
  [
    "agents",
    /\b(agents?|agentic|autonomous (?:agents?|software)|tool[- ]?use|workflow automat\w*)\b/i,
  ],
  [
    "compute",
    /\b(gpu|cuda|compute (?:network|layer|subnet)|decentrali[sz]ed comput\w*|hpc|parallel comput\w*|distributed comput\w*|render(?:ing)? farm)\b/i,
  ],
  [
    "data",
    /\b(datasets?|data ?(?:scrap\w*|collect\w*|mining|pipeline|labe?l\w*)|web ?scrap\w*|crawl\w*)\b/i,
  ],
  [
    "finance",
    /\b(financ\w*|trading|defi|portfolio|hedge|liquidity|yield farming|price predict\w*)\b/i,
  ],
  [
    "inference",
    /\b(inference|llms?|large language models?|language models?|text[- ]generation|chatbots?|prompt(?:s|ing)?|completion(?:s)?)\b/i,
  ],
  [
    "media",
    /\b(images?|videos?|audio|music|voice|speech|text[- ]to[- ]speech|tts|avatars?|3d|computer vision)\b/i,
  ],
  [
    "prediction",
    /\b(predict\w*|forecast\w*|probabilist\w*|prediction markets?)\b/i,
  ],
  [
    "privacy",
    /\b(privacy|confidential comput\w*|zero[- ]?knowledge|zk[- ]?(?:proof|snark)\w*|homomorphic|anonymi[sz]\w*)\b/i,
  ],
  [
    "robotics",
    /\b(robot(?:ic|s|ics)?|drones?|embodied (?:ai|agent)|autonomous vehicles?)\b/i,
  ],
  [
    "science",
    /\b(protein|biolog\w*|medical|genom\w*|molecul\w*|drug discovery|scientif\w*|chemistry|physics|climate|weather)\b/i,
  ],
  [
    "search",
    /\b(search engine|semantic search|information retrieval|retrieval[- ]augmented|\brag\b|web search|indexing)\b/i,
  ],
  [
    "security",
    /\b(cyber ?security|deepfakes?|fraud|threats?|malware|vulnerab\w*|exploit\w*|phishing|anomaly detection)\b/i,
  ],
  [
    "storage",
    /\b(decentrali[sz]ed stora\w*|object stora\w*|file stora\w*|blob stora\w*|ipfs)\b/i,
  ],
  [
    "training",
    /\b(fine[- ]?tun\w*|pre[- ]?train\w*|model training|reinforcement learning|rlhf|distillation)\b/i,
  ],
];

// The controlled domain tag set, for the ?domain= enum + facet keys.
export const DOMAIN_TAGS = DOMAIN_TAG_RULES.map(([tag]) => tag).sort();
const DOMAIN_TAG_SET = new Set(DOMAIN_TAGS);

// Derive domain/capability tags from a subnet's on-chain identity text + curated
// categories (issue #345). Display/search-only — never feeds completeness (the
// #343 flywheel gate). Deterministic + idempotent so the build and the
// reproducibility validator never drift. Returns a sorted, de-duplicated array.
export function deriveDomainTags({
  description = null,
  additional = null,
  categories = [],
}: {
  description?: unknown;
  additional?: unknown;
  categories?: unknown;
} = {}): string[] {
  const text = [description, additional]
    .filter((value) => typeof value === "string")
    .join(" ");
  const tags = new Set<string>();
  if (text) {
    for (const [tag, re] of DOMAIN_TAG_RULES) {
      if (re.test(text)) tags.add(tag);
    }
  }
  // A curated category that is itself a domain tag counts as a derived tag too,
  // so curated subnets are not excluded from ?domain= results.
  for (const category of Array.isArray(categories) ? categories : []) {
    if (
      typeof category === "string" &&
      DOMAIN_TAG_SET.has(category.toLowerCase())
    ) {
      tags.add(category.toLowerCase());
    }
  }
  return [...tags].sort();
}
