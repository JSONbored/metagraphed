// Contract validator for the AI routes (GET /api/v1/search/semantic, POST
// /api/v1/ask). These are out-of-contract dynamic routes (like /api/v1/events),
// so they are validated here rather than through validate-api's
// `checks.length === API_ROUTES.length` invariant.
//
// Two passes: (1) bindings absent -> 503 ai_unavailable; (2) stubbed AI +
// Vectorize bindings + kill-switch on -> 200 with a payload that matches the
// standalone AI response schemas, plus the input/rate-limit negative paths.
import assert from "node:assert/strict";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { handleRequest } from "../workers/api.mjs";
import { EMBED_MODEL } from "../src/ai-search.ts";
import { createLocalArtifactEnv, readJson, repoRoot } from "./lib.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const semanticSchema = ajv.compile(
  await readJson(path.join(repoRoot, "schemas/ai/semantic-search.schema.json")),
);
const askSchema = ajv.compile(
  await readJson(path.join(repoRoot, "schemas/ai/ask-answer.schema.json")),
);

const SEMANTIC_URL = "https://api.metagraph.sh/api/v1/search/semantic";
const ASK_URL = "https://api.metagraph.sh/api/v1/ask";

function get(url, env) {
  return handleRequest(new Request(url), env, {});
}
function post(url, body, env, headers = {}) {
  return handleRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    {},
  );
}

// --- Pass 1: AI disabled (no bindings) -> 503 ------------------------------

const coldEnv = createLocalArtifactEnv();
const coldSemantic = await get(`${SEMANTIC_URL}?q=image`, coldEnv);
assert.equal(
  coldSemantic.status,
  503,
  "semantic must 503 when AI is unconfigured",
);
assert.equal(
  (await coldSemantic.json()).error.code,
  "ai_unavailable",
  "semantic must report ai_unavailable when disabled",
);
const coldAsk = await post(
  ASK_URL,
  { question: "what subnets do images?" },
  coldEnv,
);
assert.equal(coldAsk.status, 503, "ask must 503 when AI is unconfigured");
assert.equal((await coldAsk.json()).error.code, "ai_unavailable");

// --- Stub AI + Vectorize bindings ------------------------------------------

function stubMatch(i) {
  return {
    id: `subnet:${i}`,
    score: 0.9 - i * 0.1,
    metadata: {
      type: "subnet",
      netuid: i,
      slug: `sn-${i}`,
      title: `Subnet ${i}`,
      subtitle: `Subnet ${i} summary`,
      url: `https://api.metagraph.sh/api/v1/subnets/${i}/overview`,
    },
  };
}

function makeAiEnv(overrides = {}) {
  return {
    ...createLocalArtifactEnv(),
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      run(model, input) {
        if (model === EMBED_MODEL) {
          const n = Array.isArray(input.text) ? input.text.length : 1;
          return Promise.resolve({
            data: Array.from({ length: n }, () => new Array(1024).fill(0.01)),
          });
        }
        return Promise.resolve({ response: "Subnet 1 serves images [1]." });
      },
    },
    VECTORIZE: {
      query(_vector, options) {
        const topK = options?.topK ?? 3;
        return Promise.resolve({
          matches: Array.from({ length: Math.min(topK, 3) }, (_, i) =>
            stubMatch(i + 1),
          ),
        });
      },
    },
    ...overrides,
  };
}

// --- Pass 2: enabled -> 200 + schema ---------------------------------------

const aiEnv = makeAiEnv();

const semantic = await get(
  `${SEMANTIC_URL}?q=image%20generation&limit=5`,
  aiEnv,
);
assert.equal(semantic.status, 200, "enabled semantic must return 200");
const semanticBody = await semantic.json();
assert.equal(semanticBody.ok, true);
assert.equal(
  semanticSchema(semanticBody.data),
  true,
  `semantic data must match schema: ${ajv.errorsText(semanticSchema.errors)}`,
);
assert.ok(semanticBody.data.results.length > 0, "semantic must return results");

const ask = await post(
  ASK_URL,
  { question: "Which subnet does image generation?" },
  aiEnv,
);
assert.equal(ask.status, 200, "enabled ask must return 200");
const askBody = await ask.json();
assert.equal(askBody.ok, true);
assert.equal(
  askSchema(askBody.data),
  true,
  `ask data must match schema: ${ajv.errorsText(askSchema.errors)}`,
);
assert.ok(askBody.data.citations.length > 0, "ask must return citations");

// --- Negative paths --------------------------------------------------------

const noQuery = await get(SEMANTIC_URL, aiEnv);
assert.equal(noQuery.status, 400, "semantic without q must be 400");
assert.equal((await noQuery.json()).error.code, "invalid_query");

const emptyQuestion = await post(ASK_URL, { question: "  " }, aiEnv);
assert.equal(emptyQuestion.status, 400, "ask with blank question must be 400");

const badJson = await post(ASK_URL, "{not json", aiEnv);
assert.equal(badJson.status, 400, "ask with invalid JSON must be 400");
assert.equal((await badJson.json()).error.code, "invalid_json");

const askViaGet = await get(ASK_URL, aiEnv);
assert.equal(askViaGet.status, 405, "GET /api/v1/ask must be 405");

// Rate limiting: a limiter that denies -> 429.
const limitedEnv = makeAiEnv({
  AI_RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
});
const limited = await get(`${SEMANTIC_URL}?q=image`, limitedEnv);
assert.equal(limited.status, 429, "rate-limited semantic must be 429");
assert.equal((await limited.json()).error.code, "rate_limited");

console.log(
  "AI route validation passed: disabled->503, enabled->200 (schema-valid), negatives + rate-limit.",
);
