import { expect, test, vi } from "vitest";
import { TransactionSubscriptions } from "./transaction-subscriptions";

test("a late subscription handle is closed after reset or unmount and cannot replace the new receipt", async () => {
  const scope = new TransactionSubscriptions();
  const first = scope.begin();
  let resolve!: (handle: () => void) => void;
  const pending = new Promise<() => void>((done) => {
    resolve = done;
  });
  const retained = pending.then((handle) => scope.retain(first, handle));
  scope.clear();
  const second = scope.begin(),
    oldClose = vi.fn(),
    newClose = vi.fn();
  scope.retain(second, newClose);
  resolve(oldClose);
  await retained;
  expect(oldClose).toHaveBeenCalledOnce();
  expect(newClose).not.toHaveBeenCalled();
  expect(scope.current(first)).toBe(false);
  expect(scope.current(second)).toBe(true);
  scope.clear();
  scope.clear();
  expect(newClose).toHaveBeenCalledOnce();
  expect(scope.current(second)).toBe(false);
});
test("starting another transaction releases its predecessor", () => {
  const scope = new TransactionSubscriptions(),
    close = vi.fn();
  const first = scope.begin();
  scope.retain(first, close);
  const next = scope.begin();
  expect(close).toHaveBeenCalledOnce();
  expect(scope.current(first)).toBe(false);
  expect(scope.current(next)).toBe(true);
});
