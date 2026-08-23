/**
 * The active-entity specimen.
 *
 * One section but four components, because the thing demonstrated is not a
 * component — it is the shared flag that lets a bar, a row and a definition
 * light each other across a page (#11606). The demo bars and rows exist so a
 * reader can see that happen, and `active-entity.spec.ts`, `charts.spec.ts`
 * and `rank.spec.ts` drive them as the store's only integration test.
 */
import { useState, type CSSProperties } from "react";
import {
  ActiveEntityProvider,
  AnalyticsSection,
  ChartTooltip,
  Definition,
  markAriaLabel,
  useEntityMark,
  useIsActive,
} from "@jsonbored/ui-kit";
import { PropsTable } from "@/components/metagraphed/design/props-table";
import { INTERACTION_PROPS } from "@/components/metagraphed/design/primitive-props";

const DEMO_KEYS = Array.from({ length: 12 }, (_, i) => `m-${i + 1}`);
const DEMO_VALUES = [42, 58, 35, 71, 64, 29, 80, 53, 47, 66, 38, 75];

export function InteractionSection() {
  return (
    <AnalyticsSection
      id="interaction"
      name="ActiveEntity · ChartTooltip · Definition"
      question="One active entity per page: hover, focus or tap any mark and every element carrying that key lights up."
      visual={
        <div className="space-y-6">
          <EntityDemo />
          <div className="flex flex-wrap items-center gap-6" data-testid="definition-demo">
            <span className="inline-flex items-center gap-1.5 text-13">
              Emission share <Definition term="Emission share" />
            </span>
            <Definition term="Validator take">
              <span className="mg-fact-chip">take 18%</span>
            </Definition>
          </div>
        </div>
      }
      legend={<PropsTable rows={INTERACTION_PROPS} caption="Interaction props" />}
      footnote="192px tooltip, 11px rows at 16px, the one shadow · 16×16 definition button, 192px tip at 11px · roving tabindex: one Tab stop per [data-marks] group, arrows inside it, Escape clears"
    />
  );
}

function EntityDemo() {
  const [activated, setActivated] = useState<string>("");
  return (
    // Its own store: the twelve demo marks are a closed group, and the e2e
    // asserts that hovering one lights exactly two elements page-wide.
    <ActiveEntityProvider>
      <div data-testid="entity-demo" className="space-y-3">
        <button type="button" data-testid="entity-demo-before" className="text-11 text-ink-muted">
          before the group
        </button>
        <div className="relative" data-marks>
          <ChartTooltip top={8} />
          <div className="flex h-32 items-end gap-1">
            {DEMO_KEYS.map((key, i) => (
              <DemoBar key={key} index={i} onActivate={setActivated} />
            ))}
          </div>
        </div>
        <ul className="divide-y divide-rule border-y border-rule text-13">
          {DEMO_KEYS.map((key, i) => (
            <DemoRow key={key} index={i} />
          ))}
        </ul>
        <p className="text-11 text-ink-muted">
          activated: <span data-testid="entity-demo-activated">{activated}</span>
        </p>
      </div>
    </ActiveEntityProvider>
  );
}

function DemoBar({ index, onActivate }: { index: number; onActivate: (key: string) => void }) {
  const key = DEMO_KEYS[index]!;
  const value = DEMO_VALUES[index]!;
  const mark = useEntityMark(key, {
    source: "demo-bars",
    label: markAriaLabel(`Mark ${index + 1}`, `${value}%`),
    onActivate: () => onActivate(key),
    data: {
      title: `Mark ${index + 1}`,
      total: `${value}%`,
      rows: DEMO_KEYS.slice(Math.max(0, index - 1), index + 2).map((k) => ({
        key: k,
        label: `Mark ${Number(k.slice(2))}`,
        value: `${DEMO_VALUES[Number(k.slice(2)) - 1]}%`,
        swatch: `var(--chart-${((Number(k.slice(2)) - 1) % 11) + 1})`,
      })),
    },
  });
  return (
    <button
      type="button"
      {...mark}
      className="mg-demo-bar"
      style={
        { "--fill": `${value}%`, "--swatch": `var(--chart-${(index % 11) + 1})` } as CSSProperties
      }
    />
  );
}

function DemoRow({ index }: { index: number }) {
  const active = useIsActive(DEMO_KEYS[index]!);
  return (
    <li
      data-entity={DEMO_KEYS[index]}
      data-active={active ? "true" : undefined}
      className="flex items-center justify-between px-2 py-1"
    >
      <span className="flex items-center gap-2">
        <span
          className="mg-chart-tooltip-swatch"
          style={{ "--swatch": `var(--chart-${(index % 11) + 1})` } as CSSProperties}
          aria-hidden
        />
        Mark {index + 1}
      </span>
      <span className="tabular-nums">{DEMO_VALUES[index]}%</span>
    </li>
  );
}

/* -------------------------------------------------------------------- table */
