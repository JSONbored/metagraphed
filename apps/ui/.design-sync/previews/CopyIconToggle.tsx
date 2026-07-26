import { CopyIconToggle } from "@jsonbored/ui-kit";

export function Idle() {
  return <CopyIconToggle copied={false} />;
}

export function Copied() {
  return <CopyIconToggle copied={true} />;
}
