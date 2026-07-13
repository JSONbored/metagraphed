import { CopyIconToggle } from "metagraphed-ui";

export function Idle() {
  return <CopyIconToggle copied={false} />;
}

export function Copied() {
  return <CopyIconToggle copied={true} />;
}
