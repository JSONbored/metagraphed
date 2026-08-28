# Sitewide UX/UI and performance audit

**Status:** route map complete in source; local visual, interaction, responsive, and design-token
checks are rerun as each redesign slice changes. This is a delivery map for the redesign, not a
claim that the deployed site has changed.

## Product and visual contract

**Audience:** people exploring Bittensor and builders connecting an agent to it.

**Primary job:** let a reader move from a network-level question to trustworthy evidence without
having to decipher a dashboard. The homepage must make the two products equally clear: a Bittensor
block explorer and the Metagraphed MCP server, the single connection point for the registry's
subnets.

**Visual direction:** Metagraphed's own mint-on-graphite/paper system, used with a calm editorial
shell. Data gets a clear reading order, hairline structure, stable semantic colour, and details on
demand. External design research informs the information hierarchy only; the product retains its
own copy, assets, interaction language, and Bittensor-specific purpose.

**Mobile rule:** do not shrink a desktop table until it technically fits. A phone gets one identity
line, a compact two-column evidence grid, a deliberate scroll affordance for long lists, and a
tap target on the entity it shows first.

## Direction correction

The first redesign pass improved consistency faster than it improved the product experience. It
over-applied the same good ingredients -- metadata chip, fact cards, section tabs, explanatory
heading, then a component -- to pages with very different jobs. The result is orderly but too
uniform: the landing page can read like a component catalogue, directories can feel too editorial,
and an entity page can fail to make its decisive evidence feel decisive.

The next pass is therefore **archetype-first, not primitive-first**:

1. **Landing:** one memorable product moment, then two unmistakable doors: investigate the live
   network or give an agent the network through Metagraphed MCP. Live visual evidence must support
   the proposition rather than become a second dashboard beside it.
2. **Explorer directories:** dense, fast, and utilitarian. Search, sorting, filters, and a clear
   leading identity matter more than decorative narrative. A phone shows the entity and the one
   decision-critical reading first; it does not turn every table cell into an equally loud card.
3. **Entity and analytic pages:** identity and the one question a reader came to answer lead the
   page. Give the most important graph, ledger, or state reading enough scale to be understood
   before secondary facts, provenance, and raw identifiers.
4. **Support and documentation:** quiet reading surfaces. They should inherit the system's
   typography and controls without pretending to be dashboards.

Every future visual change is assessed at 375px, 768px, and desktop against its route archetype:
first useful answer visible without arbitrary scrolling, one clear primary action, intentional
information density, real data rather than decorative fixtures, and no leftover desktop composition
that merely happens to fit on a phone.

### Explorer hierarchy refinement — August 27

The explorer needs a stronger hierarchy than a collection of attractive components. The system-wide
rules for the next implementation pass are:

1. **Global, contextual, then local navigation:** the shared shell names the product modes. A
   directory or entity may add one compact context rail for its own records and views. A breadcrumb
   appears only when it helps a reader return through a real hierarchy; no route gets a second
   generic navigation band just to look product-like.
2. **Directories are instruments:** use at most four genuinely useful summary readings, then place
   query controls immediately above a dense, stable directory. Each row has a clear identity, one
   primary comparison, any real directional change, and a truthfully scoped state. Optional columns
   belong in progressive disclosure, not in a permanently sprawling desktop table.
3. **Visual encoding must carry data:** a rail, band, sparkline, or colour can appear inside a row
   only when it represents a real ratio, distribution, or change. Its precise value remains visible
   in text, its scale is stated, and the same state is available without colour or hover.
4. **Details read as a ledger before they read as a dashboard:** identify the entity, put its live
   state and freshness beside it, then show only the few decision-critical facts in a ruled band.
   The primary graph or activity record gets the next visual priority; provenance, raw identifiers,
   and exhaustive history remain easy to reach without competing with the first answer.
5. **Analytics pair a visual with evidence:** a large chart or network view needs a nearby ranked
   list, table, or focused reading that explains the currently selected datum. A graph is never
   ambient wallpaper. It must expose real values through hover, keyboard focus, and touch, with a
   stable mobile alternative.
6. **Responsive order follows the task:** phone layouts preserve identity, current state, primary
   comparison, and action before secondary metadata. Context rails can scroll intentionally; tables
   can become a two-column evidence card only when that retains the comparison. No opaque column
   deletion, masonry card wall, or scaled-down desktop chart is acceptable.

These rules deliberately favor a fast, durable information surface over background art, stock
promotional modules, or a visually loud metric-card dashboard.

### Homepage corrective contract — August 27

The prior homepage composition is rejected. Its split intro/atlas, numbered product doors, boxed
grid, and atmospheric colour fade read as a generic product landing page rather than a confident
data product. The replacement follows the references' _information hierarchy_, not their branding:

- **Question:** How can a human or agent immediately get trustworthy Bittensor data?
- **Archetype:** an editorial data index—one large thesis, one actual network reading, then a
  compact access line for search, explorer, and MCP.
- **Signature:** a quiet, bounded dot field plus a real, categorical emission reading. The data
  itself supplies colour; the page does not use glow, a soft colour wash, glass, or gradients for
  atmosphere.
- **MCP role:** the `/mcp/core` connection is a first-class access path in the hero, expressed as
  a compact product instrument rather than a promotional card. It retains the truthful promise:
  one agent connection to the registry's Bittensor subnet data.
- **Proof:** render the rebuilt top at 1280×800, 768×1024, and 375×812 in light and dark; then
  inspect search, links, copy/focus controls, the emission visual, and the MCP handoff.

### Block explorer live-data contract — August 27

The homepage and block detail route now share one explorer promise: a reader can see the latest
indexed chain activity, choose a specific block, and reach its decisive evidence without waiting
for secondary forensic data.

- **Homepage rail:** a bounded, newest-first set of real indexed blocks sits _inside the same hero
  instrument_, directly below the emission reading. Every tile names the exact block number,
  extrinsic count, and event count, links to the block detail route, and uses a relative extrinsic
  mark only as a supplemental visual comparison. The rail is explicitly user-scrollable and
  touch-scrollable; it never auto-scrolls.
- **Arrival motion:** a finite colour/rule cue runs only when an already-rendered rail observes a
  genuinely newer indexed head. Initial load, repeated polls, and a lower/reorg-shaped head do not
  animate. The cue is removed under reduced-motion preferences, and neither the rail nor its
  updates use an interrupting live-region announcement.
- **Block detail:** header and primary extrinsics remain the first load. The complete decoded event
  stream and local cadence line are an explicit technical-record disclosure because their payloads
  are secondary to most lookups. Failures render an error with retry; they never claim an empty
  block, extrinsic, or event stream merely because a data request failed.
- **Intent prefetch:** a sustained mouse hover or keyboard focus on one block link warms that
  block's compact identity record and primary extrinsics ledger. The hover dwell prevents a live
  rail or directory table from becoming a request fan-out; decoded events and cadence still wait
  for the explicit technical-record action.
- **Known-empty detail:** an exact zero count in the block header is decisive. The page renders the
  corresponding empty table without a redundant detail request; unknown counts still fetch rather
  than being treated as zero.
- **Cadence boundary:** a centred block window requests 99 rows, not an invalid 101 rows, so it
  remains inside the public blocks-feed limit while retaining a true centre block.
- **Heatmap gate:** the current activity data is daily aggregate data plus a bounded recent-block
  feed. It cannot truthfully support a historical per-block or interval heatmap. Add that visual
  only after a server response supplies bounded bins with start/end, count, source, and freshness;
  pair it with text, keyboard, and touch alternatives so colour and hover are not the only way to
  read a period.
- **Current technical reading:** `/chain/blocks` now turns its actual result page into a bounded
  block-activity matrix. It is explicitly labelled as latest indexed or current filtered results,
  orders real blocks newest-first, exposes exact extrinsic/event counts in a persistent reading and
  the underlying table, and links each mark to its detail page. Mint intensity is a disclosed
  relative square-root comparison—not a fabricated timestamp bucket or a substitute for a count.
- **Paged directory truth:** a full blocks or extrinsics page establishes that a subsequent page
  _may_ exist; it does not establish a total result count. The directory therefore retains its
  Next affordance and reports only the exact visible range until the API publishes an authoritative
  total. It must never turn the page size into an apparent result total.
- **Touch inspection:** the activity marks have no persistent per-mark labels, so the first touch
  selects a mark and updates its exact reading; a second touch opens that block. Pointer hover and
  keyboard focus keep the same reading in sync, while keyboard or assistive activation opens the
  link directly. This preserves exploration without turning the visual into a non-interactive map.
- **Arrival motion:** the unfiltered first page establishes a baseline, then only a strictly newer
  indexed head creates an arrival. The matrix repositions atomically and the new upper-left mark
  receives a finite rule cue and an assistive announcement; moving all 50 marks through a
  two-dimensional grid would create misleading gaps at row boundaries. Repeated polls, reorgs,
  filters, and pagination establish a quiet baseline instead; reduced-motion readers receive the new
  data without animation.
- **Proof:** verify the rail and technical disclosure at 1280×800, 768×1024, and 375×812 in both
  themes, including empty/error/arrival/keyboard/touch/reduced-motion states. Record a cold-route
  request count and transfer measurement after deployment before claiming a live performance win.

### Block-detail latency investigation boundary — August 27

The browser route no longer creates a known-invalid cadence request or eagerly asks for decoded
events before a reader needs them. That is a client request-shape correction, not a claim that the
underlying current-head data path is fast: observed current-head reads can still wait on the tiered
extrinsics or decoded-events paths, and the latter can correctly surface a transient unavailable
response rather than fabricated empty data.

- **Observed branch (one read-only live sample, not an SLO):** at 10:26 UTC a header for
  `#8,935,799` answered in about 0.35 seconds. Its extrinsics request reached the typed 503 in
  about 1.15 seconds (`r2sql` about 0.78 seconds), while decoded chain events took about 15.22
  seconds (`r2sql` about 14.83 seconds). The response itself established a coverage gap rather
  than an empty block: the decoded seam was `#8,923,155` and the live-follow window ended at
  `#8,935,797`/`#8,935,798` as the live lane advanced during the sample. A settled block roughly
  six thousand heights behind had previously answered those detail reads in about 0.33 and 0.35
  seconds. The slow work is therefore in the current-head detail path, not in the homepage rail or
  block-page chrome.
- **Server correction:** for an uncovered numeric block, the common detail router now reads the
  already-memoized decoder watermark's per-table ceiling. When that exact cold table has never
  decoded as far as the requested block, it returns the existing retryable coverage-gap response
  without issuing a lakehouse query guaranteed to miss. The ceiling is only negative evidence;
  absent diagnostics, a table that reaches the block, hash lookups outside the hot register, and
  every settled-history read retain the full cold lookup. This applies consistently to extrinsics,
  account events, raw chain events, and composite extrinsic detail.
- **Do next:** capture a matched recent, settled, and tier-gap trace with cache status, branch
  decision, upstream timing, payload size, and client pending time separately. Include the direct
  block, extrinsics, decoded-events, and centred-window requests.
- **Do not do:** broaden settled-history edge caching onto current-head data without an explicit
  freshness policy; the route deliberately distinguishes mutable hot answers from settled cold
  answers. Do not substitute an empty table for an unavailable tier.
- **Remaining server work:** re-measure the known-gap branch after deployment, then improve the
  live-follow lane's coverage rather than caching a mutable absence. Add bounded branch/timing
  observability if the post-deploy trace still leaves an unexplained wait; the browser should not
  become a synthetic monitoring probe.

## Audit evidence and boundaries

- The generated router currently exposes **63 normalized paths**. Every one is classified below as
  a canonical visual route, redirect-only alias, or machine-readable response.
- The existing deterministic browser suite samples 34 canonical visual route instances, including
  two materially different subnet details, entity details, content, API pages, and GraphQL. It
  checks 375, 768, 1024, and 1280px layouts against fixture data.
- A local visual pass rendered all 34 canonical route instances at desktop and 375px in dark
  mode. A current re-pass captured the same canonical set at 768px/light and 375px/dark, with
  focused before/after captures for the homepage and MCP surface at 375, 768, and 1280px in both
  themes. Together with the deterministic overflow checks below, this found no page-level
  horizontal overflow, unexpected error state, or missing page identity. It is a structural and
  hierarchy floor—not a visual-quality verdict or a deployed freshness review.
- The rebuilt local Worker passed the latest full deterministic browser suite: **575 checks**
  covering responsive overflow, route/redirect correctness, chart and keyboard interactions,
  deep links, payload ratchets, and the route-by-theme-by-viewport token inventory. That verifies
  this source slice; it does not substitute for a deployed performance measurement or a fresh-data
  review.
- The final source gate also passed **2,297 UI unit tests**, **181 UI-kit tests**, and the
  repository-wide **22,382-test** suite. The focused realtime-chain pass verified the newer-block
  arrival cue plus phone inspection, pending, and unavailable states; these are deterministic
  behavioral checks, not a claim about a production websocket or polling connection.
- The Open Graph renderer separately produced and reviewed the homepage, entity, product, and
  long-title card variants through the same Satori/resvg pipeline used by the Worker. The source
  test rejects generated gradient markup; this is a visual-policy check, not a production social
  preview cache validation.
- A cold local browser pass against that Worker (new browser context, 1280px)
  recorded 313,348 B across six CSS/JavaScript assets for `/`, 316,744 B across eight for
  `/subnets`, and 310,913 B across six for `/agents`. The maintenance-only GraphQL route recorded 778,458 B
  across 40 assets; its route-specific assets were absent from the other three paths. These are
  local `PerformanceResourceTiming` transfer readings—not a claim about CDN compression, mobile
  radio conditions, Core Web Vitals, or the deployed site.
- A route sweep across **33 non-GraphQL visual routes** compared the currently deployed build with
  this source Worker while both read the public API. At the phone viewport, deployed medians were
  379ms TTFB, 656ms LCP, and 560KB transferred; the current source medians were 61ms TTFB, 144ms
  LCP, and 364KB transferred. Source p95 values were 954ms TTFB, 1,012ms LCP, and 634KB transferred,
  with no route failure or page-level overflow. Desktop source medians were 43ms TTFB and 92ms LCP;
  p95 CLS was 0.055. These are controlled synthetic comparisons from one run, not field Core Web
  Vitals or evidence that the source changes are deployed.
- Dynamic examples are deliberately representative rather than fabricated: `/subnets/1` and
  `/subnets/19`, a high-membership validator, an account, a provider with many endpoints, a fixed
  block, and a fixed extrinsic exercise materially different data shapes.
- All findings below are source/local evidence. Production freshness, Core Web Vitals, and live
  data correctness require a separately verified deployment review.

## Route map

### Canonical visual routes (30)

| Family                 | Routes                                                                                                                | Primary question                                              | Current design focus                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing                | `/`                                                                                                                   | What is Metagraphed and where do I start?                     | Keep the concise "Bittensor, measured." thesis; make Explorer and MCP equally actionable; preserve the visual data field without making it decorative.                                  |
| Explorer directories   | `/subnets`, `/validators`, `/accounts`                                                                                | Which entity should I inspect?                                | Ranked, filterable scan path; mobile identity-led cards; retain full SSR links and fields.                                                                                              |
| Entity details         | `/subnets/$netuid`, `/validators/$hotkey`, `/accounts/$ss58`, `/providers/$slug`, `/blocks/$ref`, `/extrinsics/$hash` | What is true about this particular entity?                    | Identity and state first, evidence/secondary data below, raw identifiers copyable, truthfully scoped empty and stale states.                                                            |
| Comparison             | `/compare`                                                                                                            | How do selected subnets differ?                               | Preserve a labelled comparison ledger on narrow screens; eliminate duplicate controls and make selection state obvious.                                                                 |
| Chain data story       | `/chain`, `/chain/blocks`, `/chain/events`, `/chain/extrinsics`                                                       | What is happening on chain?                                   | A short reading lens, then an ordered visual/data sequence; keep small-screen charts operable rather than compressed.                                                                   |
| API/data hub           | `/apis`, `/apis/endpoints`, `/apis/providers`, `/apis/schemas`                                                        | What can I connect to and who operates it?                    | Explain coverage and provenance before the raw directory; filter/sort controls must remain readable and shareable.                                                                      |
| Product and trust      | `/agents`, `/health`, `/contribute`, `/settings`                                                                      | How do I connect, assess health, or configure the experience? | Give MCP connection instructions a single obvious path; distinguish observed health from claims; make settings immediately legible.                                                     |
| Documentation and news | `/docs/$`, `/news/$`                                                                                                  | How do I learn the system or read an update?                  | Maintain prose measure, clear source metadata, useful navigation, and accessible code/data examples.                                                                                    |
| Static/supporting      | `/about`, `/privacy`, `/terms`, `/design/primitives`, `/graphql/explorer`                                             | What is the product contract or supporting tool?              | Keep reading-focused pages quiet. GraphQL is maintenance-only while [#11726](https://github.com/JSONbored/metagraphed/issues/11726) inventories and retires the unused product surface. |

### Redirect-only aliases (28)

`/admin-changes`, `/blocks`, `/chain/analytics`, `/chain/emissions`, `/chain/governance`,
`/chain/runtime`, `/design`, `/domains`, `/endpoints`, `/events`, `/explorer`, `/extrinsics`,
`/gaps`, `/graphql`, `/leaderboards`, `/portfolio`, `/providers`, `/revenue`, `/runtime`,
`/schemas`, `/status`, `/subnets/category`, `/subnets/category/$slug`, `/subnets/with-api`,
`/sudo`, `/surfaces`, `/tools`, `/tools/ss58`.

These need redirect correctness and a sensible canonical destination, not a second visual design.
The route coverage test prevents them from being mistakenly counted as separate visual pages.

### Machine-readable routes (5)

`/api/search`, `/docs/llms.txt`, `/docs/raw/$`, `/news/llms.txt`, `/news/raw/$`.

These are audited for contract, accessibility of their linked visual counterpart, and correctness of
their plain-text/JSON response—not for page chrome.

## Findings addressed in this workspace

| Finding                                                                                                                                                   | Why it harmed the experience                                                                                                                                                                                 | Shared source-level correction                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone pages inherited both shell and section gutters, plus a large hero top gap.                                                                          | The first useful chart or directory began too far below the fold.                                                                                                                                            | The mobile shell now owns one 16px gutter; entity heroes use compact, deliberate vertical rhythm.                                                                                                                                                                                                                                                     |
| The desktop shell added a second vertical step on top of each route hero.                                                                                 | Explorer, comparison, and live-state pages spent desktop space before their first useful reading even though their own hero already provides intentional breathing room.                                     | Standard routes now share the tablet's 32px top rhythm; full-bleed documentation remains independently laid out.                                                                                                                                                                                                                                      |
| Explorer directories reused the spacious entity-detail hero and delayed the first result.                                                                 | A reader who arrived to find a subnet, validator, account, or API had to move through too much summary chrome before reaching a row.                                                                         | Directory heroes now have a compact, route-specific rhythm so search and the first ranked result arrive in the initial viewport without losing the identity or current readings.                                                                                                                                                                      |
| Chain stream routes kept a full profile-style masthead above their live tables.                                                                           | A reader looking up a block, event, or extrinsic had to pass a large summary panel before the primary record list.                                                                                           | The shared stream shell now uses the compact directory masthead and a shorter, intentional handoff to its first table.                                                                                                                                                                                                                                |
| Contribute and Settings inherited dashboard-sized empty space despite being a work queue and a local form.                                                | Their first actionable control was visually delayed, and Settings' three compact choices stretched across the whole desktop content column.                                                                  | Contribute now inherits the directory rhythm for its ranked queue; Settings uses a narrower form composition with the preference question beside its controls.                                                                                                                                                                                        |
| Entity details rendered every current reading as an equally prominent card before the first analytic visual.                                              | The answer a reader came for—momentum, activity, ownership, or a chain event—felt less important than generic summary chrome.                                                                                | Detail heroes now use a ruled metric ledger: all figures remain visible and comparable, but the primary analytic reading gets the visual room to lead.                                                                                                                                                                                                |
| Chain and Health inherited the same equal-weight metric cards despite being live operational views.                                                       | The reader had to parse every KPI before reaching the throughput composition or the current incidents answer, obscuring the state that matters most.                                                         | Operational heroes now use a ruled reading band. Health leads with the current probe-derived failed count and explicitly separates it from recorded incident events, while Chain gives its current head reading hierarchy and places its first visual beside the operational question on desktop.                                                     |
| The homepage called an indexed economic snapshot "current" while also exposing its update age.                                                            | If a source is delayed, the label implies a freshness guarantee the registry has not defined.                                                                                                                | The homepage now says "latest indexed" and "latest daily emission." It retains the exact relative update age; a "stale" verdict remains deferred until source owners define cadence and grace period.                                                                                                                                                 |
| Three-to-six hero facts created orphaned cards or a partially clipped metric rail.                                                                        | A reader could not scan the whole current reading without either parsing an uneven grid or discovering a horizontal swipe.                                                                                   | Phone facts use a balanced two-column panel, with the final fact spanning both columns for odd counts; four-tablet-fact panels use an intentional two-by-two grid.                                                                                                                                                                                    |
| Long in-page navigation showed a bright native horizontal scrollbar.                                                                                      | It looked like an uncontrolled browser artifact, particularly in dark mode.                                                                                                                                  | The scroll target moved inside the sticky wrapper; compact ruled directional cues indicate more sections while focused links still scroll into view.                                                                                                                                                                                                  |
| Compact refresh, glossary, ranking expansion, and return controls painted below a thumb-sized target.                                                     | Dense visual treatment became difficult to use on a phone even when the action itself was important.                                                                                                         | Those shared controls now inherit the same invisible 44px coarse-pointer hit area as table, pager, range, and navigation controls, while their painted data density remains unchanged.                                                                                                                                                                |
| Long mobile tables made every field a vertical label/value row.                                                                                           | A subnet or validator list became a dense wall of repeated labels and only two rows fit in view.                                                                                                             | Card tables now promote one identity line and lay the remaining fields out in a two-column evidence grid. A route can nominate a readable identity such as subnet name without disturbing desktop column order.                                                                                                                                       |
| Bounded data lists used an unthemed native vertical scrollbar.                                                                                            | The white rail competed with actual data in the dark explorer.                                                                                                                                               | Long-table scrollbars are now narrow and use the design system's rule token, retaining an honest cue that more records exist.                                                                                                                                                                                                                         |
| A wide time-composition chart used a soft edge fade to imply horizontal history.                                                                          | The fade obscured the first or last datum and made the overflow cue look decorative rather than functional.                                                                                                  | Chart scrolling now reports its real boundary state, offers a focusable horizontal viewport, and shows a compact ruled directional cue only toward unseen history.                                                                                                                                                                                    |
| A shared composition bar treated percentage widths and inter-segment gaps as separate fixed geometry.                                                     | Its final segment could be visibly clipped despite the data adding to 100%, which undermines trust in an otherwise simple data visual.                                                                       | Segment shares now act as relative flex weights, so the actual available bar width is divided after gaps while preserving the inspectable percentage.                                                                                                                                                                                                 |
| Featured leaderboards used card-like profile tiles and oversized initials.                                                                                | A clipped next card on phones and ornamental watermark on wide screens read as promotion rather than a usable ranking.                                                                                       | Leaderboards now use a ruled rank, identity, and value grid at every width; phone preserves each complete row, and tablet uses a deliberate equal-width comparison grid.                                                                                                                                                                              |
| The provider index placed its complete 18-row endpoint ranking before the searchable directory.                                                           | On phones the secondary ranking became a long wall that buried the route's primary lookup and verification task; desktop readers also had to pass exhaustive context before reaching the directory.          | The provider ranking now presents the three leading operators at rest and exposes the complete ranking through an explicit disclosure. Every provider link remains in the server-rendered directory, so progressive disclosure does not reduce crawlability or evidence access.                                                                       |
| Comparison explained a zero- or one-item state as if a side-by-side analysis were already available.                                                      | The next action was unclear and a partial selection looked broken rather than incomplete.                                                                                                                    | Copy distinguishes empty, one-selected, and ready states, and incomplete states link directly to the appropriate explorer directory.                                                                                                                                                                                                                  |
| New route variants had begun to introduce one-off type sizes and letter spacing.                                                                          | A nominally shared system could look inconsistent at a breakpoint, and the token guard could no longer distinguish intentional hierarchy from visual drift.                                                  | The shared stylesheet now expresses the variants with the existing type scale, weight, measure, and layout rather than ungoverned values; the full route-by-theme-by-viewport token inventory passes again.                                                                                                                                           |
| Revenue reference material suggested annual estimates/confidence labels before the registry has evidence for them.                                        | Displaying an estimate, confidence, or "revenue-funded" conclusion without a defined method would make the explorer less trustworthy.                                                                        | Revenue UI stays evidence-led: observed amount/period/source/coverage only. A future estimation model must first define method, interval, provenance, freshness, and explicitly distinguish observation from projection.                                                                                                                              |
| Revenue evidence rendered as an eighth peer in a subnet's main in-page navigation.                                                                        | It split one economic question into two destinations and made the detail route's reading order feel longer than the underlying information architecture.                                                     | Revenue remains independently deep-linkable at `#revenue`, but now sits as evidence within the **Value flow** analytic section where the reader has the needed emission context.                                                                                                                                                                      |
| A cold subnet detail mounted every secondary analytic read together with its first-screen evidence.                                                       | Surfaces, event activity, participation, peers, and closed raw ownership history competed with the hero and momentum requests even when a reader never reached them.                                         | Each below-fold section now keeps its stable anchor, question, explicit deferred state, structured loading state, error, and retry, while its request begins only as that visual region approaches. Ownership history waits until the raw disclosure is opened and reached.                                                                           |
| A cold account detail mounted secondary transfer, activity, and key-relationship reads together with the portfolio evidence.                              | An account reader's first scan is identity, holdings, and recent stake flow; an unvisited counterparty rail, first events page, and delegation graph should not compete with those reads.                    | Counterparties, activity, and keys retain their anchors and explicit deferred/loading/error states, but start only as their visual region approaches. The always-needed subnet directory projection is narrowed to account display names.                                                                                                             |
| Account detail suspended the whole server-rendered route on a general-purpose history summary.                                                            | One multi-second aggregate prevented the address, balance, identity and portfolio from painting even though those evidence lanes are independent; a transient summary failure also collapsed the whole page. | The summary now has a non-suspending pending/unavailable state. The HTML shell and independent first-screen evidence render immediately, while history fills in asynchronously and remains refreshable without fabricating zero events.                                                                                                               |
| The full subnet directory probed website favicons and repository avatars for every row without a curated icon.                                            | A single directory view could fan out dozens of doomed proxy requests before reaching the same monogram fallback, wasting transfer and visual-settle time.                                                   | Directory rows load only registry-curated icons and fall directly to deterministic monograms. Detail pages keep the richer single-entity fallback ladder, where it cannot multiply across the complete registry.                                                                                                                                      |
| Block detail stopped after one 100-row extrinsics request, even when the block header reported more calls.                                                | A high-activity block could present a polished ledger that was silently incomplete—the most damaging failure mode for a technical explorer.                                                                  | The block ledger now uses offset paging, exposes the exact loaded/total count, retains already-loaded rows on continuation failure, and offers every page above the API ceiling. A known zero still avoids the request entirely.                                                                                                                      |
| Extrinsic detail asked the lakehouse for a 50-row decoded-event page even though most calls emit only a handful of events.                                | Cold forensic reads scanned farther before proving a short page complete, leaving the primary result ledger skeletal for several seconds.                                                                    | The first page is bounded to ten decoded events and keeps the existing cursor continuation, improving the common call-detail path without truncating event-heavy extrinsics.                                                                                                                                                                          |
| The API catalog fetched its first 200 directory rows before the interface-coverage reading was reached.                                                   | On a narrow initial view, the coverage rail is the page's first answer; catalog rows, filters, and expansion data are lower in the document and need not compete with it.                                    | Keep the coverage reading eager. The catalog retains its stable anchor and URL-backed filters, but begins the surface feed only as its visual region approaches; refresh does not wake that unopened feed.                                                                                                                                            |
| A provider detail route downloaded its entire provider-scoped surface table solely to populate a hero count.                                              | On providers with many registered surfaces, the cold route made a below-fold evidence table compete with the identity and last-probe latency reading.                                                        | The hero now uses the published provider surface count. The table keeps its stable anchor, explicit deferred/loading/error/retry states, and starts only as its section approaches; refresh does not wake it before then.                                                                                                                             |
| Health downloaded every trend window before the reader reached its uptime analysis.                                                                       | The initial operational question is the current incident and self-status record; a later all-window trend payload competed with those first-screen reads on every viewport.                                  | The uptime rail, full subnet ledger, and trend chart keep their shared query, anchors, range control, structured loading/error states, and retry, but begin only when the uptime section enters view.                                                                                                                                                 |
| Validator profiles requested the nominator ledger, time history, and global peer ranking before the membership reading was reached.                       | A cold profile made three later evidence feeds contend with its identity, membership snapshot, and subnet-name mapping, despite each feed having a distinct below-fold section.                              | Each secondary validator section keeps its stable anchor, range control where applicable, deferred state, structured skeleton, scoped error, and retry; its read begins only when that section enters view.                                                                                                                                           |
| Validator profiles hydrated complete subnet-directory rows merely to label the first membership ledger.                                                   | Fields such as taxonomy, repository, social links, coverage, and lifecycle state added transfer and parsing work without being visible on the profile's opening reading.                                     | The first membership ledger now requests only `netuid,name`, retains the same deterministic fallback label, and leaves the complete directory to the route that actually renders it.                                                                                                                                                                  |
| Extrinsic detail queried related calls before the reader reached that separate forensic question.                                                         | The call arguments and decoded result are the initial evidence; a signer or call-hash cross-search below them should not compete with that first reading.                                                    | Arguments and decoded results remain immediate. The related-call region keeps its stable place, explicit deferred state, structured table/skeleton, scoped error, and retry, while its lookup starts only as the region approaches.                                                                                                                   |
| The account directory exposed a Concentration local-nav target that had been deliberately folded into the holder cards.                                   | A reader could activate a dead in-page link, while the independent signing ledger still loaded before the holder-ranking task was complete.                                                                  | The stale anchor is removed. Holders remain immediate; the Active ledger retains its stable anchor, explicit deferred/loading/error/retry states, and begins only as that section approaches.                                                                                                                                                         |
| Validator permit costs loaded a 130-row comparison alongside the opening operator directory.                                                              | Permit economics is a distinct lower reading, so its payload competed with a search-and-compare task even when it was never inspected.                                                                       | The Cost to validate section retains its anchor, structured rail skeleton, scoped error, retry, and full comparison; the read begins only when the section approaches.                                                                                                                                                                                |
| Subnet movers and lifecycle history loaded with the initial crawlable directory.                                                                          | The directory already needs its own economics, taxonomy, health, and interface overlays; two later analytics feeds added work before the first matching subnet row.                                          | Rankings and Churn retain their controls, anchors, structured charts/legends, scoped errors, and retries. Their movers and lifecycle reads start only as those distinct evidence regions approach.                                                                                                                                                    |
| The chain overview started every analytic source together, before the reader had reached the associated evidence.                                         | Five separate history/ledger groups competed with the current activity and head state even when a reader only needed the first network scan.                                                                 | The opening hero and throughput remain immediate. Fees, stake flow, concentration, emission, and governance retain their anchors, controls, structured loading/error/retry states, and begin only as their respective analysis enters view. Governance now renders a retryable failure rather than an empty history when every source is unavailable. |
| Social preview cards still synthesized a patterned backdrop with CSS gradients after the visible product had moved to flat paper, rules, and data colour. | A shared preview could reintroduce the atmospheric treatment the redesign intentionally removed from the product surface.                                                                                    | Preview cards now use the same flat paper ground, hairline-separated bands, ink footer, and semantic data colour as the site; a source test rejects generated gradients in their markup.                                                                                                                                                              |
| The GraphQL explorer uses a costly, visually separate editor that has no intended product audience.                                                       | Maintaining a rarely used tool consumes route weight and visual review effort without advancing an explorer or MCP workflow.                                                                                 | Track removal separately in [#11726](https://github.com/JSONbored/metagraphed/issues/11726). Do not paper over its presentation while its dependency/API inventory is still incomplete.                                                                                                                                                               |

## Source-completion status

The P0/P1/P2 source work in this audit is complete: every canonical route archetype has been
reviewed in the shared design system; directories and entities preserve a first useful answer;
lower-priority evidence has explicit deferred, loading, empty, unavailable, and retry behavior;
and the deterministic route matrix covers compact controls, deep links, overflow, and chart
interaction. The route map deliberately keeps source facts separate from the verification that only
an actual deployment or data owner can provide.

### Remaining outside this source slice

1. **Post-deployment performance:** repeat the 33-route synthetic sweep after this source ships,
   then collect cold and warm route waterfalls, field LCP/INP/CLS, long tasks, transfer, and request
   count at 375px and desktop. The current controlled comparison is a baseline, not evidence about
   the future deployed build or mobile-radio conditions.
2. **Freshness policy:** source owners must define cadence and grace periods before any page can
   call a reading stale. Until then, the UI correctly reports source and relative age without
   inferring a health verdict.
3. **Data availability:** a historical per-block activity heatmap and an evidence-backed revenue
   estimate need bounded server responses with period, method, coverage, provenance, and freshness.
   The current UI intentionally does not manufacture either from aggregate data.
4. **Maintenance-only interface retirement:** the standalone GraphQL surface remains separately
   tracked for removal. It is not expanded or restyled as part of this explorer/MCP pass.

## Performance workstream

Performance is part of the product contract, not a polish pass after visual work.

1. Keep explorer data SSR/crawlable without per-row network requests. The subnet directory's
   price change is already sourced from its economics snapshot rather than one history request per
   visible subnet; preserve that rule for new displays.
2. Defer expensive optional evidence until it is near view. Revenue coverage is deliberately
   lazy because the full coverage response is substantial and not needed to answer the top of a
   subnet detail page.
3. Maintain route boundaries: the local build shows heavy route-specific tooling such as GraphQL
   and documentation chunks. They must remain isolated from a cold explorer/homepage visit. Do
   not claim an initial-load win until a cold-route asset waterfall verifies it.
4. Measure real route transfer, LCP, INP, CLS, long tasks, and request count after a deployment.
   Compare 375px and desktop separately; a desktop bundle result is not phone performance proof.
5. Treat charts, avatar/icon fallbacks, tooltips, and large tables as performance surfaces. Avoid
   eager off-screen charts, repeated image probes, all-row client computation, and animations that
   are required to understand state.
6. Subnet-detail secondary evidence now has an explicit cold-read boundary: the local worker's
   `/subnets/1` first screen starts five client API reads (momentum, value flow, hero uptime, and
   delegate context), down from twelve before the deferred section pass. This is a local request
   count, not a deployed latency or transfer claim; remeasure it with real cache and mobile-network
   conditions after deployment.
7. Account-detail secondary evidence follows the same local cold-read boundary: retain the hero,
   holdings, flow, and display-name reads; begin counterparties, events, and delegation
   relationships only as their sections approach. A 375px local Worker read fell from nine client
   API requests to five. This is a local request shape, not a deployed latency or transfer claim;
   remeasure it with real cache and mobile-network conditions after deployment.
8. The API catalog keeps its interface-coverage summary as the initial reading and starts the
   first 200-row catalog page only when its section approaches. A 375px local Worker initial read
   now asks only for coverage; entering the catalog adds the surface request. This is a local
   request shape, not a deployed Core Web Vitals claim; remeasure it separately after deployment.
9. The endpoint directory now projects only the row fields it renders rather than accepting the
   complete endpoint record and discarding fields after download. A read-only public 200-row sample
   measured 247,019 bytes without the projection and 82,565 bytes with it. Confirm the deployed
   browser waterfall separately; this payload comparison is not a Core Web Vitals measurement.
10. Provider detail now retains its published surface count in the initial identity read and starts its
    provider-scoped surface table only when the table approaches the viewport. Confirm the deployed
    route waterfall separately; this is a local request-shape boundary, not a Core Web Vitals claim.
11. Health now starts its bulk multi-window uptime payload only when the uptime section enters view;
    current incidents and self-status remain eager because their facts are visible in the opening health
    reading. Confirm the deployed route waterfall separately; this is a local request-shape boundary,
    not a Core Web Vitals claim.
12. Validator detail now retains its identity, membership snapshot, and subnet-name mapping in the
    first read, while beginning its nominator ledger, history series, and global peer ranking only as
    their sections enter view. Confirm the deployed route waterfall separately; this is a local
    request-shape boundary, not a Core Web Vitals claim.
13. Extrinsic detail now keeps its call arguments and decoded result in the initial reading, while
    starting the cross-extrinsic related-call lookup only as its table enters view. Confirm the
    deployed route waterfall separately; this is a local request-shape boundary, not a Core Web
    Vitals claim.
14. The account directory now renders its server-provided holder ranking without a client API
    request in a fresh local 375px view. Entering the Active section adds the single 7-day signer
    ledger request. This is a local request-shape boundary, not a deployed Core Web Vitals claim.
15. The validator directory now begins its 130-row permit-cost comparison only at the Cost to
    validate section. Confirm the deployed route waterfall separately; this is a local request-shape
    boundary, not a Core Web Vitals claim.
16. The subnet directory retains the economics, domain, health, and interface overlays that its
    initial searchable table requires, while starting the 100-row movers slice and 500-row lifecycle
    history only at Rankings and Churn respectively. Confirm the deployed route waterfall separately;
    this is a local request-shape boundary, not a Core Web Vitals claim.
17. The chain overview's fresh local 375px view now starts the head summary and initial call mix;
    it does not start fee history, stake flow, concentration, emission, runtime history, sudo, or
    config-change reads until their analyses enter view. This is a local request-shape boundary, not
    a deployed Core Web Vitals claim.
18. Validator detail's opening membership ledger now projects its all-subnet name lookup to
    `netuid,name`. A read-only public 129-row sample measured 266,172 bytes for the complete
    directory and 4,919 bytes for the projection (about 98.2% less transferred data). This verifies
    the API response shape at one moment; confirm the deployed browser waterfall separately before
    making a Core Web Vitals claim.
19. Account detail no longer waits for its general history summary before returning the route
    shell. In the same live-API local environment, representative route TTFB fell from about 6.5s
    to 55ms while the independent positions, balance, flow, identity, and summary lanes continued
    to resolve into truthful pending or unavailable states. This removes a server-rendering
    dependency; it does not claim that the underlying multi-second summary query itself became
    faster.
20. Block detail now prefetches and consumes one shared infinite-query cache entry, pages at the API
    ceiling without requesting an invalid `limit=101`, and preserves the exact loaded/known-total
    relationship. A live 162-extrinsic block was recovered in two bounded pages rather than silently
    truncating after the first 100 rows.
21. The subnet directory no longer probes arbitrary remote website/repository URLs through the icon
    proxy. Only curated icon evidence is rendered, eliminating the measured 404 fan-out while
    retaining deterministic monogram fallbacks.
22. The browser analytics client now explicitly disables surveys, product tours, and conversations,
    which have no application surface. Before this source change, a fresh production 375px homepage
    read requested `surveys.js` despite all three project surveys being archived: 36,563 compressed
    bytes and 102,609 decoded bytes. Replay, exception capture, Web Vitals, dead-click telemetry, and
    feature flags remain enabled. Confirm the missing survey request after deployment; the current
    numbers are the live baseline, not post-change production proof.

## Completion proof

A redesign slice is ready only when all of the following are true:

- Source tests, type checks, formatter, production worker build, and deterministic responsive
  checks pass.
- Each affected canonical route has fixed-viewport screenshots at 375×812, 768×1024, and
  1280×800 in both light and dark themes; the screenshots are reviewed for hierarchy, gutters,
  clipping, real data, loading/empty/error states, and focus/tap behavior.
- No page-level horizontal overflow, clipped focus ring, duplicated primary claim, fake data,
  or silent loss of decision-critical information remains.
- The change has a cold-route performance measurement and an explicit statement of what was
  measured locally versus what is verified after deployment.
