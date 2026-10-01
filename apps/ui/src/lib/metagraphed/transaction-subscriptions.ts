/** Owns receipt subscriptions across resets and unmounts, including an
 * unsubscribe handle that arrives after its transaction was dismissed. */
export class TransactionSubscriptions {
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  begin() {
    this.clear();
    return this.generation;
  }
  current(generation: number) {
    return generation === this.generation;
  }
  retain(generation: number, unsubscribe: () => void) {
    if (this.current(generation)) this.unsubscribe = unsubscribe;
    else unsubscribe();
  }
  clear() {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
