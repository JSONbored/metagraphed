// Representative arguments exercise collections, falsy values, wide IDs and
// Unicode through the provider's own schemas and REST SDK. No live API traffic.
export const desearchCases = [
  {
    name: "ai-search",
    arguments: {
      prompt: "fixture 雪 + a",
      tools: ["web", "twitter"],
      date_filter: "PAST_24_HOURS",
      result_type: "LINKS_WITH_FINAL_SUMMARY",
      include_domains: ["example.com"],
      exclude_domains: ["excluded.example"],
    },
    method: "POST",
    path: "/desearch/ai/search",
  },
  {
    name: "x-search",
    arguments: {
      query: "fixture 雪 + a",
      count: 20,
      verified: false,
      min_likes: 0,
    },
    method: "GET",
    path: "/twitter",
  },
  {
    name: "web-search",
    arguments: { query: "fixture 雪 + a", start: 0 },
    method: "GET",
    path: "/web",
  },
  {
    name: "web-links-search",
    arguments: { prompt: "fixture 雪 + a", tools: ["web"], count: 20 },
    method: "POST",
    path: "/desearch/ai/search/links/web",
  },
  {
    name: "x-links-search",
    arguments: { prompt: "fixture 雪 + a", count: 20 },
    method: "POST",
    path: "/desearch/ai/search/links/twitter",
  },
  {
    name: "x-posts-by-urls",
    arguments: {
      urls: [
        "https://x.com/fixture/status/18446744073709551615",
        "https://x.com/fixture/status/18446744073709551614",
      ],
    },
    method: "GET",
    path: "/twitter/urls",
  },
  {
    name: "x-post-by-id",
    arguments: { id: "18446744073709551615" },
    method: "GET",
    path: "/twitter/post",
  },
  {
    name: "x-posts-by-user",
    arguments: { user: "fixture", query: "雪 + a", count: 20 },
    method: "GET",
    path: "/twitter/post/user",
  },
  {
    name: "x-post-retweeters",
    arguments: { id: "18446744073709551615", cursor: "cursor + / =" },
    method: "GET",
    path: "/twitter/post/retweeters",
  },
  {
    name: "x-user-posts",
    arguments: { username: "fixture", cursor: "cursor + / =" },
    method: "GET",
    path: "/twitter/user/posts",
  },
  {
    name: "x-user-replies",
    arguments: { user: "fixture", query: "雪 + a", count: 20 },
    method: "GET",
    path: "/twitter/replies",
  },
  {
    name: "x-post-replies",
    arguments: { post_id: "18446744073709551615", query: "雪 + a", count: 20 },
    method: "GET",
    path: "/twitter/replies/post",
  },
  {
    name: "extract",
    arguments: {
      url: "https://example.com/guide?a=1&b=雪",
      format: "text",
      js: false,
      wait: 0,
    },
    method: "GET",
    path: "/web/extract",
  },
  {
    name: "web-crawl",
    arguments: { url: "https://example.com/guide?a=1&b=雪", format: "html" },
    method: "GET",
    path: "/web/crawl",
  },
  {
    name: "x-trends",
    arguments: { woeid: 23424977, count: 30 },
    method: "GET",
    path: "/twitter/trends",
  },
] as const;

export const desearchJsonResult = {
  results: [{ id: "18446744073709551615", url: "https://example.com/fixture" }],
  exact: "raw 雪\nfixture",
};
export const desearchTextResult = "raw 雪\nfixture <html>bytes</html>";
