import { ListCard } from "metagraphed-ui";

export function Default() {
  return (
    <ListCard to="#">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ink-strong">Subnet 64 — Chutes</span>
        <span className="text-xs text-ink-muted">98.2% uptime</span>
      </div>
    </ListCard>
  );
}

export function AsButton() {
  return (
    <ListCard onClick={() => {}}>
      <span className="text-ink">Tap to expand row</span>
    </ListCard>
  );
}
