// AI-native search layer: semantic search + grounded `/ask` (RAG) over the
// registry, plus the embedding-sync cron that keeps the Vectorize index warm.
//
// Bindings (Workers AI `AI`, `VECTORIZE` index) are absent in CI/local, so every
// entry point degrades cleanly: the request handlers return `503 ai_unavailable`
// and the cron no-ops. Functions are env-injected and pure of I/O beyond the
// bindings, so they unit-test with stubs.
//
// Cost/abuse controls: a kill-switch (`METAGRAPH_ENABLE_AI`), an optional native
// rate-limit binding (`AI_RATE_LIMITER`), and hard caps on result/context size
// and question length.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768-dim
export const ASK_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const EMBED_MANIFEST_KEY = "ai:embed-manifest";

export const SEMANTIC_DEFAULT_LIMIT = 10;
export const SEMANTIC_MAX_LIMIT = 20;
export const ASK_CONTEXT_COUNT = 6;
export const ASK_MAX_QUESTION_LENGTH = 1000;
export const ASK_MAX_TOKENS = 512;
const EMBED_BATCH_SIZE = 100;
const VECTOR_ID_MAX_BYTES = 64;

const ASK_SYSTEM_PROMPT =
  "You are the metagraphed assistant. metagraphed is the operational + " +
  "integration registry for Bittensor subnets. Answer ONLY from the registry " +
  "context provided in the user message. Cite every claim with its bracketed " +
  "source number, e.g. [1]. If the context does not contain the answer, say so " +
  "plainly — never invent subnets, endpoints, or numbers. Be concise.";

// A user-input error: the request handlers translate it to a 400, not a 500.
export function aiInputError(message) {
  const error = new Error(message);
  error.aiInput = true;
  return error;
}

// The AI bindings exist (independent of the kill-switch). Used by the cron,
// which should run whenever the bindings are present.
export function aiConfigured(env) {
  return Boolean(env?.AI?.run && env?.VECTORIZE);
}

// AI request handling is permitted: bindings present AND the kill-switch is on.
export function aiEnabled(env) {
  return env?.METAGRAPH_ENABLE_AI === "true" && aiConfigured(env);
}

// Optional native Workers rate limiter. Absent in local/CI (and when the
// binding is not configured) -> allow. Never throws.
export async function withinRateLimit(env, key) {
  if (!env?.AI_RATE_LIMITER?.limit) return true;
  try {
    const outcome = await env.AI_RATE_LIMITER.limit({ key });
    return outcome?.success !== false;
  } catch {
    return true;
  }
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

// Stable, dependency-free 53-bit string hash (cyrb53) for change detection.
function contentHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function embeddingText(doc) {
  return [
    doc.title,
    doc.subtitle,
    ...(Array.isArray(doc.tokens) ? doc.tokens : []),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1500);
}

// Vectorize ids are capped at 64 bytes; long surface ids are folded to a stable
// hashed id. The real identity lives in metadata, so query results are unaffected.
export function vectorId(docId) {
  const id = String(docId);
  return id.length <= VECTOR_ID_MAX_BYTES ? id : `h:${contentHash(id)}`;
}

export function embeddingMetadata(doc) {
  return {
    type: doc.type ?? null,
    netuid: doc.netuid ?? null,
    slug: doc.slug ?? null,
    title: doc.title ?? null,
    subtitle: doc.subtitle ?? null,
    url: doc.url ?? null,
  };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function readManifest(env) {
  if (!env?.METAGRAPH_CONTROL?.get) return {};
  try {
    return (
      (await env.METAGRAPH_CONTROL.get(EMBED_MANIFEST_KEY, { type: "json" })) ||
      {}
    );
  } catch {
    return {};
  }
}

// Embedding-sync cron: diff the search index against a content-hash manifest in
// KV, (re)embed only the deltas, upsert to Vectorize, drop removed ids. Runs in
// the Worker runtime (CI has no AI bindings). `deps.readArtifact` is injected.
export async function runEmbeddingSync(env, deps = {}) {
  if (!aiConfigured(env)) return { ok: false, reason: "ai_unconfigured" };
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  const index = await deps.readArtifact(env, "/metagraph/search.json");
  if (!index?.ok) return { ok: false, reason: "search_index_unavailable" };

  const docs = Array.isArray(index.data?.documents) ? index.data.documents : [];
  const previous = await readManifest(env);
  const next = {};
  const pending = [];
  for (const doc of docs) {
    if (!doc?.id) continue;
    const id = vectorId(doc.id);
    const hash = contentHash(embeddingText(doc));
    next[id] = hash;
    if (previous[id] !== hash) pending.push({ id, doc });
  }
  const removed = Object.keys(previous).filter((id) => !(id in next));

  let embedded = 0;
  for (const batch of chunk(pending, EMBED_BATCH_SIZE)) {
    const response = await env.AI.run(EMBED_MODEL, {
      text: batch.map((entry) => embeddingText(entry.doc)),
    });
    const data = response?.data || [];
    const vectors = batch.map((entry, i) => ({
      id: entry.id,
      values: data[i],
      metadata: embeddingMetadata(entry.doc),
    }));
    await env.VECTORIZE.upsert(vectors);
    embedded += vectors.length;
  }
  if (removed.length && typeof env.VECTORIZE.deleteByIds === "function") {
    await env.VECTORIZE.deleteByIds(removed);
  }
  if (env?.METAGRAPH_CONTROL?.put) {
    await env.METAGRAPH_CONTROL.put(EMBED_MANIFEST_KEY, JSON.stringify(next));
  }
  return {
    ok: true,
    total: docs.length,
    embedded,
    removed: removed.length,
  };
}

async function embedQuery(env, text) {
  const response = await env.AI.run(EMBED_MODEL, { text: [text] });
  const vector = response?.data?.[0];
  if (!Array.isArray(vector)) {
    throw new Error("embedding model returned no vector");
  }
  return vector;
}

function mapMatch(match) {
  const metadata = match?.metadata || {};
  return {
    score: Math.round((match?.score ?? 0) * 1e4) / 1e4,
    type: metadata.type ?? null,
    netuid: metadata.netuid ?? null,
    slug: metadata.slug ?? null,
    title: metadata.title ?? null,
    subtitle: metadata.subtitle ?? null,
    url: metadata.url ?? null,
  };
}

// Semantic search: embed the query, query Vectorize, project metadata. Throws
// aiInputError for a blank query.
export async function semanticSearch(env, query, options = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw aiInputError("Query parameter `q` is required.");
  const limit = clampLimit(
    options.limit,
    SEMANTIC_DEFAULT_LIMIT,
    SEMANTIC_MAX_LIMIT,
  );
  const vector = await embedQuery(env, q);
  const result = await env.VECTORIZE.query(vector, {
    topK: limit,
    returnMetadata: "all",
    returnValues: false,
  });
  const results = (result?.matches || []).map(mapMatch);
  return { query: q, count: results.length, results, model: EMBED_MODEL };
}

// Grounded question answering (RAG): retrieve top-k registry context, prompt the
// LLM to answer only from it with bracketed citations.
export async function askQuestion(env, question, options = {}) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) throw aiInputError("Field `question` is required.");
  if (q.length > ASK_MAX_QUESTION_LENGTH) {
    throw aiInputError(
      `Field \`question\` must be at most ${ASK_MAX_QUESTION_LENGTH} characters.`,
    );
  }
  const topK = clampLimit(options.topK, ASK_CONTEXT_COUNT, ASK_CONTEXT_COUNT);
  const vector = await embedQuery(env, q);
  const result = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: "all",
    returnValues: false,
  });
  const matches = result?.matches || [];
  const citations = matches.map((match, i) => {
    const metadata = match?.metadata || {};
    return {
      ref: i + 1,
      title: metadata.title ?? null,
      netuid: metadata.netuid ?? null,
      slug: metadata.slug ?? null,
      url: metadata.url ?? null,
    };
  });
  const contextBlock = matches
    .map((match, i) => {
      const m = match?.metadata || {};
      const subject =
        m.netuid != null ? `${m.title} (subnet ${m.netuid})` : m.title;
      return `[${i + 1}] ${subject || "registry entry"}: ${m.subtitle || ""}`.trim();
    })
    .join("\n");

  const messages = [
    { role: "system", content: ASK_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Question: ${q}\n\nRegistry context:\n${contextBlock || "(no matching registry entries)"}\n\n` +
        "Answer using only the context above and cite sources as [n].",
    },
  ];
  const completion = await env.AI.run(ASK_MODEL, {
    messages,
    max_tokens: ASK_MAX_TOKENS,
  });
  const answer = (completion?.response || "").trim();
  return {
    question: q,
    answer,
    citations,
    context_count: matches.length,
    model: ASK_MODEL,
  };
}
