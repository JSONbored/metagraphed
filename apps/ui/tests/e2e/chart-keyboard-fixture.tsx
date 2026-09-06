import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ActiveEntityProvider,
  ChartTooltip,
  DataTable,
  LeaderCards,
  MarkerRail,
  RankGrid,
  RankedRails,
  useEntityMark,
} from "@jsonbored/ui-kit";

// Browser-only fixture: the spec intercepts its document and script requests.
// Real components exercise native browser activation without a product route.
const items = [1, 2, 3].map((n) => ({
  key: `item-${n}`,
  label: `Record ${n}`,
  name: `Record ${n}`,
  value: n * 10,
  href: `/__test/chart-destination?record=${n}`,
}));

export function Control({
  id,
  href,
  disabled,
  onActivate,
}: {
  id: string;
  href?: string;
  disabled?: boolean;
  onActivate?: () => void;
}) {
  const { role, ...mark } = useEntityMark(id, {
    disabled,
    onActivate,
    data: { title: id, total: "10 records" },
  });
  return href ? (
    <a {...mark} href={href}>
      {id}
    </a>
  ) : (
    <button {...mark} role={role} type="button">
      {id}
    </button>
  );
}

export function Fixture() {
  const [activated, setActivated] = useState(0);
  const activate = () => setActivated((previous) => previous + 1);
  return (
    <ActiveEntityProvider>
      <main>
        <div data-testid="rails">
          <RankedRails items={items} formatValue={String} ariaLabel="Linked rails" />
        </div>
        <div data-testid="markers">
          <MarkerRail
            items={items}
            formatValue={String}
            columns={{ ratio: "Value", name: "Record", scale: "0–100" }}
            ariaLabel="Linked markers"
          />
        </div>
        <div data-testid="ranks">
          <RankGrid
            items={items.map((item) => ({ ...item, value: String(item.value) }))}
            ariaLabel="Linked ranks"
          />
        </div>
        <div data-testid="leaders">
          <LeaderCards
            items={items.map((item) => ({ ...item, value: String(item.value) }))}
            ariaLabel="Linked leaders"
          />
        </div>
        <button type="button" data-testid="before-controls">
          Before controls
        </button>
        <div data-testid="controls" data-marks style={{ position: "relative" }}>
          <ChartTooltip top={0} />
          <Control id="disabled-link" href={items[0]!.href} disabled />
          <Control id="first-link" href={items[0]!.href} />
          <i data-entity="decoration" aria-hidden="true" />
          <button type="button" data-entity="native-disabled" disabled>
            Unavailable action
          </button>
          <Control id="disabled-button" onActivate={activate} disabled />
          <Control id="action-button" onActivate={activate} />
          <div data-testid="nested-controls" data-marks>
            <Control id="nested-link" href={items[0]!.href} />
            <Control id="nested-button" onActivate={activate} />
          </div>
          <Control id="last-link" href={items[2]!.href} />
        </div>
        <p data-testid="activated">{activated}</p>
        <div data-testid="table">
          <DataTable
            rows={items}
            rowKey={(row) => row.key}
            caption="Linked table"
            columns={[
              { key: "name", label: "Record", value: (row) => row.label },
              {
                key: "link",
                label: "Details",
                kind: "link",
                href: (row) => row.href,
                value: () => "Open details",
              },
              {
                key: "input",
                label: "Note",
                render: (row) => <input aria-label={`Note for ${row.label}`} />,
              },
            ]}
            rowHref={(row) => row.href}
            expand={(row) => <p>Expanded {row.label}</p>}
          />
        </div>
      </main>
    </ActiveEntityProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
