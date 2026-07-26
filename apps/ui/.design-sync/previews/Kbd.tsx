import { Kbd } from "@jsonbored/ui-kit";

export function Combo() {
  return (
    <div className="flex items-center gap-1.5">
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </div>
  );
}

export function Single() {
  return <Kbd>Esc</Kbd>;
}
