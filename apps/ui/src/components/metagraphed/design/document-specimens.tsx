/**
 * The document layer's specimens: the page shape, the hero, the fact strip,
 * the liveness stamp, the range switch and the raw disclosure.
 *
 * Split out of `-design-primitives-page.tsx` by #11678 — the routes README
 * caps a page module at 600 lines and that page had reached 939, which buried
 * its actual shape (a hero, a nav, fifteen sections, a source list) under its
 * own contents. The grouping is the epic's: #11606–#11607 built these six
 * together, and they are what a page is ASSEMBLED from rather than what it
 * displays data with.
 */
import { useState } from "react";
import {
  AnalyticsSection,
  COMPOSITION_SPECIMEN,
  EntityHero,
  Fact,
  FactSentence,
  FactStrip,
  LiveMeta,
  RangeControl,
  RankGrid,
  Raw,
  RawCode,
} from "@jsonbored/ui-kit";
import { RouterLink } from "@/components/metagraphed/router-link";
import { PropsTable } from "@/components/metagraphed/design/props-table";
import {
  DOCUMENT_PROPS,
  FACT_PROPS,
  HERO_PROPS,
  LIVE_META_PROPS,
  RANGE_PROPS,
  RAW_PROPS,
} from "@/components/metagraphed/design/primitive-props";
import { SAMPLE_UPDATED_AT } from "./specimen-data";

export function DocumentSection() {
  return (
    <AnalyticsSection
      id="document"
      name="AnalyticsPage · AnalyticsSection"
      question="The document layer: a route is a hero and at most seven sections, each answering one question."
      visual={
        <div className="rounded border border-rule">
          <AnalyticsSection
            id="document-specimen"
            name="Emission"
            question="Which subnets the chain pays, per block."
            controls={<RangeDemo />}
            visual={
              <RankGrid
                items={COMPOSITION_SPECIMEN.map((segment, index) => ({
                  key: `doc-${segment.key}`,
                  label: segment.label,
                  value: `${segment.value}%`,
                  swatch: `var(--chart-${index + 1})`,
                }))}
                cols={3}
                ariaLabel="Emission split (section specimen)"
                source="document-specimen"
              />
            }
            footnote="7d · chain"
          />
        </div>
      }
      legend={<PropsTable rows={DOCUMENT_PROPS} caption="Document layer props" />}
      footnote="28px heading, 600 on the subject · 40px under it · 80/40px section padding, 64/32 at 1184, 48/24 at 640 · 1px rule between sections · 11px sticky nav"
    />
  );
}

/* -------------------------------------------------------------- entity hero */

export function HeroSection() {
  return (
    <AnalyticsSection
      id="entity-hero"
      name="EntityHero"
      question="The masthead every entity route opens with: crumbs, name, one action, the sentence, the strip."
      visual={
        <div className="rounded border border-rule">
          <EntityHero
            crumbs={[{ label: "Subnets", href: "/subnets" }, { label: "SN19" }]}
            name="Nineteen"
            action={
              <RouterLink href="/subnets/19" className="mg-hero-action">
                Open subnet
              </RouterLink>
            }
            sentence={
              <FactSentence>
                Ranked <Fact>#04</Fact> by emission with <Fact>4.3%</Fact> of daily emission ·{" "}
                <Fact>247/256</Fact> UIDs · <Fact>OK</Fact> for <Fact>75d</Fact>
              </FactSentence>
            }
            cells={[
              { label: "Emission", value: "4.3%", delta: { text: "+0.2", tone: "good" } },
              { label: "Alpha price", value: "0.0722 τ", delta: { text: "−1.4%", tone: "bad" } },
              { label: "Total stake", value: "3.58M τ" },
              { label: "UIDs", value: "247/256" },
            ]}
          />
        </div>
      }
      legend={<PropsTable rows={HERO_PROPS} caption="EntityHero props" />}
      // No `live` on the specimen: LiveMeta throws on a second mount, and the
      // page's one liveness line belongs to the section that documents it.
      footnote="10px crumb chips · 40px name, 500 · 40px avatar · 32px action · 16px sentence · 4px radius · the hero renders LiveMeta, so a page has exactly one"
    />
  );
}

/* -------------------------------------------------------------------- facts */

export function FactsSection() {
  return (
    <AnalyticsSection
      id="facts"
      name="FactSentence · Fact · FactStrip"
      question="The two ways an entity states its numbers: one sentence of chips, then a row of bordered cells."
      visual={
        <div className="space-y-6">
          <FactSentence>
            <Fact>129</Fact> subnets · <Fact>284</Fact> verified surfaces · <Fact>OK</Fact> for{" "}
            <Fact>75d</Fact> · <Fact>application</Fact>
          </FactSentence>
          <FactStrip
            cells={[
              { label: "Emission", value: "4.3%", delta: { text: "+0.2", tone: "good" } },
              { label: "Alpha price", value: "0.0722 τ", delta: { text: "−1.4%", tone: "bad" } },
              { label: "Total stake", value: "3.58M τ" },
              { label: "UIDs", value: "247/256" },
            ]}
          />
          <FactStrip
            variant="grid"
            cells={[
              { label: "Registered", value: "247" },
              { label: "Serving", value: "231" },
              { label: "Validators", value: "16" },
              { label: "Immunity", value: "5,000" },
              { label: "Tempo", value: "360" },
              { label: "Burn", value: "1.42 τ" },
            ]}
          />
        </div>
      }
      legend={<PropsTable rows={FACT_PROPS} caption="Fact props" />}
      footnote="16px sentence · 11px chips on --layer, 18px line · 11px cell labels · 28px values, 500, tabular · 10px delta chip · shared cell edges, 4px radius on the outer box only"
    />
  );
}

/* ---------------------------------------------------------------- liveness */

export function LiveMetaSection() {
  return (
    <AnalyticsSection
      id="live-meta"
      name="LiveMeta"
      question="The page's one liveness line — how old the data is, where it came from, and how to ask again."
      visual={
        // The page's ONLY LiveMeta. A second mount throws in development, by
        // design: a route cannot grow a second clock.
        <LiveMeta updatedAt={SAMPLE_UPDATED_AT} source="chain" onRefresh={() => {}} />
      }
      legend={<PropsTable rows={LIVE_META_PROPS} caption="LiveMeta props" />}
      footnote="11px muted · `Updated 9s ago · source · refresh` · one per page, enforced at runtime in development"
    />
  );
}

/* ------------------------------------------------------------ range control */

export function RangeSection() {
  return (
    <AnalyticsSection
      id="range-control"
      name="RangeControl"
      question="The one segmented control: a window, a unit, a mode — never a dropdown, never a tab bar."
      visual={
        <div className="flex flex-wrap items-start gap-6">
          <RangeDemo />
          <UnitDemo />
        </div>
      }
      legend={<PropsTable rows={RANGE_PROPS} caption="RangeControl props" />}
      footnote="28px track on --layer, 2px padding, 2px gap · 11px options · active option on --raised · 4px radius · role=radiogroup, arrow keys, one Tab stop"
    />
  );
}

function RangeDemo() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("7d");
  return (
    <RangeControl
      label="Window"
      options={[
        { value: "7d", label: "7d" },
        { value: "30d", label: "30d" },
        { value: "90d", label: "90d" },
      ]}
      value={range}
      onChange={setRange}
    />
  );
}

function UnitDemo() {
  const [unit, setUnit] = useState<"tao" | "alpha" | "usd">("tao");
  return (
    <RangeControl
      label="Value unit"
      options={[
        { value: "tao", label: "TAO" },
        { value: "alpha", label: "α" },
        { value: "usd", label: "USD" },
      ]}
      value={unit}
      onChange={setUnit}
    />
  );
}

/* ---------------------------------------------------------------------- raw */

export function RawSection() {
  return (
    <AnalyticsSection
      id="raw"
      name="Raw · RawRow · RawCode"
      question="The disclosure that is the only place a full hotkey, an API URL or a curl line may live outside a table cell."
      visual={
        <Raw
          defaultOpen
          rows={[
            { label: "Coldkey", value: "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9" },
            {
              label: "OpenAPI",
              value: "https://api.metagraph.sh/openapi.json",
              href: "https://api.metagraph.sh/openapi.json",
            },
          ]}
        >
          <RawCode label="curl">{"curl https://api.metagraph.sh/api/v1/subnets/19"}</RawCode>
        </Raw>
      }
      legend={<PropsTable rows={RAW_PROPS} caption="Raw props" />}
      footnote="13px summary with a 6px disclosure square · 10px RAW chip · 13px rows, wrapping, never truncated · 11px code block · mounted last on a page"
    />
  );
}

/* -------------------------------------------------------------- interaction */
