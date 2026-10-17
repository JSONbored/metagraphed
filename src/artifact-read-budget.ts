import { RetainedHistoryUnavailableError } from "./retained-history-store.ts";

/** A whole artifact read exceeded its shared deadline or was already closed. */
export class ArtifactReadTimeoutError extends RetainedHistoryUnavailableError {
  constructor() {
    super();
    this.name = "ArtifactReadTimeoutError";
    this.message =
      "Artifact storage read exceeded its configured time budget. Please retry.";
  }
}

/** One deadline spans selection, object reads, streaming and decoding. */
export class ArtifactReadBudget {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly error = new ArtifactReadTimeoutError();
  readonly signal = this.controller.signal;

  constructor(timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs;
    this.timer = setTimeout(() => this.close(), timeoutMs);
  }

  check(): void {
    if (this.signal.aborted || Date.now() >= this.deadline) {
      this.close();
      throw this.error;
    }
  }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    this.check();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(this.error);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return operation();
        }),
        stopped,
      ]);
      this.check();
      return result;
    } catch (error) {
      this.check();
      throw error;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.controller.abort(this.error);
  }
}
